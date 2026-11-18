/**
 * Organizations (teams): creation, settings/branding, membership, invitations, roles, ownership,
 * and the team availability view. Every function takes the acting user id and authorizes server-side
 * with `requireOrgRole` / `requireOrgPermission`.
 *
 * Namespace: an organization slug shares one namespace with usernames (both live at /{name});
 * see `isHandleTaken` in ./username.ts. Creation/rename serialises on an advisory lock per handle.
 */
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";
import { sha256, randomToken } from "@/lib/crypto";
import { validateUsername } from "@/lib/username";
import { authEmailTemplate } from "@/lib/auth-email";
import { APP_NAME } from "@/lib/brand";
import { getEmailProvider } from "@/server/notifications/provider";
import { expandAvailability, subtractIntervals, type Interval } from "@/server/scheduling/availability";
import { isHandleTaken } from "./username";

const { organizations, organizationMembers, invitations, users, eventHosts, eventTypes, auditLogs } = schema;

export type OrgRole = "owner" | "admin" | "member";
const RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };

/** Fine-grained permissions that can be granted to plain members. Admins and owners implicitly have all. */
export const ORG_PERMISSIONS = [
  { key: "members.invite", label: "Invite members" },
  { key: "bookings.view_all", label: "View all team bookings" },
  { key: "branding.manage", label: "Edit organization branding" },
  { key: "event_types.manage", label: "Manage team event types" },
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number]["key"];
const PERMISSION_KEYS = new Set<string>(ORG_PERMISSIONS.map((p) => p.key));

export const INVITE_TTL_DAYS = 7;
const HEX = /^#[0-9a-fA-F]{6}$/;

export type Membership = { role: OrgRole; permissions: string[] };

// ───────── authorization
export async function getMembership(userId: string, orgId: string, db: Db = defaultDb): Promise<Membership | null> {
  if (!isUuid(orgId)) return null;
  const [m] = await db.select({ role: organizationMembers.role, permissions: organizationMembers.permissions })
    .from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, orgId), isNull(organizations.deletedAt))).limit(1);
  return m ?? null;
}

/** Throws FORBIDDEN unless the user is a member with at least role `min`. Returns the membership. */
export async function requireOrgRole(userId: string, orgId: string, min: OrgRole, db: Db = defaultDb): Promise<Membership> {
  const m = await getMembership(userId, orgId, db);
  if (!m) throw new AppError("FORBIDDEN", "You are not a member of this organization", 403);
  if (RANK[m.role] < RANK[min]) throw new AppError("FORBIDDEN", `You need ${min} rights in this organization`, 403);
  return m;
}

