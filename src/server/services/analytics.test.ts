/** Integration tests against the dev Postgres with isolated fixtures (random suffix, cleaned up). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { exportAnalyticsCsv, getAnalytics, resolveRange } from "./analytics";

const run = randomUUID().slice(0, 8);
const U = `t_${run}_an`, U2 = `t_${run}_an2`, OTHER = `t_${run}_other`;
const ids = { ev1: "", ev2: "", evOther: "" };
const bookingIds: string[] = [];

const at = (iso: string) => new Date(iso);
type Status = typeof schema.bookings.$inferInsert["status"];
async function mkBooking(o: { host: string; ev: string; start: string; status?: Status; collective?: boolean; created?: string; resFrom?: string }) {
  const s = at(o.start);
  const [b] = await db.insert(schema.bookings).values({
    eventTypeId: o.ev, hostUserId: o.host, startsAt: s, endsAt: new Date(s.getTime() + 1_800_000),
    blockStart: s, blockEnd: new Date(s.getTime() + 1_800_000), status: o.status ?? "confirmed",
    inviteeTimeZone: "UTC", hostTimeZone: "UTC",
    externalEventIds: o.collective ? { collectiveOf: randomUUID() } : {},
    createdAt: o.created ? at(o.created) : undefined,
    rescheduledFromId: o.resFrom ?? null,
  }).returning();
  bookingIds.push(b!.id);
  return b!;
}

beforeAll(async () => {
  for (const id of [U, U2, OTHER]) await db.insert(schema.users).values({ id, name: `User ${id}`, email: `${id}@example.test`, timeZone: "UTC" });
  const mk = async (owner: string, slug: string, title: string) =>
    (await db.insert(schema.eventTypes).values({ ownerUserId: owner, slug: `${slug}-${run}`, title, durationMinutes: 30 }).returning())[0]!.id;
  ids.ev1 = await mk(U, "a", "Intro");
  ids.ev2 = await mk(U, "b", "Deep dive");
  ids.evOther = await mk(OTHER, "c", "Other");

  // 2031-03-03 is a Monday. Times chosen so UTC and Asia/Kolkata (+5:30) differ in weekday/hour.
  await mkBooking({ host: U, ev: ids.ev1, start: "2031-03-03T10:00:00Z", status: "completed" });          // Mon 10:00 UTC
  await mkBooking({ host: U, ev: ids.ev1, start: "2031-03-04T10:00:00Z", status: "completed" });          // Tue
  await mkBooking({ host: U, ev: ids.ev1, start: "2031-03-05T10:00:00Z", status: "cancelled" });          // Wed
  await mkBooking({ host: U, ev: ids.ev2, start: "2031-03-06T10:00:00Z", status: "no_show" });            // Thu
  await mkBooking({ host: U, ev: ids.ev2, start: "2031-03-07T10:00:00Z", status: "rescheduled" });        // Fri
  const paid = await mkBooking({ host: U, ev: ids.ev2, start: "2031-03-08T20:00:00Z", status: "confirmed" }); // Sat 20:00 UTC = Sun 01:30 IST
  // collective link row for the same meeting: must not be counted
  await mkBooking({ host: U, ev: ids.ev2, start: "2031-03-09T10:00:00Z", status: "confirmed", collective: true });
  // outside the range & other tenant
  await mkBooking({ host: U, ev: ids.ev1, start: "2031-05-01T10:00:00Z", status: "completed" });
  await mkBooking({ host: OTHER, ev: ids.evOther, start: "2031-03-03T10:00:00Z", status: "completed" });

  await db.insert(schema.payments).values([
    { bookingId: paid.id, provider: "test", providerOrderId: `o1_${run}`, amount: 5000, currency: "USD", status: "paid", createdAt: at("2031-03-08T12:00:00Z") },
    { bookingId: paid.id, provider: "test", providerOrderId: `o2_${run}`, amount: 700, currency: "EUR", status: "paid", createdAt: at("2031-03-08T12:00:00Z") },
    { bookingId: paid.id, provider: "test", providerOrderId: `o3_${run}`, amount: 999, currency: "USD", status: "failed", createdAt: at("2031-03-08T12:00:00Z") },
  ]);
  await db.insert(schema.pageViews).values([
    ...Array.from({ length: 10 }, () => ({ eventTypeId: ids.ev1, createdAt: at("2031-03-03T09:00:00Z") })),
    ...Array.from({ length: 3 }, () => ({ eventTypeId: ids.ev2, createdAt: at("2031-03-03T09:00:00Z") })),
    { eventTypeId: ids.evOther, createdAt: at("2031-03-03T09:00:00Z") },
    { eventTypeId: ids.ev1, createdAt: at("2031-01-01T09:00:00Z") }, // out of range
  ]);
  // bookings "made" in range (created_at): rows above default created_at = now (2026) so set explicitly for two
  await db.update(schema.bookings).set({ createdAt: at("2031-03-02T09:00:00Z") }).where(inArray(schema.bookings.id, bookingIds.slice(0, 2)));
});

afterAll(async () => {
  await db.delete(schema.pageViews).where(inArray(schema.pageViews.eventTypeId, Object.values(ids)));
  await db.delete(schema.payments).where(inArray(schema.payments.bookingId, bookingIds));
  await db.delete(schema.bookings).where(inArray(schema.bookings.id, bookingIds));
  await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, Object.values(ids)));
  await db.delete(schema.users).where(inArray(schema.users.id, [U, U2, OTHER]));
  await pool.end();
});

const range = { from: at("2031-03-01T00:00:00Z"), to: at("2031-04-01T00:00:00Z") };

describe("getAnalytics", () => {
  it("counts by status without double-counting collective rows or leaking other tenants", async () => {
    const r = await getAnalytics(U, { timeZone: "UTC", ...range });
    expect(r.totals.total).toBe(6);
    expect(r.totals.byStatus).toMatchObject({ completed: 2, cancelled: 1, no_show: 1, rescheduled: 1, confirmed: 1 });
    expect(r.totals.cancelled).toBe(1);
    expect(r.totals.rescheduled).toBe(1);
    expect(r.totals.completionRate).toBeCloseTo(2 / 4); // 2 / (2 completed + 1 no_show + 1 cancelled)
  });

  it("groups by event type and host", async () => {
    const r = await getAnalytics(U, { timeZone: "UTC", ...range });
    const e1 = r.byEventType.find((e) => e.id === ids.ev1)!, e2 = r.byEventType.find((e) => e.id === ids.ev2)!;
    expect(e1).toMatchObject({ total: 3, completed: 2, cancelled: 1 });
    expect(e2).toMatchObject({ total: 3, completed: 0, cancelled: 0 });
    expect(r.byHost).toHaveLength(1);
    expect(r.byHost[0]).toMatchObject({ id: U, total: 6 });
  });

  it("filters by event type and date range", async () => {
    const r = await getAnalytics(U, { timeZone: "UTC", ...range, eventTypeId: ids.ev1 });
    expect(r.totals.total).toBe(3);
    const wide = await getAnalytics(U, { timeZone: "UTC", from: at("2031-03-01T00:00:00Z"), to: at("2031-06-01T00:00:00Z") });
    expect(wide.totals.total).toBe(7);
    expect(wide.range.bucket).toBe("day");
  });

  it("popular weekdays/hours honour the viewer time zone and exclude non-meetings", async () => {
    const utc = await getAnalytics(U, { timeZone: "UTC", ...range });
    // scheduled = confirmed|completed|no_show: Mon, Tue, Thu, Sat(20:00)
    expect(utc.weekdays.map((w) => w.count)).toEqual([1, 1, 0, 1, 0, 1, 0]);
    expect(utc.hours[10]!.count).toBe(3);
    expect(utc.hours[20]!.count).toBe(1);
    const ist = await getAnalytics(U, { timeZone: "Asia/Kolkata", ...range });
    expect(ist.weekdays[5]!.count).toBe(0);
    expect(ist.weekdays[6]!.count).toBe(1); // Sat 20:00 UTC -> Sun 01:30 IST
    expect(ist.hours[1]!.count).toBe(1);
    expect(ist.hours[15]!.count).toBe(3); // 10:00 UTC -> 15:30
  });

  it("trend has a continuous daily axis with correct counts", async () => {
    const r = await getAnalytics(U, { timeZone: "UTC", ...range });
    expect(r.trend).toHaveLength(31);
    expect(r.trend[0]!.bucket).toBe("2031-03-01");
    const d = (day: string) => r.trend.find((t) => t.bucket === day)!;
    expect(d("2031-03-03").total).toBe(1);
    expect(d("2031-03-05").cancelled).toBe(1);
    expect(d("2031-03-09").total).toBe(0); // collective link row excluded
    expect(r.trend.reduce((s, t) => s + t.total, 0)).toBe(6);
  });

  it("revenue only from paid payments, per currency", async () => {
    const r = await getAnalytics(U, { timeZone: "UTC", ...range });
    expect(r.revenue).toEqual([
      { currency: "EUR", paid: 700, refunded: 0, payments: 1 },
      { currency: "USD", paid: 5000, refunded: 0, payments: 1 },
    ]);
    expect((await getAnalytics(OTHER, { timeZone: "UTC", ...range })).revenue).toEqual([]);
  });

  it("conversion: views vs bookings made, flagged as estimate", async () => {
    const r = await getAnalytics(U, { timeZone: "UTC", ...range });
    expect(r.conversion.estimate).toBe(true);
    expect(r.conversion.pageViews).toBe(13); // other tenant's view and out-of-range view excluded
    const c1 = r.conversion.perEventType.find((e) => e.id === ids.ev1)!;
    expect(c1.views).toBe(10);
    expect(c1.bookings).toBeGreaterThanOrEqual(0);
    expect(r.conversion.bookingsMade).toBe(2); // only the two rows with created_at in range
    expect(r.conversion.rate).toBeCloseTo(2 / 13);
  });

  it("empty account yields zeros, not fabricated data", async () => {
    const r = await getAnalytics(U2, { timeZone: "UTC", ...range });
    expect(r.totals.total).toBe(0);
    expect(r.totals.completionRate).toBeNull();
    expect(r.conversion.rate).toBeNull();
    expect(r.byEventType).toEqual([]);
    expect(r.revenue).toEqual([]);
  });

  it("rejects inverted and oversized ranges; csv exports", async () => {
    expect(() => resolveRange({ timeZone: "UTC", from: range.to, to: range.from })).toThrow();
    expect(() => resolveRange({ timeZone: "UTC", from: at("2020-01-01T00:00:00Z"), to: at("2031-01-01T00:00:00Z") })).toThrow();
    const csv = await exportAnalyticsCsv(U, { timeZone: "UTC", ...range });
    expect(csv).toContain("Event type,Intro,3,2,1");
    expect(csv).toContain("Revenue (minor units),USD,5000,0,1");
  });
});

