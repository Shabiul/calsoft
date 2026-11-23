/** Real-DB test of benching: meetings move to the manager, conflicts stay put, restore switches booking pages back on. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { getAvailableSlots } from "../scheduling/slots";
import { createBooking, setBookingEventHook } from "./booking";
import { benchMember, benchSweep, reactivateMember, restoreMember, setMemberManager, touchActivity } from "./bench";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `bn_${run}_${n}`;
setBookingEventHook(() => {});
const userIds: string[] = [], eventIds: string[] = [];
let orgId = "", LEAD = "", MGR = "", LEAVER = "", IDLE = "", OUT = "", leaverEvent = "", mgrEvent = "";

async function mkUser(n: string, name: string) {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name, email: `${id}@example.test`, timeZone: "UTC" });
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "w", timeZone: "UTC", isDefault: true }).returning();
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "08:00", endTime: "20:00" })));
  userIds.push(id);
  return id;
}
async function mkEvent(owner: string, slug: string) {
  const [e] = await db.insert(schema.eventTypes).values({ ownerUserId: owner, organizationId: orgId, slug: `${slug}-${run}`, title: `${slug} ${run}`, minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
  eventIds.push(e.id);
  return e.id;
}
const slots = (id: string) => getAvailableSlots({ eventTypeId: id, from: new Date(Date.now() + 3600_000), to: new Date(Date.now() + 3 * 86_400_000), inviteeTimeZone: "UTC" });
const inv = (n: string) => ({ name: `Inv ${n}`, email: `inv-${n}-${run}@example.test`, timeZone: "UTC" });
const host = async (bookingId: string) => (await db.select({ h: schema.bookings.hostUserId }).from(schema.bookings).where(eq(schema.bookings.id, bookingId)))[0]?.h;
const user = async (id: string) => (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0]!;

beforeAll(async () => {
  [LEAD, MGR, LEAVER, IDLE, OUT] = await Promise.all([mkUser("lead", "Lead"), mkUser("mgr", "Manager"), mkUser("leaver", "Leaver"), mkUser("idle", "Idle"), mkUser("out", "Outsider")]);
  const [org] = await db.insert(schema.organizations).values({ name: `B ${run}`, slug: `b-${run}` }).returning();
  orgId = org.id;
  await db.insert(schema.organizationMembers).values([
    { organizationId: orgId, userId: LEAD, role: "owner" }, { organizationId: orgId, userId: MGR, role: "member" },
    { organizationId: orgId, userId: LEAVER, role: "member" }, { organizationId: orgId, userId: IDLE, role: "member" },
  ]);
  leaverEvent = await mkEvent(LEAVER, "leaver");
  mgrEvent = await mkEvent(MGR, "mgr");
});

afterAll(async () => {
  setBookingEventHook(null);
  await db.delete(schema.bookings).where(inArray(schema.bookings.eventTypeId, eventIds));
  await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, eventIds));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await pool.end();
});

describe("bench", () => {
  it("only lets admins pick a manager, and only from the team", async () => {
    await expect(setMemberManager(MGR, orgId, LEAVER, MGR)).rejects.toMatchObject({ status: 403 });
    await expect(setMemberManager(LEAD, orgId, LEAVER, OUT)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setMemberManager(LEAD, orgId, LEAVER, LEAVER)).rejects.toMatchObject({ code: "VALIDATION" });
    await setMemberManager(LEAD, orgId, LEAVER, MGR);
  });

  let moved = "", clash = "";
  it("moves upcoming meetings to the manager, keeps ones that clash, pauses booking pages", async () => {
    const s = await slots(leaverEvent);
    moved = (await createBooking({ eventTypeId: leaverEvent, startsAt: s[1].startsAt, invitee: inv("a") })).booking.id;
    clash = (await createBooking({ eventTypeId: leaverEvent, startsAt: s[4].startsAt, invitee: inv("b") })).booking.id;
    await createBooking({ eventTypeId: mgrEvent, startsAt: s[4].startsAt, invitee: inv("c") }); // manager is busy then

    const r = await benchMember({ id: LEAVER, name: "Leaver", email: `${LEAVER}@example.test` });
    expect(r.find((x) => x.bookingId === moved)).toMatchObject({ moved: true, to: "Manager" });
    expect(r.find((x) => x.bookingId === clash)).toMatchObject({ moved: false });
    expect(r.find((x) => x.bookingId === clash)?.problem).toContain("already has a meeting");
    expect(await host(moved)).toBe(MGR);
    expect(await host(clash)).toBe(LEAVER);

    const u = await user(LEAVER);
    expect(u.status).toBe("benched");
    expect(u.bench?.pausedEventTypeIds).toEqual([leaverEvent]);
    const [et] = await db.select().from(schema.eventTypes).where(eq(schema.eventTypes.id, leaverEvent));
    expect(et.isActive).toBe(false);
  });

  it("signing in again restores the member and their booking page (meetings stay moved)", async () => {
    await touchActivity(LEAVER, "benched");
    const u = await user(LEAVER);
    expect(u.status).toBe("active");
    expect(u.bench).toBeNull();
    const [et] = await db.select().from(schema.eventTypes).where(eq(schema.eventTypes.id, leaverEvent));
    expect(et.isActive).toBe(true);
    expect(await host(moved)).toBe(MGR);
    await restoreMember(LEAVER, LEAD); // no-op when already active
  });

  it("a manager who left the team can no longer reactivate the member", async () => {
    await db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, MGR));
    try {
      await expect(reactivateMember(MGR, orgId, LEAVER)).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.insert(schema.organizationMembers).values({ organizationId: orgId, userId: MGR, role: "member", managerUserId: null });
    }
  });

  it("the sweep benches a member idle for 20 days and leaves recent ones alone", async () => {
    await db.update(schema.users).set({ lastActiveAt: new Date(Date.now() - 21 * 86_400_000) }).where(eq(schema.users.id, IDLE));
    await benchSweep();
    expect((await user(IDLE)).status).toBe("benched");
    expect((await user(MGR)).status).toBe("active");
  });
});
