/** Real-DB tests for the organizations service (isolated fixtures, cleaned up). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { AppError } from "../errors";
import { sha256 } from "@/lib/crypto";
import { setEmailProviderForTests, type EmailMessage } from "../notifications/provider";
import { loadEvent, loadEventById, loadProfile } from "../public/data";
import { checkUsername } from "./username";
import {
  acceptInvitation, changeMemberRole, checkOrgSlug, createOrganization, getInvitationPreview, getTeamAvailability,
  inviteMember, leaveOrganization, listInvitations, listMembers, removeMember, requireOrgPermission, requireOrgRole,
  resendInvitation, revokeInvitation, setMemberPermissions, transferOwnership, updateOrganization,
} from "./organizations";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `og_${run}_${n}`;
const userIds: string[] = [];
const sent: EmailMessage[] = [];
async function mkUser(n: string, extra: Partial<typeof schema.users.$inferInsert> = {}) {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name: `User ${n}`, email: `${id}@example.test`, timeZone: "UTC", username: `un-${run}-${n}`, ...extra });
  userIds.push(id);
  return id;
}
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? e.code : (e as Error).message; } };
const emailOf = (id: string) => `${id}@example.test`;
const tokenFrom = (url: string) => url.split("/invite/")[1]!;

let O: string, A: string, M: string, X: string, N: string;
let orgId: string;

beforeAll(async () => {
  setEmailProviderForTests({ name: "test", send: async (m) => { sent.push(m); return {}; } });
  [O, A, M, X, N] = await Promise.all(["owner", "admin", "member", "outsider", "newbie"].map((n) => mkUser(n)));
  const org = await createOrganization(O, { name: `Acme ${run}`, slug: `acme-${run}`, brandColor: "#112233" });
  orgId = org.id;
});

afterAll(async () => {
  setEmailProviderForTests(null);
  await db.delete(schema.auditLogs).where(eq(schema.auditLogs.organizationId, orgId));
  await db.delete(schema.organizations).where(like(schema.organizations.slug, `%${run}%`));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await pool.end();
});

describe("create + settings + shared namespace", () => {
  it("creates the org with the creator as owner", async () => {
    const ms = await listMembers(O, orgId);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ userId: O, role: "owner" });
    expect(await requireOrgRole(O, orgId, "owner")).toMatchObject({ role: "owner" });
  });
  it("blocks slugs used by a username, another org, or the reserved list", async () => {
    expect(await code(createOrganization(O, { name: "Dup", slug: `un-${run}-owner` }))).toBe("SLUG_TAKEN");
    expect(await code(createOrganization(O, { name: "Dup", slug: `acme-${run}` }))).toBe("SLUG_TAKEN");
    expect(await code(createOrganization(O, { name: "Dup", slug: `ACME-${run}` }))).toBe("SLUG_TAKEN");
    expect(await code(createOrganization(O, { name: "Dash", slug: "dashboard" }))).toBe("VALIDATION");
    expect(await code(createOrganization(O, { name: "Bad slug", slug: "no spaces!" }))).toBe("VALIDATION");
    expect((await checkOrgSlug("dashboard")).available).toBe(false);
  });
  it("users cannot claim an org slug (shared namespace)", async () => {
    const r = await checkUsername(`acme-${run}`);
    expect(r).toMatchObject({ available: false, reason: "taken" });
  });
  it("rename: owner can change slug, collisions rejected, admin cannot", async () => {
    expect(await code(updateOrganization(O, orgId, { slug: `un-${run}-admin` }))).toBe("SLUG_TAKEN");
    const o2 = await updateOrganization(O, orgId, { name: `Acme Inc ${run}`, brandColor: "#abcdef", logoUrl: "https://example.com/l.png" });
    expect(o2).toMatchObject({ name: `Acme Inc ${run}`, brandColor: "#abcdef", logoUrl: "https://example.com/l.png" });
    expect(await code(updateOrganization(O, orgId, { brandColor: "red" }))).toBe("VALIDATION");
    expect(await code(updateOrganization(O, orgId, { logoUrl: "javascript:alert(1)" }))).toBe("VALIDATION");
    expect(await code(updateOrganization(X, orgId, { name: "Hacked" }))).toBe("FORBIDDEN");
  });
});

describe("invitations", () => {
  it("invites by email with hashed token, emails the link, and replaces a pending invite", async () => {
    const r1 = await inviteMember(O, orgId, { email: ` ${emailOf(A).toUpperCase()} `, role: "admin" });
    expect(r1.emailSent).toBe(true);
    expect(sent.at(-1)?.to).toBe(emailOf(A));
    expect(sent.at(-1)?.text).toContain(r1.inviteUrl);
    const token = tokenFrom(r1.inviteUrl);
    const [row] = await db.select().from(schema.invitations).where(eq(schema.invitations.id, r1.invitation.id));
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.tokenHash).not.toContain(token);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const r2 = await inviteMember(O, orgId, { email: emailOf(A), role: "admin" });
    expect((await listInvitations(O, orgId)).filter((i) => i.email === emailOf(A))).toHaveLength(1);
    expect(await code(acceptInvitation(A, token))).toBe("NOT_FOUND"); // old token dead
    // wrong account
    expect(await code(acceptInvitation(X, tokenFrom(r2.inviteUrl)))).toBe("FORBIDDEN");
    expect(await getInvitationPreview(tokenFrom(r2.inviteUrl))).toMatchObject({ status: "valid", accountExists: true, role: "admin" });
    const res = await acceptInvitation(A, tokenFrom(r2.inviteUrl));
    expect(res.role).toBe("admin");
    expect(await code(acceptInvitation(A, tokenFrom(r2.inviteUrl)))).toBe("INVALID_STATE"); // single use
    expect(await getInvitationPreview(tokenFrom(r2.inviteUrl))).toMatchObject({ status: "accepted" });
  });
  it("cannot invite existing members; invalid emails rejected; outsiders forbidden", async () => {
    expect(await code(inviteMember(O, orgId, { email: emailOf(A) }))).toBe("CONFLICT");
    expect(await code(inviteMember(O, orgId, { email: "nope" }))).toBe("VALIDATION");
    expect(await code(inviteMember(O, orgId, { email: "someone@outsider.test" }))).toBe("VALIDATION"); // not a company domain
    expect(await code(inviteMember(X, orgId, { email: "z@example.test" }))).toBe("FORBIDDEN");
  });
  it("admins cannot invite owners; plain members need the members.invite permission", async () => {
    expect(await code(inviteMember(A, orgId, { email: "o2@example.test", role: "owner" }))).toBe("FORBIDDEN");
    const r = await inviteMember(A, orgId, { email: emailOf(M), role: "member" });
    await acceptInvitation(M, tokenFrom(r.inviteUrl));
    expect(await code(inviteMember(M, orgId, { email: "q@example.test" }))).toBe("FORBIDDEN");
    await setMemberPermissions(A, orgId, M, ["members.invite"]);
    await requireOrgPermission(M, orgId, "members.invite");
    const ok = await inviteMember(M, orgId, { email: `pending-${run}@example.test` });
    expect(ok.invitation.role).toBe("member");
    expect(await code(inviteMember(M, orgId, { email: "q2@example.test", role: "admin" }))).toBe("FORBIDDEN");
    expect(await code(setMemberPermissions(A, orgId, M, ["bogus"]))).toBe("VALIDATION");
    await setMemberPermissions(A, orgId, M, []);
  });
  it("expired invitations cannot be accepted; resend renews; revoke deletes", async () => {
    const r = await inviteMember(O, orgId, { email: emailOf(N) });
    await db.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitations.id, r.invitation.id));
    expect(await getInvitationPreview(tokenFrom(r.inviteUrl))).toMatchObject({ status: "expired" });
    expect(await code(acceptInvitation(N, tokenFrom(r.inviteUrl)))).toBe("EXPIRED");
    const again = await resendInvitation(O, orgId, r.invitation.id);
    expect(await getInvitationPreview(tokenFrom(again.inviteUrl))).toMatchObject({ status: "valid" });
    expect(await code(acceptInvitation(N, tokenFrom(r.inviteUrl)))).toBe("NOT_FOUND");
    await revokeInvitation(O, orgId, r.invitation.id);
    expect(await getInvitationPreview(tokenFrom(again.inviteUrl))).toMatchObject({ status: "invalid" });
    expect(await code(revokeInvitation(O, orgId, r.invitation.id))).toBe("NOT_FOUND");
  });
  it("garbage tokens are invalid", async () => {
    expect((await getInvitationPreview("x")).status).toBe("invalid");
    expect(await code(acceptInvitation(N, "a".repeat(40)))).toBe("NOT_FOUND");
  });
});

describe("roles, removal, leaving, ownership", () => {
  it("only owners change roles", async () => {
    expect(await code(changeMemberRole(A, orgId, M, "admin"))).toBe("FORBIDDEN");
    await changeMemberRole(O, orgId, M, "admin");
    await changeMemberRole(O, orgId, M, "member");
  });
  it("last-owner protection on demote, remove and leave", async () => {
    expect(await code(changeMemberRole(O, orgId, O, "admin"))).toBe("LAST_OWNER");
    expect(await code(removeMember(O, orgId, O))).toBe("LAST_OWNER");
    expect(await code(leaveOrganization(O, orgId))).toBe("LAST_OWNER");
  });
  it("admins cannot remove admins/owners but can remove members; removal drops host assignments", async () => {
    expect(await code(removeMember(A, orgId, O))).toBe("FORBIDDEN");
    const [ev] = await db.insert(schema.eventTypes).values({ organizationId: orgId, slug: `rr-${run}`, title: "t", kind: "round_robin" }).returning();
    await db.insert(schema.eventHosts).values([{ eventTypeId: ev.id, userId: M }, { eventTypeId: ev.id, userId: O }]);
    await removeMember(A, orgId, M);
    expect((await listMembers(O, orgId)).some((m) => m.userId === M)).toBe(false);
    const hosts = await db.select().from(schema.eventHosts).where(eq(schema.eventHosts.eventTypeId, ev.id));
    expect(hosts.map((h) => h.userId)).toEqual([O]);
    expect(await code(requireOrgRole(M, orgId, "member"))).toBe("FORBIDDEN");
    expect(await code(removeMember(A, orgId, M))).toBe("NOT_FOUND");
  });
  it("transfer ownership then the old owner may leave; two owners allow demotion", async () => {
    expect(await code(transferOwnership(A, orgId, A))).toBe("FORBIDDEN");
    expect(await code(transferOwnership(O, orgId, X))).toBe("NOT_FOUND");
    await transferOwnership(O, orgId, A);
    const ms = await listMembers(O, orgId);
    expect(ms.find((m) => m.userId === A)?.role).toBe("owner");
    expect(ms.find((m) => m.userId === O)?.role).toBe("admin");
    expect(await code(updateOrganization(O, orgId, { slug: `acme2-${run}` }))).toBe("FORBIDDEN"); // no longer owner
    await updateOrganization(A, orgId, { slug: `acme2-${run}` });
    await leaveOrganization(O, orgId);
    expect((await listMembers(A, orgId)).map((m) => m.userId)).toEqual([A]);
    expect(await code(leaveOrganization(A, orgId))).toBe("LAST_OWNER");
  });
});

describe("team availability", () => {
  it("reports who is free: working hours minus bookings/blocked time", async () => {
    const r = await inviteMember(A, orgId, { email: emailOf(M) });
    await acceptInvitation(M, tokenFrom(r.inviteUrl));
    for (const u of [A, M]) {
      const [s] = await db.insert(schema.availabilitySchedules).values({ userId: u, name: "w", timeZone: "UTC", isDefault: true }).returning();
      await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "09:00", endTime: "17:00" })));
    }
    const day = new Date(Date.UTC(2031, 0, 8)); // a far-future Wednesday
    const from = day, to = new Date(day.getTime() + 86_400_000);
    await db.insert(schema.blockedTimes).values({ userId: M, startsAt: new Date(day.getTime() + 9 * 3600_000), endsAt: new Date(day.getTime() + 13 * 3600_000) });
    const now = new Date(day.getTime() + 10 * 3600_000);
    const res = await getTeamAvailability(A, orgId, { from, to, now });
    const a = res.find((x) => x.userId === A)!, m = res.find((x) => x.userId === M)!;
    expect(a.freeMinutes).toBe(8 * 60);
    expect(a.freeNow).toBe(true);
    expect(m.freeMinutes).toBe(4 * 60);
    expect(m.freeNow).toBe(false);
    expect(m.free[0].start).toBe(new Date(day.getTime() + 13 * 3600_000).toISOString());
    expect(await code(getTeamAvailability(X, orgId, { from, to }))).toBe("FORBIDDEN");
  });
});

describe("public org pages share the username namespace", () => {
  it("/{orgSlug} lists team event types and /{orgSlug}/{slug} resolves them with org branding", async () => {
    const [live] = await db.insert(schema.eventTypes).values({ organizationId: orgId, slug: `demo-${run}`, title: "Team demo", kind: "round_robin" }).returning();
    await db.insert(schema.eventTypes).values({ organizationId: orgId, slug: `hidden-${run}`, title: "Hidden", isActive: false });
    const slug = `acme2-${run}`;
    const p = await loadProfile(slug);
    expect(p?.host).toMatchObject({ username: slug, brandColor: "#abcdef" });
    expect(p?.events.map((e) => e.slug)).toEqual([`rr-${run}`, `demo-${run}`]);
    const e = await loadEvent(slug, `demo-${run}`);
    expect(e).toMatchObject({ id: live.id, brandColor: "#abcdef", host: { name: `Acme Inc ${run}`, username: slug } });
    expect(await loadEvent(slug, `hidden-${run}`)).toBeNull();
    expect((await loadEventById(live.id))?.host.username).toBe(slug);
    expect(await loadProfile(`nope-${run}`)).toBeNull();
    // a user's own page still wins for usernames
    expect((await loadProfile(`un-${run}-owner`))?.host.name).toBe(`User owner`);
  });
});