/** Admin/owner always pass; members need the explicit permission. */
export async function requireOrgPermission(userId: string, orgId: string, perm: OrgPermission, db: Db = defaultDb): Promise<Membership> {
  const m = await requireOrgRole(userId, orgId, "member", db);
  if (RANK[m.role] >= RANK.admin || m.permissions.includes(perm)) return m;
  throw new AppError("FORBIDDEN", "You do not have permission to do that in this organization", 403);
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const audit = (db: Pick<Db, "insert">, actorId: string, orgId: string, action: string, entityId?: string, meta?: Record<string, unknown>) =>
  db.insert(auditLogs).values({ actorId, organizationId: orgId, action, entity: "organization", entityId: entityId ?? orgId, meta: meta ?? null });

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === "object" && (cur as { code?: string }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// ───────── validation
export type OrgInput = { name: string; slug?: string; logoUrl?: string | null; brandColor?: string | null };

function cleanName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (n.length < 2 || n.length > 80) throw new AppError("VALIDATION", "Organization name must be 2-80 characters", 422, [{ path: "name", message: "Must be 2-80 characters" }]);
  return n;
}
function cleanBrand(c: unknown): string | null {
  if (c == null || c === "") return null;
  if (typeof c !== "string" || !HEX.test(c)) throw new AppError("VALIDATION", "Brand color must be a hex value like #4f46e5", 422, [{ path: "brandColor", message: "Use #RRGGBB" }]);
  return c.toLowerCase();
}
function cleanLogo(u: unknown): string | null {
  if (u == null || u === "") return null;
  if (typeof u !== "string" || u.length > 500) throw new AppError("VALIDATION", "Invalid logo URL", 422, [{ path: "logoUrl", message: "Invalid URL" }]);
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  try {
    const x = new URL(u);
    if (x.protocol === "https:" || x.protocol === "http:") return x.toString();
  } catch { /* fallthrough */ }
  throw new AppError("VALIDATION", "Logo must be an http(s) URL", 422, [{ path: "logoUrl", message: "Must be an http(s) URL" }]);
}
export function slugFromName(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
  return s;
}
async function assertHandleFree(tx: Db | Tx, slug: string, exceptOrgId?: string) {
  const v = validateUsername(slug);
  if (!v.ok) throw new AppError("VALIDATION", v.message, 422, [{ path: "slug", message: v.message }]);
  await (tx as Db).execute(sql`select pg_advisory_xact_lock(hashtextextended(${"handle:" + v.username}, 0))`);
  if (await isHandleTaken(v.username, { exceptOrgId }, tx as Db))
    throw new AppError("SLUG_TAKEN", "That URL is already taken by a user or another organization", 409, [{ path: "slug", message: "Already taken" }]);
  return v.username;
}

/** Availability check for the create/rename UI. */
export async function checkOrgSlug(slug: string, exceptOrgId?: string, db: Db = defaultDb): Promise<{ available: boolean; message?: string }> {
  const v = validateUsername(slug);
  if (!v.ok) return { available: false, message: v.message };
  return (await isHandleTaken(v.username, { exceptOrgId }, db)) ? { available: false, message: "Already taken" } : { available: true };
}

// ───────── organizations
export type OrgSummary = { id: string; name: string; slug: string; logoUrl: string | null; brandColor: string | null; role: OrgRole; memberCount: number };

export async function createOrganization(userId: string, input: OrgInput, db: Db = defaultDb) {
  const name = cleanName(input.name);
  const slugRaw = input.slug?.trim() || slugFromName(name);
  const brandColor = cleanBrand(input.brandColor);
  const logoUrl = cleanLogo(input.logoUrl);
  try {
    return await db.transaction(async (tx) => {
      const slug = await assertHandleFree(tx, slugRaw);
      const [org] = await tx.insert(organizations).values({ name, slug, brandColor, logoUrl }).returning();
      await tx.insert(organizationMembers).values({ organizationId: org.id, userId, role: "owner" });
      await audit(tx, userId, org.id, "org.created", org.id, { slug });
      return org;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("SLUG_TAKEN", "That URL is already taken by a user or another organization", 409, [{ path: "slug", message: "Already taken" }]);
    throw e;
  }
}

export async function listMyOrganizations(userId: string, db: Db = defaultDb): Promise<OrgSummary[]> {
  const rows = await db.select({
    id: organizations.id, name: organizations.name, slug: organizations.slug, logoUrl: organizations.logoUrl,
    brandColor: organizations.brandColor, role: organizationMembers.role,
  }).from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt))).orderBy(asc(organizations.name));
  if (!rows.length) return [];
  const counts = await db.select({ orgId: organizationMembers.organizationId, n: sql<number>`count(*)::int` }).from(organizationMembers)
    .where(inArray(organizationMembers.organizationId, rows.map((r) => r.id))).groupBy(organizationMembers.organizationId);
  const m = new Map(counts.map((c) => [c.orgId, c.n]));
  return rows.map((r) => ({ ...r, memberCount: m.get(r.id) ?? 0 }));
}

export async function getOrganization(userId: string, orgId: string, db: Db = defaultDb) {
  const m = await requireOrgRole(userId, orgId, "member", db);
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new AppError("NOT_FOUND", "Organization not found", 404);
  return { ...org, role: m.role, permissions: m.permissions };
}

