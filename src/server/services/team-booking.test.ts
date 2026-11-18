/**
 * Real-DB tests: org-owned team event types (round robin, collective, group) booked through createBooking,
 * plus personal event types that have no event_host rows. Isolated fixtures, cleaned up afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { AppError } from "../errors";
import { getAvailableSlots } from "../scheduling/slots";
import { cancelBooking, createBooking, rescheduleBooking, setBookingEventHook } from "./booking";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `tb_${run}_${n}`;
setBookingEventHook(() => {});

const userIds: string[] = [];
const eventIds: string[] = [];
let orgId = "";

async function mkUser(n: string) {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name: `User ${n}`, email: `${id}@example.test`, timeZone: "UTC" });
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "Work", timeZone: "UTC", isDefault: true }).returning();
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "08:00", endTime: "20:00" })));
  userIds.push(id);
  return id;
}
async function mkOrgEvent(name: string, o: Partial<typeof schema.eventTypes.$inferInsert>, hosts: { userId: string; priority?: number; weight?: number; isRequired?: boolean }[]) {
  const [e] = await db.insert(schema.eventTypes).values({
    organizationId: orgId, slug: `${name}-${run}`, title: name, durationMinutes: 30, minNoticeMinutes: 0, maxHorizonDays: 30, ...o,
  }).returning();
  await db.insert(schema.eventHosts).values(hosts.map((h) => ({ eventTypeId: e.id, userId: h.userId, priority: h.priority ?? 0, weight: h.weight ?? 1, isRequired: h.isRequired ?? true })));
  eventIds.push(e.id);
  return e.id;
}
const slots = (eventId: string, days = 3) =>
  getAvailableSlots({ eventTypeId: eventId, from: new Date(Date.now() + 3600_000), to: new Date(Date.now() + days * 86_400_000), inviteeTimeZone: "UTC" });
const inv = (n: string) => ({ name: `Inv ${n}`, email: `inv-${n}-${run}@example.test`, timeZone: "UTC" });
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? e.code : (e as Error).message; } };
const rows = (eventId: string) => db.select().from(schema.bookings).where(and(eq(schema.bookings.eventTypeId, eventId), inArray(schema.bookings.status, ["confirmed", "pending_payment"])));

let A: string, B: string, C: string, D: string, SOLO: string;

beforeAll(async () => {
  [A, B, C, D, SOLO] = await Promise.all(["a", "b", "c", "d", "solo"].map(mkUser));
  const [org] = await db.insert(schema.organizations).values({ name: `Org ${run}`, slug: `org-${run}` }).returning();
  orgId = org.id;
  await db.insert(schema.organizationMembers).values([A, B, C, D].map((userId) => ({ organizationId: orgId, userId, role: "member" as const })));
});

afterAll(async () => {
  setBookingEventHook(null);
  if (eventIds.length) {
    await db.delete(schema.bookings).where(inArray(schema.bookings.eventTypeId, eventIds));
    await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, eventIds));
  }
  await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  await db.delete(schema.blockedTimes).where(inArray(schema.blockedTimes.userId, userIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await pool.end();
});

describe("personal event type without event_host rows", () => {
  it("treats the owner as the host for slots and bookings", async () => {
    const [e] = await db.insert(schema.eventTypes).values({ ownerUserId: SOLO, slug: `solo-${run}`, title: "solo", minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
    eventIds.push(e.id);
    const s = await slots(e.id);
    expect(s.length).toBeGreaterThan(5);
    expect(s.every((x) => x.hostUserId === SOLO)).toBe(true);
    const r = await createBooking({ eventTypeId: e.id, startsAt: s[0].startsAt, invitee: inv("solo") });
    expect(r.booking.hostUserId).toBe(SOLO);
    expect(await code(createBooking({ eventTypeId: e.id, startsAt: s[0].startsAt, invitee: inv("solo2") }))).toBe("SLOT_UNAVAILABLE");
  });
});

describe("round robin (org)", () => {
  it("respects priority: lower number first, next host only when the first is busy", async () => {
    const id = await mkOrgEvent("rr-prio", { kind: "round_robin" }, [{ userId: A, priority: 0 }, { userId: B, priority: 1 }]);
    const t = (await slots(id))[3].startsAt;
    const b1 = await createBooking({ eventTypeId: id, startsAt: t, invitee: inv("p1") });
    const b2 = await createBooking({ eventTypeId: id, startsAt: t, invitee: inv("p2") });
    expect(b1.booking.hostUserId).toBe(A);
    expect(b2.booking.hostUserId).toBe(B);
    expect(b1.booking.organizationId).toBe(orgId);
    expect(await code(createBooking({ eventTypeId: id, startsAt: t, invitee: inv("p3") }))).toBe("SLOT_UNAVAILABLE");
    expect((await slots(id)).some((s) => s.startsAt === t)).toBe(false);
  });

  it("distributes by weight (2:1 over six distinct slots)", async () => {
    const id = await mkOrgEvent("rr-weight", { kind: "round_robin" }, [{ userId: A, weight: 2 }, { userId: B, weight: 1 }]);
    const all = await slots(id);
    const picks = [0, 2, 4, 6, 8, 10].map((i) => all[i].startsAt);
    for (const [i, t] of picks.entries()) await createBooking({ eventTypeId: id, startsAt: t, invitee: inv(`w${i}`) });
    const rs = await rows(id);
    expect(rs.filter((r) => r.hostUserId === A).length).toBe(4);
    expect(rs.filter((r) => r.hostUserId === B).length).toBe(2);
  });

  it("distributes fairly with equal weights", async () => {
    const id = await mkOrgEvent("rr-fair", { kind: "round_robin" }, [{ userId: C }, { userId: D }]);
    const all = await slots(id);
    for (let i = 0; i < 8; i++) await createBooking({ eventTypeId: id, startsAt: all[i * 2].startsAt, invitee: inv(`f${i}`) });
    const rs = await rows(id);
    expect(rs.filter((r) => r.hostUserId === C).length).toBe(4);
    expect(rs.filter((r) => r.hostUserId === D).length).toBe(4);
  });

  it("offers a slot when only one host is free and books that host", async () => {
    const id = await mkOrgEvent("rr-one-free", { kind: "round_robin" }, [{ userId: A, priority: 0 }, { userId: B, priority: 1 }]);
    const all = await slots(id);
    const t = all[5];
    expect(t.hostUserId).toBe(A);
    await db.insert(schema.blockedTimes).values({ userId: A, startsAt: new Date(t.startsAt), endsAt: new Date(new Date(t.startsAt).getTime() + 30 * 60_000) });
    const after = (await slots(id)).find((s) => s.startsAt === t.startsAt);
    expect(after?.hostUserId).toBe(B);
    expect(after?.hostUserIds).toEqual([B]);
    const r = await createBooking({ eventTypeId: id, startsAt: t.startsAt, invitee: inv("one") });
    expect(r.booking.hostUserId).toBe(B);
  });

  it("reschedule keeps the same host when still free and cancel frees the slot", async () => {
    const id = await mkOrgEvent("rr-resched", { kind: "round_robin" }, [{ userId: C, priority: 0 }, { userId: D, priority: 1 }]);
    const all = await slots(id);
    const r = await createBooking({ eventTypeId: id, startsAt: all[1].startsAt, invitee: inv("rs") });
    const moved = await rescheduleBooking({ bookingId: r.booking.id, newStartsAt: all[9].startsAt });
    expect(moved.booking.hostUserId).toBe(r.booking.hostUserId);
    expect((await rows(id)).length).toBe(1);
    await cancelBooking({ bookingId: moved.booking.id });
    expect((await rows(id)).length).toBe(0);
  });
});

describe("collective (org)", () => {
  it("only offers times when ALL required hosts are free and books one row per host", async () => {
    const id = await mkOrgEvent("coll", { kind: "collective" }, [{ userId: A }, { userId: B }, { userId: C, isRequired: false }]);
    const all = await slots(id);
    const t = all[4].startsAt;
    await db.insert(schema.blockedTimes).values({ userId: B, startsAt: new Date(t), endsAt: new Date(new Date(t).getTime() + 30 * 60_000) });
    expect((await slots(id)).some((s) => s.startsAt === t)).toBe(false);
    expect(await code(createBooking({ eventTypeId: id, startsAt: t, invitee: inv("c0") }))).toBe("SLOT_UNAVAILABLE");

    const t2 = all[8].startsAt;
    const r = await createBooking({ eventTypeId: id, startsAt: t2, invitee: inv("c1") });
    const rs = await rows(id);
    expect(rs.map((x) => x.hostUserId).sort()).toEqual([A, B].sort()); // optional host C is not booked
    expect(rs.filter((x) => (x.externalEventIds as Record<string, string>).collectiveOf === r.booking.id).length).toBe(1);
    // each required host is now busy for this slot in their own calendar
    expect((await slots(id)).some((s) => s.startsAt === t2)).toBe(false);
    await cancelBooking({ bookingId: r.booking.id });
    expect((await slots(id)).some((s) => s.startsAt === t2)).toBe(true);
  });

  it("a host's personal booking elsewhere blocks the collective slot", async () => {
    const [pe] = await db.insert(schema.eventTypes).values({ ownerUserId: A, slug: `pers-${run}`, title: "p", minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
    eventIds.push(pe.id);
    const id = await mkOrgEvent("coll2", { kind: "collective" }, [{ userId: A }, { userId: D }]);
    const t = (await slots(id))[6].startsAt;
    await createBooking({ eventTypeId: pe.id, startsAt: t, invitee: inv("pp") });
    expect((await slots(id)).some((s) => s.startsAt === t)).toBe(false);
  });
});

describe("group (org)", () => {
  it("enforces capacity and rejects duplicate registrations", async () => {
    const id = await mkOrgEvent("grp", { kind: "group", capacity: 2 }, [{ userId: D }]);
    const s = await slots(id);
    const t = s[2].startsAt;
    expect(s[2].spotsLeft).toBe(2);
    await createBooking({ eventTypeId: id, startsAt: t, invitee: inv("g1") });
    expect((await slots(id)).find((x) => x.startsAt === t)?.spotsLeft).toBe(1);
    expect(await code(createBooking({ eventTypeId: id, startsAt: t, invitee: inv("g1") }))).toBe("ALREADY_BOOKED");
    await createBooking({ eventTypeId: id, startsAt: t, invitee: inv("g2") });
    expect(await code(createBooking({ eventTypeId: id, startsAt: t, invitee: inv("g3") }))).toBe("SLOT_UNAVAILABLE");
    expect((await slots(id)).some((x) => x.startsAt === t)).toBe(false);
    const rs = await rows(id);
    expect(rs.length).toBe(2);
    expect(rs.every((r) => r.exclusiveSlot === false && r.organizationId === orgId)).toBe(true);
  });

  it("concurrent registrations never exceed capacity", async () => {
    const id = await mkOrgEvent("grp-conc", { kind: "group", capacity: 3 }, [{ userId: C }]);
    const t = (await slots(id))[12].startsAt;
    const res = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createBooking({ eventTypeId: id, startsAt: t, invitee: inv(`gc${i}`) })));
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(3);
    expect((await rows(id)).length).toBe(3);
  });
});
