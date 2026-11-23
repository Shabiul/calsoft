/**
 * Inactive team members ("bench"). Catches people who left the company while nobody removed them from the app.
 *  - Activity = signing in / using the app (touchActivity, called on every authenticated request) or a manager's "Mark as active".
 *  - Day 14 without activity: the member is emailed. Day 18: the member and their manager(s) are emailed.
 *  - Day 20: BENCHED. No new bookings (slots only use status "active" hosts), their own event types are paused, and their upcoming
 *    meetings move to their manager (invitees get a "new host" email). The manager gets a summary of what moved and what could not.
 *  - Benched for 60 days (day 80): the account is closed (deleteAccount). Until then the manager can restore it with one click, and
 *    the member is restored automatically when they sign in. Restoring does not move meetings back.
 * Only members of a team are benched; solo accounts have nobody to hand meetings to.
 * Manager = organization_member.manager_user_id (any team member). When unset or not usable: the team's owners (then admins).
 */
import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { AppError } from "@/server/errors";
import { authEmailTemplate } from "@/lib/auth-email";
import { APP_NAME } from "@/lib/brand";
import { getEmailProvider } from "@/server/notifications/provider";
import { appUrl } from "@/server/integrations/config";
import { transferBookingHost } from "@/server/integrations/booking-sync";
import { pgCode } from "./booking";
import { deleteAccount } from "./account";
import { requireOrgRole } from "./organizations";

const { users, organizationMembers, organizations, bookings, invitees, eventTypes, eventHosts, auditLogs } = schema;

export const BENCH_RULES = { warnUserDays: 14, warnManagerDays: 18, benchDays: 20, graceDays: 60 } as const;
const DAY = 86_400_000;
const HOLDING = ["confirmed", "pending_confirmation", "pending_payment"] as const;

type Person = { id: string; name: string; email: string };
type Bench = { stage: number; benchedAt?: string; pausedEventTypeIds?: string[] };

// ───────── activity
const touched = new Map<string, number>();
const TOUCH_EVERY_MS = 60 * 60_000;

/** Records app use (throttled to one write per user per hour per process). A benched member who signs in is restored. */
export async function touchActivity(userId: string, status: string): Promise<void> {
  if (status === "benched") { await restoreMember(userId, null); return; }
  const last = touched.get(userId) ?? 0;
  if (Date.now() - last < TOUCH_EVERY_MS) return;
  touched.set(userId, Date.now());
  await db.update(users).set({ lastActiveAt: new Date(), bench: null }).where(eq(users.id, userId));
}

// ───────── managers
type OrgManagers = { orgId: string; orgName: string; target: Person | null; notify: Person[] };

const activeUser = and(isNull(users.deletedAt), eq(users.status, "active"));

/** Per team the member belongs to (oldest membership first): who takes their meetings, and who is told. */
export async function managersFor(userId: string): Promise<OrgManagers[]> {
  const mems = await db.select({ orgId: organizationMembers.organizationId, orgName: organizations.name, managerUserId: organizationMembers.managerUserId })
    .from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt))).orderBy(asc(organizationMembers.createdAt));
  const out: OrgManagers[] = [];
  for (const m of mems) {
    const staff = await db.select({ id: users.id, name: users.name, email: users.email, role: organizationMembers.role })
      .from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, m.orgId), ne(users.id, userId), activeUser))
      .orderBy(asc(organizationMembers.createdAt));
    const manager = m.managerUserId ? staff.find((s) => s.id === m.managerUserId) : undefined;
    const leads = [...staff.filter((s) => s.role === "owner"), ...staff.filter((s) => s.role === "admin")];
    const person = ({ id, name, email }: Person) => ({ id, name, email });
    out.push({ orgId: m.orgId, orgName: m.orgName, target: manager ? person(manager) : leads[0] ? person(leads[0]) : null, notify: (manager ? [manager] : leads).map(person) });
  }
  return out;
}

// ───────── email
async function mail(to: string, subject: string, heading: string, body: string, cta: string, url: string) {
  try { await getEmailProvider().send({ to, subject, ...authEmailTemplate({ heading, body, cta, url }) }); }
  catch (e) { console.warn("[bench] email failed:", (e as Error).message); }
}
const teamUrl = (orgId: string) => `${appUrl()}/dashboard/teams/${orgId}`;
const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