export async function updateOrganization(userId: string, orgId: string, input: Partial<OrgInput>, db: Db = defaultDb) {
  const m = await requireOrgPermission(userId, orgId, "branding.manage", db);
  const isAdmin = RANK[m.role] >= RANK.admin;
  const patch: Partial<typeof organizations.$inferInsert> = {};
  if (input.name !== undefined) {
    if (!isAdmin) throw new AppError("FORBIDDEN", "Only admins can rename the organization", 403);
    patch.name = cleanName(input.name);
  }
  if (input.logoUrl !== undefined) patch.logoUrl = cleanLogo(input.logoUrl);
  if (input.brandColor !== undefined) patch.brandColor = cleanBrand(input.brandColor);
  try {
    return await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
      if (!cur) throw new AppError("NOT_FOUND", "Organization not found", 404);
      if (input.slug !== undefined && input.slug.trim().toLowerCase() !== cur.slug) {
        if (m.role !== "owner") throw new AppError("FORBIDDEN", "Only an owner can change the organization URL", 403);
        patch.slug = await assertHandleFree(tx, input.slug, orgId);
      }
      if (!Object.keys(patch).length) return cur;
      const [row] = await tx.update(organizations).set({ ...patch, updatedAt: new Date() }).where(eq(organizations.id, orgId)).returning();
      await audit(tx, userId, orgId, "org.updated", orgId, { fields: Object.keys(patch) });
      return row;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("SLUG_TAKEN", "That URL is already taken by a user or another organization", 409, [{ path: "slug", message: "Already taken" }]);
    throw e;
  }
}

// ───────── members
export type MemberRow = { userId: string; name: string; email: string; image: string | null; role: OrgRole; permissions: string[]; joinedAt: Date; timeZone: string };

export async function listMembers(userId: string, orgId: string, db: Db = defaultDb): Promise<MemberRow[]> {
  await requireOrgRole(userId, orgId, "member", db);
  const rows = await db.select({
    userId: users.id, name: users.name, email: users.email, image: users.image, role: organizationMembers.role,
    permissions: organizationMembers.permissions, joinedAt: organizationMembers.createdAt, timeZone: users.timeZone,
  }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, orgId), isNull(users.deletedAt)));
  return rows.sort((a, b) => RANK[b.role] - RANK[a.role] || a.name.localeCompare(b.name));
}

/** Locks owner rows so concurrent demotions/removals/leaves cannot orphan the org. Returns owner ids. */
async function lockOwners(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.select({ userId: organizationMembers.userId }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, "owner"))).for("update");
  return rows.map((r) => r.userId);
}

async function dropHostAssignments(tx: Tx, orgId: string, userId: string) {
  const evs = await tx.select({ id: eventTypes.id }).from(eventTypes).where(eq(eventTypes.organizationId, orgId));
  if (evs.length) await tx.delete(eventHosts).where(and(eq(eventHosts.userId, userId), inArray(eventHosts.eventTypeId, evs.map((e) => e.id))));
}

export async function removeMember(actorId: string, orgId: string, targetUserId: string, db: Db = defaultDb): Promise<void> {
  if (actorId === targetUserId) return leaveOrganization(actorId, orgId, db);
  const actor = await requireOrgRole(actorId, orgId, "admin", db);
  await db.transaction(async (tx) => {
    const owners = await lockOwners(tx, orgId);
    const [t] = await tx.select({ role: organizationMembers.role }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, targetUserId))).limit(1);
    if (!t) throw new AppError("NOT_FOUND", "That person is not a member", 404);
    if (RANK[t.role] >= RANK[actor.role] && actor.role !== "owner") throw new AppError("FORBIDDEN", "You cannot remove someone with equal or higher rights", 403);
    if (t.role === "owner" && owners.length <= 1) throw new AppError("LAST_OWNER", "An organization must keep at least one owner. Transfer ownership first.", 409);
    await tx.delete(organizationMembers).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, targetUserId)));
    await dropHostAssignments(tx, orgId, targetUserId);
    await audit(tx, actorId, orgId, "member.removed", targetUserId);
  });
}

