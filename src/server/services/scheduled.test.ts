/** Real-DB tests for the scheduled-events read model and its mutations. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { AppError } from "../errors";
import { getAvailableSlots } from "../scheduling/slots";
import { createBooking, setBookingEventHook } from "./booking";
import {
  cancelScheduled, countScheduled, exportScheduledCsv, getBookingDetail, getRescheduleSlots, listScheduled,
  markScheduled, rescheduleScheduled, setHostNotes,
} from "./scheduled";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `sc_${run}_${n}`;
setBookingEventHook(() => {});
const userIds: string[] = [];
const eventIds: string[] = [];
let orgId = "";
let A: string, B: string, ADMIN: string, MEMBER: string, OUT: string;
let solo: string, coll: string;

async function mkUser(n: string, name = `User ${n}`) {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name, email: `${id}@example.test`, timeZone: "UTC" });
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "w", timeZone: "UTC", isDefault: true }).returning();
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "08:00", endTime: "20:00" })));
  userIds.push(id);
  return id;
}
const slots = (id: string) => getAvailableSlots({ eventTypeId: id, from: new Date(Date.now() + 3600_000), to: new Date(Date.now() + 3 * 86_400_000), inviteeTimeZone: "UTC" });
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? e.code : (e as Error).message; } };
const inv = (n: string, name = `Inv ${n}`) => ({ name, email: `inv-${n}-${run}@example.test`, timeZone: "UTC" });

beforeAll(async () => {
  [A, B, ADMIN, MEMBER, OUT] = await Promise.all([mkUser("a", "Alice Host"), mkUser("b", "Bob Host"), mkUser("admin"), mkUser("member"), mkUser("out")]);
  const [org] = await db.insert(schema.organizations).values({ name: `O ${run}`, slug: `o-${run}` }).returning();
  orgId = org.id;
  await db.insert(schema.organizationMembers).values([
    { organizationId: orgId, userId: A, role: "member" }, { organizationId: orgId, userId: B, role: "member" },
    { organizationId: orgId, userId: ADMIN, role: "admin" }, { organizationId: orgId, userId: MEMBER, role: "member" },
  ]);
  const [e1] = await db.insert(schema.eventTypes).values({ ownerUserId: A, slug: `solo-${run}`, title: `Solo ${run}`, minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
  const [e2] = await db.insert(schema.eventTypes).values({ organizationId: orgId, slug: `coll-${run}`, title: `Coll ${run}`, kind: "collective", minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
  await db.insert(schema.eventHosts).values([{ eventTypeId: e2.id, userId: A }, { eventTypeId: e2.id, userId: B }]);
  solo = e1.id; coll = e2.id; eventIds.push(solo, coll);
});

afterAll(async () => {
  setBookingEventHook(null);
  await db.delete(schema.bookings).where(inArray(schema.bookings.eventTypeId, eventIds));
  await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, eventIds));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await pool.end();
});

describe("scheduled events", () => {
  let soloBooking: string, collBooking: string;

  it("lists upcoming bookings for the host only, with invitee search and event filter", async () => {
    const s = await slots(solo);
    const r = await createBooking({ eventTypeId: solo, startsAt: s[2].startsAt, invitee: inv("one", "Zed =Cmd") });
    soloBooking = r.booking.id;
    const mine = await listScheduled(A, { tab: "upcoming" });
    expect(mine.rows.map((x) => x.id)).toContain(soloBooking);
    expect(mine.rows.find((x) => x.id === soloBooking)).toMatchObject({ inviteeName: "Zed =Cmd", hostName: "Alice Host" });
    expect((await listScheduled(OUT, { tab: "upcoming" })).rows).toHaveLength(0);
    expect((await listScheduled(A, { q: "zed" })).total).toBe(1);
    expect((await listScheduled(A, { q: `inv-one-${run}` })).total).toBe(1);
    expect((await listScheduled(A, { q: "100%_nomatch" })).total).toBe(0);
    expect((await listScheduled(A, { eventTypeId: solo })).total).toBe(1);
    expect((await listScheduled(A, { eventTypeId: coll })).total).toBe(0);
    expect((await listScheduled(A, { tab: "past" })).rows.map((x) => x.id)).not.toContain(soloBooking);
    expect((await countScheduled(A, {})).upcoming).toBeGreaterThanOrEqual(1);
  });

  it("shows a collective booking once (hides linked rows) to every host and to org admins only", async () => {
    const s = await slots(coll);
    const r = await createBooking({ eventTypeId: coll, startsAt: s[5].startsAt, invitee: inv("coll") });
    collBooking = r.booking.id;
    for (const u of [A, B, ADMIN]) {
      const l = await listScheduled(u, { eventTypeId: coll });
      expect(l.rows.map((x) => x.id)).toEqual([collBooking]);
      expect(l.rows[0].hostNames.sort()).toEqual(["Alice Host", "Bob Host"].sort());
    }
    expect((await listScheduled(MEMBER, { eventTypeId: coll })).total).toBe(0);
    expect((await listScheduled(OUT, { eventTypeId: coll })).total).toBe(0);
    expect((await listScheduled(ADMIN, { hostId: B })).rows.map((x) => x.id)).toEqual([collBooking]);
    // the co-host B can open it too
    expect((await getBookingDetail(B, collBooking)).id).toBe(collBooking);
  });

  it("detail includes invitee, history; outsiders get NOT_FOUND", async () => {
    const d = await getBookingDetail(A, soloBooking);
    expect(d.invitees[0].email).toBe(`inv-one-${run}@example.test`);
    expect(d.timeline.map((t) => t.type)).toContain("Booked");
    expect(await code(getBookingDetail(OUT, soloBooking))).toBe("NOT_FOUND");
    expect(await code(getBookingDetail(A, "not-a-uuid"))).toBe("NOT_FOUND");
    expect(await code(cancelScheduled(OUT, soloBooking))).toBe("NOT_FOUND");
    expect(await code(setHostNotes(OUT, soloBooking, "x"))).toBe("NOT_FOUND");
  });

  it("notes, reschedule, mark and cancel go through the booking service with history", async () => {
    await setHostNotes(A, soloBooking, "Bring the contract");
    expect((await getBookingDetail(A, soloBooking)).hostNotes).toBe("Bring the contract");
    const free = await getRescheduleSlots(A, soloBooking, new Date(Date.now() + 3600_000), new Date(Date.now() + 2 * 86_400_000));
    expect(free.length).toBeGreaterThan(3);
    const moved = await rescheduleScheduled(A, soloBooking, free[free.length - 1]);
    expect(moved.booking.id).not.toBe(soloBooking);
    expect((await getBookingDetail(A, soloBooking)).status).toBe("rescheduled");
    const d = await getBookingDetail(A, moved.booking.id);
    expect(d.rescheduledFromId).toBe(soloBooking);
    expect(d.timeline.map((t) => t.type)).toEqual(expect.arrayContaining(["Booked", "Rescheduled"]));
    expect((await markScheduled(A, moved.booking.id, "completed")).status).toBe("completed");
    expect((await markScheduled(A, moved.booking.id, "no_show")).status).toBe("no_show");
    expect((await listScheduled(A, { tab: "past" })).rows.map((x) => x.id)).toContain(moved.booking.id);
    expect(await code(cancelScheduled(A, moved.booking.id))).toBe("INVALID_STATE");

    const c = await cancelScheduled(ADMIN, collBooking, "Customer asked");
    expect(c.status).toBe("cancelled");
    const cancelled = await listScheduled(A, { tab: "cancelled", eventTypeId: coll });
    expect(cancelled.rows.map((x) => x.id)).toEqual([collBooking]);
    expect((await getBookingDetail(A, collBooking)).cancelReason).toBe("Customer asked");
  });

  it("exports CSV with escaping and formula-injection protection", async () => {
    const s = await slots(solo);
    await createBooking({ eventTypeId: solo, startsAt: s[8].startsAt, invitee: { ...inv("csv", '=HYPERLINK("x"), "q"'), email: `csv-${run}@example.test` } });
    const csv = await exportScheduledCsv(A, { tab: "upcoming", q: `csv-${run}` });
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("Invitee email");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x""), ""q"""`);
  });
});