// ───────── sweep (worker, every few hours; idempotent)
export async function benchSweep(now = new Date()): Promise<{ warned: number; benched: number; closed: number }> {
  const rows = await db.selectDistinct({ id: users.id, name: users.name, email: users.email, status: users.status, lastActiveAt: users.lastActiveAt, bench: users.bench })
    .from(users).innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(and(isNull(users.deletedAt), inArray(users.status, ["active", "benched"]), ne(users.platformRole, "superadmin"),
      lt(users.lastActiveAt, new Date(now.getTime() - BENCH_RULES.warnUserDays * DAY))));
  const r = { warned: 0, benched: 0, closed: 0 };
  for (const u of rows) {
    try {
      const step = await stepFor(u, now);
      if (step) r[step]++;
    } catch (e) { console.error("[bench] member", u.id, e instanceof Error ? e.message : e); }
  }
  return r;
}

type Row = { id: string; name: string; email: string; status: string; lastActiveAt: Date; bench: Bench | null };

/** Exported for tests: what the sweep does to one member right now. */
export function nextStep(u: Pick<Row, "status" | "lastActiveAt" | "bench">, now: Date): "warn_user" | "warn_manager" | "bench" | "close" | null {
  const idle = (now.getTime() - u.lastActiveAt.getTime()) / DAY;
  const stage = u.bench?.stage ?? 0;
  if (u.status === "benched") {
    const at = u.bench?.benchedAt ? Date.parse(u.bench.benchedAt) : u.lastActiveAt.getTime() + BENCH_RULES.benchDays * DAY;
    return now.getTime() - at >= BENCH_RULES.graceDays * DAY ? "close" : null;
  }
  if (idle >= BENCH_RULES.benchDays) return "bench";
  if (idle >= BENCH_RULES.warnManagerDays && stage < 2) return "warn_manager";
  if (idle >= BENCH_RULES.warnUserDays && stage < 1) return "warn_user";
  return null;
}

async function stepFor(u: Row, now: Date): Promise<"warned" | "benched" | "closed" | null> {
  const step = nextStep(u, now);
  if (!step) return null;
  const login = `${appUrl()}/login`;
  const left = Math.max(1, Math.ceil(BENCH_RULES.benchDays - (now.getTime() - u.lastActiveAt.getTime()) / DAY));
  if (step === "warn_user") {
    await mail(u.email, `Sign in to keep your ${APP_NAME} account active`, "Are you still there?",
      `You have not used ${APP_NAME} for ${BENCH_RULES.warnUserDays} days. If you do not sign in within ${left} days, your account will be benched: your booking pages stop taking meetings and your upcoming meetings move to your manager.`,
      "Sign in", login);
    await db.update(users).set({ bench: { stage: 1 } }).where(eq(users.id, u.id));
    return "warned";
  }
  if (step === "warn_manager") {
    await mail(u.email, `Your ${APP_NAME} account will be benched in ${left} days`, "Your account is about to be benched",
      `Sign in within ${left} days to keep your booking pages and meetings.`, "Sign in", login);
    for (const g of await managersFor(u.id)) for (const m of g.notify) {
      await mail(m.email, `${u.name} has been inactive for ${BENCH_RULES.warnManagerDays} days`, `${u.name} may have left ${g.orgName}`,
        `${u.name} (${u.email}) has not used ${APP_NAME} for ${BENCH_RULES.warnManagerDays} days. In ${left} days they will be benched and their upcoming meetings will move to ${g.target?.id === m.id ? "you" : g.target?.name ?? "the team owners"}.\n\nIf they are still working (for example on holiday), mark them as active on the team page.`,
        "Open team", teamUrl(g.orgId));
    }
    await db.update(users).set({ bench: { stage: 2 } }).where(eq(users.id, u.id));
    return "warned";
  }
  if (step === "bench") { await benchMember(u, now); return "benched"; }
  await closeBenched(u);
  return "closed";
}

// ───────── bench
export type MoveResult = { bookingId: string; orgId?: string; title: string; startsAt: Date; moved: boolean; to?: string; problem?: string };