export async function leaveOrganization(userId: string, orgId: string, db: Db = defaultDb): Promise<void> {
  await requireOrgRole(userId, orgId, "member", db);
  await db.transaction(async (tx) => {
    const owners = await lockOwners(tx, orgId);
    if (owners.includes(userId) && owners.length <= 1)
      throw new AppError("LAST_OWNER", "You are the only owner. Transfer ownership to someone else before leaving.", 409);
    await tx.delete(organizationMembers).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)));
    await dropHostAssignments(tx, orgId, userId);
    await audit(tx, userId, orgId, "member.left", userId);
  });
}

/** Owner-only. Admin/member/owner changes alike (an admin cannot promote themselves). */
export async function changeMemberRole(actorId: string, orgId: string, targetUserId: string, role: OrgRole, db: Db = defaultDb): Promise<void> {
  if (!(role in RANK)) throw new AppError("VALIDATION", "Invalid role", 422);
  await requireOrgRole(actorId, orgId, "owner", db);
  await db.transaction(async (tx) => {
    const owners = await lockOwners(tx, orgId);
    const [t] = await tx.select({ role: organizationMembers.role }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, targetUserId))).limit(1);
    if (!t) throw new AppError("NOT_FOUND", "That person is not a member", 404);
    if (t.role === role) return;
    if (t.role === "owner" && owners.length <= 1) throw new AppError("LAST_OWNER", "An organization must keep at least one owner.", 409);
    await tx.update(organizationMembers).set({ role }).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, targetUserId)));
    await audit(tx, actorId, orgId, "member.role_changed", targetUserId, { from: t.role, to: role });
  });
}

export async function setMemberPermissions(actorId: string, orgId: string, targetUserId: string, permissions: string[], db: Db = defaultDb): Promise<void> {
  await requireOrgRole(actorId, orgId, "admin", db);
  const clean = [...new Set(permissions)];
  const bad = clean.find((p) => !PERMISSION_KEYS.has(p));
  if (bad) throw new AppError("VALIDATION", `Unknown permission "${bad}"`, 422);
  const res = await db.update(organizationMembers).set({ permissions: clean })
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, targetUserId))).returning({ id: organizationMembers.id });
  if (!res.length) throw new AppError("NOT_FOUND", "That person is not a member", 404);
  await audit(db, actorId, orgId, "member.permissions_changed", targetUserId, { permissions: clean });
}

/** Owner hands ownership to another member; the previous owner becomes an admin. */
export async function transferOwnership(actorId: string, orgId: string, toUserId: string, db: Db = defaultDb): Promise<void> {
  await requireOrgRole(actorId, orgId, "owner", db);
  if (toUserId === actorId) throw new AppError("VALIDATION", "You already own this organization", 422);
  await db.transaction(async (tx) => {
    await lockOwners(tx, orgId);
    const [t] = await tx.select({ role: organizationMembers.role }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, toUserId))).limit(1);
    if (!t) throw new AppError("NOT_FOUND", "The new owner must already be a member", 404);
    await tx.update(organizationMembers).set({ role: "owner" }).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, toUserId)));
    await tx.update(organizationMembers).set({ role: "admin" }).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, actorId)));
    await audit(tx, actorId, orgId, "org.ownership_transferred", toUserId);
  });
}

// ───────── invitations
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const inviteUrl = (token: string) => `${appUrl()}/invite/${token}`;

export type InvitationRow = { id: string; email: string; role: OrgRole; expiresAt: Date; createdAt: Date; invitedByName: string | null; expired: boolean };

