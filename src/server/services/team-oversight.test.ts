/** Real-DB tests: managers and team leads can view a team's sign-ins, meetings and schedules (read-only); everyone else cannot. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { AppError } from "../errors";
import { getAvailableSlots } from "../scheduling/slots";
import { createBooking, setBookingEventHook } from "./booking";
import { changeMemberRole, inviteMember } from "./organizations";
import { createEventType, getEventType } from "./event-types";
import { listScheduled } from "./scheduled";
import { getMemberDetail, getTeamOverview, listOversightOrgs } from "./team-oversight";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `to_${run}_${n}`;
const userIds: string[] = [];
let orgA = "", orgB = "", orgEvent = "", personalEvent = "";
let OWNER: string, ADMIN: string, MGR: string, TL: string, M1: string, M2: string, OUTSIDER: string, OWNER_B: string, Y: string;
let m1Booking = "";

const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? e.code : (e as Error).message; } };
const slots = (eventId: string) => getAvailableSlots({ eventTypeId: eventId, from: new Date(Date.now() + 3600_000), to: new Date(Date.now() + 3 * 86_400_000), inviteeTimeZone: "UTC" });

async function mkUser(n: string, name: string) {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name, email: `${id}@example.test`, timeZone: "UTC" });
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "Working hours", timeZone: "UTC", isDefault: true }).returning();
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "08:00", endTime: "20:00" })));
  userIds.push(id);
  return id;
}

beforeAll(async () => {
  setBookingEventHook(() => {});
  [OWNER, ADMIN, MGR, TL, M1, M2, OUTSIDER, OWNER_B, Y] = await Promise.all([
    mkUser("owner", "Olive Owner"), mkUser("admin", "Adam Admin"), mkUser("mgr", "Maya Manager"), mkUser("tl", "Theo Lead"),
    mkUser("m1", "Mia Member"), mkUser("m2", "Max Member"), mkUser("out", "Otto Outsider"), mkUser("ownerb", "Bea OwnerB"), mkUser("y", "Yan Other"),
  ]);
  const [a] = await db.insert(schema.organizations).values({ name: `Team A ${run}`, slug: `ta-${run}` }).returning();
  const [b] = await db.insert(schema.organizations).values({ name: `Team B ${run}`, slug: `tb-${run}` }).returning();
  orgA = a.id; orgB = b.id;
  await db.insert(schema.organizationMembers).values([
    { organizationId: orgA, userId: OWNER, role: "owner" }, { organizationId: orgA, userId: ADMIN, role: "admin" },
    { organizationId: orgA, userId: MGR, role: "manager" }, { organizationId: orgA, userId: TL, role: "team_lead" },
    { organizationId: orgA, userId: M1, role: "member" }, { organizationId: orgA, userId: M2, role: "member" },
    { organizationId: orgB, userId: OWNER_B, role: "owner" }, { organizationId: orgB, userId: Y, role: "member" },
  ]);

  await db.update(schema.organizationMembers).set({ managerUserId: TL }).where(and(eq(schema.organizationMembers.organizationId, orgA), eq(schema.organizationMembers.userId, M1)));
  // M1: a personal event type and an org event type, both booked; sign-ins; a broken calendar connection; a Google login
  const [pe] = await db.insert(schema.eventTypes).values({ ownerUserId: M1, slug: `m1-${run}`, title: "Mia personal call", minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
  const [oe] = await db.insert(schema.eventTypes).values({ organizationId: orgA, slug: `oe-${run}`, title: "Team intro", kind: "round_robin", minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
  await db.insert(schema.eventHosts).values({ eventTypeId: oe.id, userId: M1 });
  personalEvent = pe.id; orgEvent = oe.id;
  const s1 = await slots(personalEvent);
  const bk = await createBooking({ eventTypeId: personalEvent, startsAt: s1[1]!.startsAt, invitee: { name: "Pat Invitee", email: `pat-${run}@example.test`, timeZone: "UTC" } });
  m1Booking = bk.booking.id;
  const s2 = await slots(orgEvent);
  await createBooking({ eventTypeId: orgEvent, startsAt: s2[4]!.startsAt, invitee: { name: "Quinn Invitee", email: `quinn-${run}@example.test`, timeZone: "UTC" } });
  await db.insert(schema.signInLogs).values([
    { userId: M1, provider: "google", device: "Chrome on Windows" }, { userId: M1, provider: "google", device: "Safari on iOS" },
  ]);
  await db.insert(schema.accounts).values({ id: `acc_${uid("m1")}`, accountId: "g-m1", providerId: "google", userId: M1 });
  await db.insert(schema.connectedCalendars).values({ userId: M1, provider: "google", externalAccountId: `ext-${run}`, email: "mia@example.test", credentialsEnc: "x", status: "needs_reauth" });
});

afterAll(async () => {
  setBookingEventHook(null);
  const evs = [personalEvent, orgEvent].filter(Boolean);
  if (evs.length) await db.delete(schema.bookings).where(inArray(schema.bookings.eventTypeId, evs));
  if (evs.length) await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, evs));
  await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.organizationId, [orgA, orgB]));
  await db.delete(schema.organizations).where(inArray(schema.organizations.id, [orgA, orgB]));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await pool.end();
});

describe("who can open team activity", () => {
  it("owners, admins, managers and team leads see their team; plain members and outsiders see nothing", async () => {
    for (const u of [OWNER, ADMIN, MGR, TL]) expect((await listOversightOrgs(u)).map((o) => o.id), u).toEqual([orgA]);
    expect(await listOversightOrgs(M1)).toEqual([]);
    expect(await listOversightOrgs(OUTSIDER)).toEqual([]);
  });
  it("a plain member is refused (403); an outsider cannot even tell the team exists (404); a bad id is 404", async () => {
    expect(await code(getTeamOverview(M1, orgA))).toBe("FORBIDDEN");
    expect(await code(getTeamOverview(OUTSIDER, orgA))).toBe("NOT_FOUND");
    expect(await code(getTeamOverview(MGR, "not-a-uuid"))).toBe("NOT_FOUND");
  });
  it("a manager of one team cannot see another team", async () => {
    expect(await code(getTeamOverview(MGR, orgB))).toBe("NOT_FOUND");
    expect(await code(getMemberDetail(MGR, orgB, Y))).toBe("NOT_FOUND");
  });
});

describe("team overview", () => {
  it("a team lead sees themselves and their direct reports only", async () => {
    const o = await getTeamOverview(TL, orgA);
    expect(o.members.map((m) => m.userId).sort()).toEqual([TL, M1].sort());
    expect(await code(getMemberDetail(TL, orgA, M2))).toBe("FORBIDDEN");
    expect(await code(getMemberDetail(TL, orgA, OWNER))).toBe("FORBIDDEN");
  });
  it("shows everyone on the team with sign-ins and meetings, for a manager and (their reports) for a team lead", async () => {
    for (const viewer of [MGR, TL]) {
      const o = await getTeamOverview(viewer, orgA);
      if (viewer === MGR) expect(o.members.map((m) => m.userId).sort()).toEqual([OWNER, ADMIN, MGR, TL, M1, M2].sort());
      const m1 = o.members.find((m) => m.userId === M1)!;
      expect(m1).toMatchObject({ lastSignInMethod: "google", signIns30d: 2 });
      expect(m1.lastSignInAt).toBeInstanceOf(Date);
      expect(m1.meetingsNext7d).toBe(2); // the personal-link booking and the team booking
      expect(m1.nextMeetingAt).toBeInstanceOf(Date);
      const m2 = o.members.find((m) => m.userId === M2);
      if (m2) expect(m2).toMatchObject({ lastSignInAt: null, signIns30d: 0, meetingsNext7d: 0, nextMeetingAt: null });
      expect(o.recentSignIns.map((s) => s.userId)).toEqual([M1, M1]);
    }
  });
  it("lists the highest roles first", async () => {
    const o = await getTeamOverview(ADMIN, orgA);
    expect(o.members.map((m) => m.role)).toEqual(["owner", "admin", "manager", "team_lead", "member", "member"]);
  });
  it("does not include people from other teams", async () => {
    const o = await getTeamOverview(OWNER, orgA);
    expect(o.members.some((m) => m.userId === Y || m.userId === OWNER_B)).toBe(false);
  });
});

describe("member detail (meetings, schedule, sign-ins)", () => {
  it("shows meetings from personal AND team links, the weekly hours, calendar status and sign-in history", async () => {
    const d = await getMemberDetail(TL, orgA, M1);
    expect(d.member).toMatchObject({ name: "Mia Member", role: "member", loginMethods: ["google"] });
    expect(d.upcoming.map((b) => b.eventTitle).sort()).toEqual(["Mia personal call", "Team intro"]);
    const personal = d.upcoming.find((b) => b.id === m1Booking)!;
    expect(personal).toMatchObject({ inviteeName: "Pat Invitee", inviteeEmail: `pat-${run}@example.test`, status: "confirmed" });
    expect(d.schedules).toHaveLength(1);
    expect(d.schedules[0]!.weekly).toHaveLength(7);
    expect(d.schedules[0]!.weekly[1]!.weekday).toBe(1);
    expect(d.schedules[0]!.weekly[1]!.startTime).toMatch(/^08:00/);
    expect(d.schedules[0]!.weekly[1]!.endTime).toMatch(/^20:00/);
    expect(d.calendars).toEqual([{ provider: "google", email: "mia@example.test", status: "needs_reauth" }]);
    expect(d.signIns.map((s) => s.device).sort()).toEqual(["Chrome on Windows", "Safari on iOS"]);
  });
  it("never exposes credentials or tokens", async () => {
    const d = await getMemberDetail(MGR, orgA, M1);
    expect(JSON.stringify(d)).not.toMatch(/credentials|accessToken|refreshToken|token|"x"/i);
  });
  it("is refused for a plain member, and for someone who is not on the team", async () => {
    expect(await code(getMemberDetail(M2, orgA, M1))).toBe("FORBIDDEN");
    expect(await code(getMemberDetail(MGR, orgA, Y))).toBe("NOT_FOUND");
    expect(await code(getMemberDetail(MGR, orgA, "nobody"))).toBe("NOT_FOUND");
  });
  it("records who looked (audit log), so people can ask who viewed their data", async () => {
    await getMemberDetail(MGR, orgA, M2);
    const rows = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.organizationId, orgA), eq(schema.auditLogs.action, "oversight.member_viewed"), eq(schema.auditLogs.entityId, M2)));
    expect(rows.some((r) => r.actorId === MGR)).toBe(true);
  });
});

describe("Scheduled events and event types for the new roles", () => {
  it("managers and team leads see the team's bookings in Scheduled events; plain members only their own", async () => {
    const titles = async (u: string) => (await listScheduled(u, { tab: "upcoming" })).rows.map((r) => r.eventTitle);
    expect(await titles(MGR)).toContain("Team intro");
    expect(await titles(TL)).toContain("Team intro");
    expect(await titles(M2)).not.toContain("Team intro");
  });
  it("managers can use team event types like members do, but cannot create them (admin only)", async () => {
    await expect(getEventType({ userId: MGR }, orgEvent)).resolves.toBeTruthy();
    expect(await code(createEventType({ userId: MGR },{ organizationId: orgA, title: "Nope", slug: `nope-${run}`, durationMinutes: 30, locationType: "google_meet", hosts: [{ userId: MGR }] }))).toBe("FORBIDDEN");
  });
});

describe("assigning roles", () => {
  it("an admin can make someone a manager or team lead, but cannot grant admin or owner", async () => {
    await changeMemberRole(ADMIN, orgA, M2, "team_lead");
    await changeMemberRole(ADMIN, orgA, M2, "manager");
    expect(await code(changeMemberRole(ADMIN, orgA, M2, "admin"))).toBe("FORBIDDEN");
    expect(await code(changeMemberRole(ADMIN, orgA, M2, "owner"))).toBe("FORBIDDEN");
    await changeMemberRole(ADMIN, orgA, M2, "member");
  });
  it("an admin cannot change an owner or another admin", async () => {
    expect(await code(changeMemberRole(ADMIN, orgA, OWNER, "member"))).toBe("FORBIDDEN");
    expect(await code(changeMemberRole(ADMIN, orgA, ADMIN, "member"))).toBe("FORBIDDEN");
  });
  it("managers, team leads and members cannot change roles at all", async () => {
    for (const u of [MGR, TL, M1]) expect(await code(changeMemberRole(u, orgA, M2, "manager")), u).toBe("FORBIDDEN");
  });
  it("only admins and owners can invite someone as a manager; managers cannot", async () => {
    expect(await code(inviteMember(MGR, orgA, { email: `x1-${run}@example.test`, role: "member" }))).toBe("FORBIDDEN");
    await expect(inviteMember(ADMIN, orgA, { email: `x2-${run}@example.test`, role: "team_lead" })).resolves.toBeTruthy();
    expect(await code(inviteMember(ADMIN, orgA, { email: `x3-${run}@example.test`, role: "owner" }))).toBe("FORBIDDEN");
  });
  it("demoting a manager removes their access immediately", async () => {
    await changeMemberRole(OWNER, orgA, MGR, "member");
    expect(await code(getTeamOverview(MGR, orgA))).toBe("FORBIDDEN");
    expect(await listOversightOrgs(MGR)).toEqual([]);
    await changeMemberRole(OWNER, orgA, MGR, "manager");
    await expect(getTeamOverview(MGR, orgA)).resolves.toBeTruthy();
  });
});