export async function benchMember(u: Person, now = new Date()): Promise<MoveResult[]> {
  const groups = await managersFor(u.id);
  // 1) stop new bookings first (slots ignore non-active hosts) and pause their own event types
  const paused = await db.update(eventTypes).set({ isActive: false, updatedAt: now })
    .where(and(eq(eventTypes.ownerUserId, u.id), eq(eventTypes.isActive, true), isNull(eventTypes.deletedAt))).returning({ id: eventTypes.id });
  await db.update(users).set({ status: "benched", bench: { stage: 3, benchedAt: now.toISOString(), pausedEventTypeIds: paused.map((p) => p.id) }, updatedAt: now }).where(eq(users.id, u.id));

  // 2) move upcoming meetings to the manager of the team they belong to (personal bookings: the member's first team)
  const upcoming = await db.select({ id: bookings.id, orgId: bookings.organizationId, startsAt: bookings.startsAt, title: eventTypes.title })
    .from(bookings).innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .where(and(eq(bookings.hostUserId, u.id), gt(bookings.startsAt, now), inArray(bookings.status, [...HOLDING]))).orderBy(asc(bookings.startsAt));
  const results: MoveResult[] = [];
  for (const b of upcoming) {
    const g = groups.find((x) => x.orgId === b.orgId) ?? groups[0];
    const base = { bookingId: b.id, orgId: g?.orgId, title: b.title, startsAt: b.startsAt };
    if (!g?.target) { results.push({ ...base, moved: false, problem: "nobody on the team can take it" }); continue; }
    try {
      const sync = await transferBookingHost(b.id, g.target.id);
      results.push({ ...base, moved: true, to: g.target.name, problem: sync.ok ? undefined : `calendar/meeting link: ${sync.failures.map((f) => f.error).join("; ").slice(0, 200)}` });
      await notifyInvitees(b.id, g.target.id);
    } catch (e) {
      results.push({ ...base, moved: false, problem: pgCode(e) === "23P01" ? `${g.target.name} already has a meeting at that time` : (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }

  // 3) team event types left with no active host can no longer be booked
  const orphaned = await db.select({ title: eventTypes.title, orgId: eventTypes.organizationId }).from(eventTypes)
    .innerJoin(eventHosts, eq(eventHosts.eventTypeId, eventTypes.id))
    .where(and(eq(eventHosts.userId, u.id), isNull(eventTypes.deletedAt), eq(eventTypes.isActive, true), sql`not exists (
      select 1 from ${eventHosts} h join ${users} x on x.id = h.user_id
      where h.event_type_id = ${eventTypes.id} and h.user_id <> ${u.id} and x.status = 'active' and x.deleted_at is null)`));

  // 4) tell the managers (one summary per team) and the member
  for (const g of groups) {
    const mine = results.filter((r) => r.orgId === g.orgId);
    const lines = [
      `${u.name} (${u.email}) was inactive for ${BENCH_RULES.benchDays} days and has been benched: their booking pages are paused.`,
      mine.length ? `\nUpcoming meetings (${mine.length}):` : "\nThey had no upcoming meetings.",
      ...mine.map((r) => `- ${fmt(r.startsAt)} ${r.title}: ${r.moved ? `moved to ${r.to}${r.problem ? ` (needs attention: ${r.problem})` : ""}` : `NOT moved, ${r.problem}. Reassign or cancel it.`}`),
      ...orphaned.filter((o) => o.orgId === g.orgId).map((o) => `- Team event "${o.title}" has no active host left and cannot be booked.`),
      `\nRestore ${u.name} from the team page within ${BENCH_RULES.graceDays} days if this was a mistake. After that the account is closed.`,
    ];
    for (const m of g.notify) await mail(m.email, `${u.name} was benched: ${mine.filter((r) => r.moved).length} of ${mine.length} meetings moved`, `${u.name} was benched`, lines.join("\n"), "Open team", teamUrl(g.orgId));
    await db.insert(auditLogs).values({ actorId: null, organizationId: g.orgId, action: "member.benched", entity: "user", entityId: u.id, meta: { moved: mine.filter((r) => r.moved).length, notMoved: mine.filter((r) => !r.moved).length } });
  }
  await mail(u.email, `Your ${APP_NAME} account was benched`, "Your account was benched",
    `You have not used ${APP_NAME} for ${BENCH_RULES.benchDays} days. Your booking pages are paused and your upcoming meetings moved to your manager. Sign in within ${BENCH_RULES.graceDays} days to restore your account.`,
    "Sign in", `${appUrl()}/login`);
  return results;
}

async function notifyInvitees(bookingId: string, toUserId: string) {
  const { queueNotification } = await import("@/server/notifications/service");
  const { dedupeKey } = await import("@/server/queue/backoff");
  const invs = await db.select({ email: invitees.email }).from(invitees).where(and(eq(invitees.bookingId, bookingId), isNull(invitees.cancelledAt)));
  for (const i of invs) await queueNotification({ kind: "host_changed", bookingId, recipient: i.email, dedupeKey: dedupeKey("host_changed", bookingId, i.email.toLowerCase(), toUserId) });
}

async function closeBenched(u: Person) {
  const groups = await managersFor(u.id);
  await deleteAccount(u.id); // cancels any meeting that could not be moved (invitees are told)
  for (const g of groups) {
    for (const m of g.notify) await mail(m.email, `${u.name}'s account was closed`, `${u.name}'s account was closed`,
      `${u.name} was benched for ${BENCH_RULES.graceDays} days without being restored, so their account was closed. Meetings still assigned to them were cancelled.`,
      "Open team", teamUrl(g.orgId));
    await db.insert(auditLogs).values({ actorId: null, organizationId: g.orgId, action: "member.bench_closed", entity: "user", entityId: u.id });
  }
}

// ───────── restore / manager actions
/** Back to active: booking pages that the bench paused are switched on again. Meetings that were moved stay with the manager. */
export async function restoreMember(userId: string, actorId: string | null): Promise<void> {
  const [u] = await db.select({ status: users.status, bench: users.bench }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || u.status !== "benched") return;
  const now = new Date();
  await db.update(users).set({ status: "active", bench: null, lastActiveAt: now, updatedAt: now }).where(and(eq(users.id, userId), eq(users.status, "benched")));
  const ids = u.bench?.pausedEventTypeIds ?? [];
  if (ids.length) await db.update(eventTypes).set({ isActive: true, updatedAt: now }).where(and(inArray(eventTypes.id, ids), isNull(eventTypes.deletedAt)));
  touched.set(userId, Date.now());
  const [who] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  for (const g of await managersFor(userId)) {
    await db.insert(auditLogs).values({ actorId, organizationId: g.orgId, action: actorId ? "member.restored" : "member.self_restored", entity: "user", entityId: userId });
    // Signing in again restores access silently for the member, so the managers must hear about it: someone who left the company
    // and still has their password would otherwise be back in unnoticed.
    if (!actorId && who) for (const m of g.notify) {
      await mail(m.email, `${who.name} signed in again and is no longer benched`, `${who.name} is back`,
        `${who.name} (${who.email}) signed in to ${APP_NAME} and their account was restored automatically. If they no longer work at ${g.orgName}, remove them from the team now.`,
        "Open team", teamUrl(g.orgId));
    }
  }
}

async function requireManagerOrAdmin(actorId: string, orgId: string, targetUserId: string) {
  const [t] = await db.select({ managerUserId: organizationMembers.managerUserId }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, targetUserId))).limit(1);
  if (!t) throw new AppError("NOT_FOUND", "That person is not a member", 404);
  await requireOrgRole(actorId, orgId, "member"); // a manager who has left the team loses this right
  if (t.managerUserId === actorId) return;
  await requireOrgRole(actorId, orgId, "admin");
}

/** "Mark as active" (still working, e.g. on holiday) or "Restore" a benched member. Their manager or a team admin. */
export async function reactivateMember(actorId: string, orgId: string, targetUserId: string): Promise<void> {
  await requireManagerOrAdmin(actorId, orgId, targetUserId);
  const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, targetUserId)).limit(1);
  if (u?.status === "benched") return restoreMember(targetUserId, actorId);
  await db.update(users).set({ lastActiveAt: new Date(), bench: null }).where(eq(users.id, targetUserId));
}

/** Admins pick any team member as someone's manager (null = owners/admins). */
export async function setMemberManager(actorId: string, orgId: string, targetUserId: string, managerUserId: string | null): Promise<void> {
  await requireOrgRole(actorId, orgId, "admin");
  if (managerUserId === targetUserId) throw new AppError("VALIDATION", "A member cannot be their own manager", 422);
  if (managerUserId) {
    const [m] = await db.select({ id: organizationMembers.id }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, managerUserId))).limit(1);
    if (!m) throw new AppError("VALIDATION", "The manager must be a member of this team", 422);
  }
  const res = await db.update(organizationMembers).set({ managerUserId })
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, targetUserId))).returning({ id: organizationMembers.id });
  if (!res.length) throw new AppError("NOT_FOUND", "That person is not a member", 404);
  await db.insert(auditLogs).values({ actorId, organizationId: orgId, action: "member.manager_set", entity: "user", entityId: targetUserId, meta: { managerUserId } });
}