async function sendInviteEmail(orgName: string, inviterName: string, email: string, role: OrgRole, url: string): Promise<boolean> {
  try {
    const t = authEmailTemplate({
      heading: `Join ${orgName} on ${APP_NAME}`,
      body: `${inviterName} invited you to join ${orgName} as ${role === "admin" ? "an admin" : `a ${role}`}. This invitation expires in ${INVITE_TTL_DAYS} days.`,
      cta: "Accept invitation", url,
    });
    await getEmailProvider().send({ to: email, subject: `${inviterName} invited you to ${orgName}`, ...t });
    return true;
  } catch (e) {
    console.warn("[organizations] invitation email failed:", (e as Error).message);
    return false;
  }
}

export async function inviteMember(actorId: string, orgId: string, input: { email: string; role?: OrgRole }, db: Db = defaultDb) {
  const actor = await requireOrgPermission(actorId, orgId, "members.invite", db);
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new AppError("VALIDATION", "Enter a valid email address", 422, [{ path: "email", message: "Invalid email" }]);
  const role: OrgRole = input.role ?? "member";
  if (!(role in RANK)) throw new AppError("VALIDATION", "Invalid role", 422);
  if (RANK[role] > RANK[actor.role] || (role !== "member" && RANK[actor.role] < RANK.admin))
    throw new AppError("FORBIDDEN", "You cannot invite someone with higher rights than your own", 403);
  if (role === "owner" && actor.role !== "owner") throw new AppError("FORBIDDEN", "Only an owner can invite another owner", 403);

  const [existing] = await db.select({ id: users.id }).from(users)
    .innerJoin(organizationMembers, and(eq(organizationMembers.userId, users.id), eq(organizationMembers.organizationId, orgId)))
    .where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (existing) throw new AppError("CONFLICT", "That person is already a member", 409);

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
  const inv = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`invite:${orgId}:${email}`}, 0))`);
    await tx.delete(invitations).where(and(eq(invitations.organizationId, orgId), sql`lower(${invitations.email}) = ${email}`, isNull(invitations.acceptedAt)));
    const [row] = await tx.insert(invitations).values({ organizationId: orgId, email, role, tokenHash: sha256(token), invitedBy: actorId, expiresAt }).returning();
    await audit(tx, actorId, orgId, "member.invited", row.id, { email, role });
    return row;
  });
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  const url = inviteUrl(token);
  const emailSent = await sendInviteEmail(org?.name ?? "the team", me?.name ?? "A teammate", email, role, url);
  return { invitation: inv, inviteUrl: url, emailSent };
}

export async function listInvitations(actorId: string, orgId: string, db: Db = defaultDb): Promise<InvitationRow[]> {
  await requireOrgRole(actorId, orgId, "admin", db);
  const rows = await db.select({
    id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt,
    createdAt: invitations.createdAt, invitedByName: users.name,
  }).from(invitations).leftJoin(users, eq(users.id, invitations.invitedBy))
    .where(and(eq(invitations.organizationId, orgId), isNull(invitations.acceptedAt))).orderBy(asc(invitations.createdAt));
  const now = Date.now();
  return rows.map((r) => ({ ...r, expired: r.expiresAt.getTime() <= now }));
}

export async function revokeInvitation(actorId: string, orgId: string, invitationId: string, db: Db = defaultDb): Promise<void> {
  await requireOrgRole(actorId, orgId, "admin", db);
  if (!isUuid(invitationId)) throw new AppError("NOT_FOUND", "Invitation not found", 404);
  const res = await db.delete(invitations).where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, orgId), isNull(invitations.acceptedAt))).returning({ id: invitations.id });
  if (!res.length) throw new AppError("NOT_FOUND", "Invitation not found", 404);
  await audit(db, actorId, orgId, "invitation.revoked", invitationId);
}

/** Issues a fresh token + expiry for a pending invitation and re-sends the email. */
export async function resendInvitation(actorId: string, orgId: string, invitationId: string, db: Db = defaultDb) {
  await requireOrgRole(actorId, orgId, "admin", db);
  if (!isUuid(invitationId)) throw new AppError("NOT_FOUND", "Invitation not found", 404);
  const token = randomToken(32);
  const [row] = await db.update(invitations).set({ tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) })
    .where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, orgId), isNull(invitations.acceptedAt))).returning();
  if (!row) throw new AppError("NOT_FOUND", "Invitation not found", 404);
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  const url = inviteUrl(token);
  const emailSent = await sendInviteEmail(org?.name ?? "the team", me?.name ?? "A teammate", row.email, row.role, url);
  return { inviteUrl: url, emailSent };
}

export type InvitationPreview = {
  status: "valid" | "expired" | "accepted" | "invalid";
  orgName?: string; orgSlug?: string; email?: string; role?: OrgRole; inviterName?: string | null;
  /** Whether an account already exists for the invited email (login vs sign up). */
  accountExists?: boolean;
};

export async function getInvitationPreview(token: string, db: Db = defaultDb): Promise<InvitationPreview> {
  if (!token || token.length < 16 || token.length > 200) return { status: "invalid" };
  const [r] = await db.select({
    email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt, acceptedAt: invitations.acceptedAt,
    orgName: organizations.name, orgSlug: organizations.slug, orgDeleted: organizations.deletedAt, inviterName: users.name,
  }).from(invitations).innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .leftJoin(users, eq(users.id, invitations.invitedBy)).where(eq(invitations.tokenHash, sha256(token))).limit(1);
  if (!r || r.orgDeleted) return { status: "invalid" };
  const [acct] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${r.email.toLowerCase()}`).limit(1);
  const base = { orgName: r.orgName, orgSlug: r.orgSlug, email: r.email, role: r.role, inviterName: r.inviterName, accountExists: !!acct };
  if (r.acceptedAt) return { status: "accepted", ...base };
  if (r.expiresAt.getTime() <= Date.now()) return { status: "expired", ...base };
  return { status: "valid", ...base };
}

/** The signed-in user (whose email must match the invitation) joins the organization. */
export async function acceptInvitation(userId: string, token: string, db: Db = defaultDb): Promise<{ organizationId: string; slug: string; role: OrgRole }> {
  const hash = sha256(String(token ?? ""));
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, hash)).for("update").limit(1);
    if (!inv) throw new AppError("NOT_FOUND", "This invitation link is not valid", 404);
    if (inv.acceptedAt) throw new AppError("INVALID_STATE", "This invitation was already used", 409);
    if (inv.expiresAt.getTime() <= Date.now()) throw new AppError("EXPIRED", "This invitation has expired. Ask an admin to send a new one.", 410);
    const [u] = await tx.select({ email: users.email, deletedAt: users.deletedAt }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u || u.deletedAt) throw new AppError("UNAUTHORIZED", "Account not found", 401);
    if (u.email.toLowerCase() !== inv.email.toLowerCase())
      throw new AppError("FORBIDDEN", `This invitation was sent to ${inv.email}. Sign in with that email address to accept it.`, 403);
    const [org] = await tx.select({ slug: organizations.slug, deletedAt: organizations.deletedAt }).from(organizations).where(eq(organizations.id, inv.organizationId)).limit(1);
    if (!org || org.deletedAt) throw new AppError("NOT_FOUND", "This organization no longer exists", 404);
    const [cur] = await tx.select({ role: organizationMembers.role }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, inv.organizationId), eq(organizationMembers.userId, userId))).limit(1);
    let role = inv.role;
    if (cur) role = RANK[cur.role] >= RANK[inv.role] ? cur.role : inv.role; // never downgrade
    if (!cur) await tx.insert(organizationMembers).values({ organizationId: inv.organizationId, userId, role });
    else if (role !== cur.role) await tx.update(organizationMembers).set({ role }).where(and(eq(organizationMembers.organizationId, inv.organizationId), eq(organizationMembers.userId, userId)));
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
    await audit(tx, userId, inv.organizationId, "invitation.accepted", inv.id);
    return { organizationId: inv.organizationId, slug: org.slug, role };
  });
}

// ───────── team availability ("who is free")
export type TeamAvailabilityMember = {
  userId: string; name: string; image: string | null; timeZone: string; freeNow: boolean;
  /** UTC ISO intervals when the member is within working hours and not busy. */
  free: { start: string; end: string }[];
  /** Total free minutes in the window. */
  freeMinutes: number;
};

export async function getTeamAvailability(
  actorId: string, orgId: string, opts: { from: Date; to: Date; now?: Date }, db: Db = defaultDb,
): Promise<TeamAvailabilityMember[]> {
  await requireOrgRole(actorId, orgId, "member", db);
  const { from, to } = opts;
  if (!(to > from) || to.getTime() - from.getTime() > 14 * 86_400_000) throw new AppError("VALIDATION", "Choose a window of up to 14 days", 422);
  const now = (opts.now ?? new Date()).getTime();
  const members = await listMembers(actorId, orgId, db);
  const ids = members.map((m) => m.userId);
  if (!ids.length) return [];
  const margin = 86_400_000;
  const [schedules, bookingRows, blocked] = await Promise.all([
    db.select().from(schema.availabilitySchedules).where(inArray(schema.availabilitySchedules.userId, ids)),
    db.select({ hostUserId: schema.bookings.hostUserId, s: schema.bookings.blockStart, e: schema.bookings.blockEnd }).from(schema.bookings)
      .where(and(inArray(schema.bookings.hostUserId, ids), inArray(schema.bookings.status, ["confirmed", "pending_payment", "pending_confirmation"]),
        lt(schema.bookings.blockStart, new Date(to.getTime() + margin)), gt(schema.bookings.blockEnd, new Date(from.getTime() - margin)))),
    db.select().from(schema.blockedTimes).where(and(inArray(schema.blockedTimes.userId, ids), lt(schema.blockedTimes.startsAt, to), gt(schema.blockedTimes.endsAt, from))),
  ]);
  const sIds = schedules.map((s) => s.id);
  const [rules, overrides] = sIds.length
    ? await Promise.all([
        db.select().from(schema.availabilityRules).where(inArray(schema.availabilityRules.scheduleId, sIds)),
        db.select().from(schema.availabilityOverrides).where(inArray(schema.availabilityOverrides.scheduleId, sIds)),
      ])
    : [[], []];

  return members.map((m) => {
    const mine = schedules.filter((s) => s.userId === m.userId);
    const sched = mine.find((s) => s.isDefault) ?? mine[0];
    let free: Interval[] = [];
    if (sched) {
      const tz = sched.timeZone || m.timeZone;
      const avail = expandAvailability({
        rules: rules.filter((r) => r.scheduleId === sched.id), overrides: overrides.filter((o) => o.scheduleId === sched.id),
        timeZone: tz, from: from.getTime(), to: to.getTime(),
      }).map((i) => ({ start: Math.max(i.start, from.getTime()), end: Math.min(i.end, to.getTime()) })).filter((i) => i.end > i.start);
      const busy: Interval[] = [
        ...bookingRows.filter((b) => b.hostUserId === m.userId).map((b) => ({ start: b.s.getTime(), end: b.e.getTime() })),
        ...blocked.filter((b) => b.userId === m.userId).map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() })),
      ];
      free = subtractIntervals(avail, busy);
    }
    return {
      userId: m.userId, name: m.name, image: m.image, timeZone: m.timeZone,
      freeNow: free.some((i) => i.start <= now && now < i.end),
      free: free.map((i) => ({ start: new Date(i.start).toISOString(), end: new Date(i.end).toISOString() })),
      freeMinutes: Math.round(free.reduce((a, i) => a + (i.end - i.start), 0) / 60_000),
    };
  });
}

export const startOfDayUtc = (tz: string, date?: string) => {
  const d = (date ? DateTime.fromISO(date, { zone: tz }) : DateTime.now().setZone(tz)).startOf("day");
  return d.isValid ? d : DateTime.now().setZone("UTC").startOf("day");
};
