/**
 * Integration tests (real dev Postgres, isolated random fixtures) for:
 *  - requires-confirmation bookings (pending_confirmation holds the slot; approve / decline / expiry)
 *  - recurring series (atomic validation + reservation, DST/month-end arithmetic, cancel one vs series, reschedule one)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { AppError } from "../errors";
import { getAvailableSlots } from "../scheduling/slots";
import { seriesStarts } from "../scheduling/recurrence";
import { createRemindersForBooking, expireUnansweredRequests } from "../notifications/reminders";
import { handleNotificationEvent } from "../notifications/events";
import {
  approveBooking, cancelBooking, createBooking, declineBooking, markBooking, previewSeries, rescheduleBooking, setBookingEventHook,
  type BookingEventExtra,
} from "./booking";
import { DateTime } from "luxon";
import { approveScheduled, declineScheduled, getBookingDetail, listScheduled } from "./scheduled";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `ap_${run}_${n}`;
const hookEvents: { type: string; id: string; extra?: BookingEventExtra }[] = [];
setBookingEventHook((type, id, extra) => { hookEvents.push({ type, id, extra }); });

const userIds: string[] = [];
const eventIds: string[] = [];
const NY = "America/New_York";
const NOW = new Date("2026-01-05T12:00:00Z"); // fixed clock for the date-exact series tests

async function mkUser(n: string, tz = "UTC") {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name: `User ${n}`, email: `${id}@example.test`, timeZone: tz });
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "Work", timeZone: tz, isDefault: true }).returning();
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "08:00", endTime: "20:00" })));
  userIds.push(id);
  return id;
}
async function mkEvent(name: string, owner: string, o: Partial<typeof schema.eventTypes.$inferInsert> = {}) {
  const [e] = await db.insert(schema.eventTypes).values({
    ownerUserId: owner, slug: `${name}-${run}`, title: name, durationMinutes: 30, minNoticeMinutes: 0, maxHorizonDays: 30, ...o,
  }).returning();
  eventIds.push(e.id);
  return e.id;
}
const invitee = (n: string) => ({ name: `Inv ${n}`, email: `inv-${n}-${run}@example.test`, timeZone: "Europe/London" });
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? `${e.code}:${e.status}` : (e as Error).message; } };
const rowsOf = (eventId: string) => db.select().from(schema.bookings).where(eq(schema.bookings.eventTypeId, eventId)).orderBy(schema.bookings.startsAt);
/** Future slots (real clock) for the plain-UTC fixtures; at least `minAheadMs` away. */
async function freeSlots(eventId: string, minAheadMs = 3 * 3600_000) {
  const all = await getAvailableSlots({ eventTypeId: eventId, from: new Date(), to: new Date(Date.now() + 9 * 86_400_000), inviteeTimeZone: "UTC" });
  return all.filter((s) => new Date(s.startsAt).getTime() > Date.now() + minAheadMs).map((s) => s.startsAt);
}
const localHM = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz }).toFormat("yyyy-MM-dd HH:mm");

let A: string, B: string, N: string, M: string;
let reqEvent: string, plainEvent: string;

beforeAll(async () => {
  [A, B, N, M] = await Promise.all([mkUser("a"), mkUser("b"), mkUser("ny", NY), mkUser("ny2", NY)]);
  reqEvent = await mkEvent("req", A, { requiresConfirmation: true, reminders: [60] });
  plainEvent = await mkEvent("plain", B);
});

afterAll(async () => {
  setBookingEventHook(null);
  if (eventIds.length) {
    const bs = await db.select({ id: schema.bookings.id }).from(schema.bookings).where(inArray(schema.bookings.eventTypeId, eventIds));
    if (bs.length) {
      await db.delete(schema.notificationLogs).where(inArray(schema.notificationLogs.bookingId, bs.map((b) => b.id)));
      await db.delete(schema.bookings).where(inArray(schema.bookings.id, bs.map((b) => b.id)));
    }
    await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, eventIds));
  }
  if (userIds.length) {
    await db.delete(schema.blockedTimes).where(inArray(schema.blockedTimes.userId, userIds));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  }
  await pool.end();
});

describe("requires confirmation: approve / decline", () => {
  it("creates pending_confirmation, holds the slot, and a second request for it fails", async () => {
    const [s0] = await freeSlots(reqEvent);
    const r = await createBooking({ eventTypeId: reqEvent, startsAt: s0, invitee: invitee("p1") });
    expect(r.booking.status).toBe("pending_confirmation");
    expect(r.booking.holdExpiresAt).toBeNull();
    expect(hookEvents.some((e) => e.type === "booking.created" && e.id === r.booking.id)).toBe(true);
    // not offered any more
    expect(await freeSlots(reqEvent)).not.toContain(s0);
    expect(await code(createBooking({ eventTypeId: reqEvent, startsAt: s0, invitee: invitee("p2") }))).toBe("SLOT_UNAVAILABLE:409");
    // DB-level backstop: the exclusion constraint also covers pending_confirmation
    let pgErr: string | undefined;
    try {
      await pool.query(`insert into booking (id,event_type_id,host_user_id,starts_at,ends_at,block_start,block_end,status,invitee_time_zone,host_time_zone)
        select gen_random_uuid(),event_type_id,host_user_id,starts_at,ends_at,block_start,block_end,'confirmed','UTC','UTC' from booking where id=$1`, [r.booking.id]);
    } catch (e) { pgErr = (e as { code?: string }).code; }
    expect(pgErr).toBe("23P01");
  });

  it("approve confirms (idempotently) and emits booking.confirmed with approved=true; reminders only after approval", async () => {
    const slots = await freeSlots(reqEvent);
    const r = await createBooking({ eventTypeId: reqEvent, startsAt: slots[4], invitee: invitee("ap") });
    expect(await createRemindersForBooking(r.booking.id)).toBe(0); // pending: no reminders
    const out = await approveBooking({ bookingId: r.booking.id, actorId: A });
    expect(out.status).toBe("confirmed");
    const ev = hookEvents.filter((e) => e.type === "booking.confirmed" && e.id === r.booking.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].extra?.approved).toBe(true);
    expect((await approveBooking({ bookingId: r.booking.id })).status).toBe("confirmed"); // idempotent, no second event
    expect(hookEvents.filter((e) => e.type === "booking.confirmed" && e.id === r.booking.id)).toHaveLength(1);
    expect(await createRemindersForBooking(r.booking.id)).toBe(1);
    const log = await db.select().from(schema.bookingEvents).where(and(eq(schema.bookingEvents.bookingId, r.booking.id), eq(schema.bookingEvents.type, "approved")));
    expect(log).toHaveLength(1);
    // a confirmed booking cannot be declined
    expect(await code(declineBooking({ bookingId: r.booking.id }))).toBe("INVALID_STATE:409");
  });

  it("decline releases the slot immediately and the invitee is not refused a fresh booking", async () => {
    const slots = await freeSlots(reqEvent);
    const s = slots[8];
    const r = await createBooking({ eventTypeId: reqEvent, startsAt: s, invitee: invitee("dc") });
    expect(await freeSlots(reqEvent)).not.toContain(s);
    const out = await declineBooking({ bookingId: r.booking.id, reason: "Not available", actorId: A });
    expect(out.status).toBe("cancelled");
    expect(out.cancelledBy).toBe("host");
    expect(out.cancelReason).toBe("Not available");
    const ev = hookEvents.filter((e) => e.type === "booking.declined" && e.id === r.booking.id);
    expect(ev).toHaveLength(1);
    expect(await freeSlots(reqEvent)).toContain(s);
    expect(await code(approveBooking({ bookingId: r.booking.id }))).toBe("INVALID_STATE:409");
    const again = await createBooking({ eventTypeId: reqEvent, startsAt: s, invitee: invitee("dc2") });
    expect(again.booking.status).toBe("pending_confirmation");
  });

  it("concurrent requests for the same pending slot: exactly one wins", async () => {
    const slots = await freeSlots(reqEvent);
    const s = slots[12];
    const res = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createBooking({ eventTypeId: reqEvent, startsAt: s, invitee: invitee(`cc${i}`) })));
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of res) if (x.status === "rejected") expect((x.reason as AppError).code).toBe("SLOT_UNAVAILABLE");
    const held = (await rowsOf(reqEvent)).filter((b) => b.startsAt.toISOString() === s && b.status === "pending_confirmation");
    expect(held).toHaveLength(1);
  });

  it("an invitee can withdraw a pending request via the manage token (slot released)", async () => {
    const slots = await freeSlots(reqEvent);
    const r = await createBooking({ eventTypeId: reqEvent, startsAt: slots[16], invitee: invitee("wd") });
    const c = await cancelBooking({ manageToken: r.manageToken!, actor: "invitee" });
    expect(c.status).toBe("cancelled");
    expect(await freeSlots(reqEvent)).toContain(slots[16]);
  });

  it("paid + requires confirmation: pay first (pending_payment), then the paid booking becomes a request", async () => {
    const e = await mkEvent("paidreq", A, { requiresConfirmation: true, priceAmount: 5000, priceCurrency: "USD", paymentProvider: "stripe" });
    const slots = await freeSlots(e);
    const r = await createBooking({ eventTypeId: e, startsAt: slots[20], invitee: invitee("pr") });
    expect(r.booking.status).toBe("pending_payment");
    const paid = await markBooking({ bookingId: r.booking.id, status: "confirmed", actor: "system" });
    expect(paid.status).toBe("pending_confirmation");
    const out = await approveBooking({ bookingId: r.booking.id });
    expect(out.status).toBe("confirmed");
  });

  it("unanswered requests whose start has passed expire and release the slot", async () => {
    const slots = await freeSlots(reqEvent);
    const r = await createBooking({ eventTypeId: reqEvent, startsAt: slots[24], invitee: invitee("ex") });
    await pool.query(`update booking set starts_at = now() - interval '2 hours', ends_at = now() - interval '90 minutes',
      block_start = now() - interval '2 hours', block_end = now() - interval '90 minutes' where id = $1`, [r.booking.id]);
    const expired = await expireUnansweredRequests(new Date());
    expect(expired.map((x) => x.id)).toContain(r.booking.id);
    const [row] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, r.booking.id));
    expect(row.status).toBe("expired");
    expect(row.cancelReason).toMatch(/did not respond/);
  });

  it("notifications: request emails at creation, 'approved' email (not 'confirmation') after approval", async () => {
    const slots = await freeSlots(reqEvent);
    const r = await createBooking({ eventTypeId: reqEvent, startsAt: slots[28], invitee: invitee("nt") });
    const mk = (type: "booking.created" | "booking.confirmed", extra: Record<string, unknown> = {}) =>
      ({ eventId: randomUUID(), type, payload: { bookingId: r.booking.id, manageToken: r.manageToken!, ...extra }, at: new Date().toISOString() });
    await handleNotificationEvent(mk("booking.created"));
    let kinds = (await db.select().from(schema.notificationLogs).where(eq(schema.notificationLogs.bookingId, r.booking.id))).map((l) => l.kind).sort();
    expect(kinds).toEqual(["approval_request", "request_received"]);
    expect(await db.select().from(schema.reminders).where(eq(schema.reminders.bookingId, r.booking.id))).toHaveLength(0);
    await handleNotificationEvent(mk("booking.created")); // replay: deduped
    expect(await db.select().from(schema.notificationLogs).where(eq(schema.notificationLogs.bookingId, r.booking.id))).toHaveLength(2);

    await approveBooking({ bookingId: r.booking.id });
    await handleNotificationEvent(mk("booking.confirmed", { approved: true }));
    kinds = (await db.select().from(schema.notificationLogs).where(eq(schema.notificationLogs.bookingId, r.booking.id))).map((l) => l.kind).sort();
    expect(kinds).toEqual(["approval_request", "approved", "request_received"]);
    expect(await db.select().from(schema.reminders).where(eq(schema.reminders.bookingId, r.booking.id))).toHaveLength(1);
  });
});

describe("scheduled events (dashboard) approval", () => {
  it("only the host (or an authorised teammate) can approve/decline; the list and drawer reflect the pending state", async () => {
    const slots = await freeSlots(reqEvent);
    const r = await createBooking({ eventTypeId: reqEvent, startsAt: slots[32], invitee: invitee("sc") });
    expect(await code(approveScheduled(B, r.booking.id))).toBe("NOT_FOUND:404");
    expect(await code(declineScheduled(B, r.booking.id))).toBe("NOT_FOUND:404");
    const list = await listScheduled(A, { tab: "upcoming", eventTypeId: reqEvent, pageSize: 100 });
    expect(list.rows.find((x) => x.id === r.booking.id)?.status).toBe("pending_confirmation");
    const d = await getBookingDetail(A, r.booking.id);
    expect(d.canDecide).toBe(true);
    expect(d.canCancel).toBe(true);
    await approveScheduled(A, r.booking.id);
    expect((await getBookingDetail(A, r.booking.id)).canDecide).toBe(false);
    expect((await getBookingDetail(A, r.booking.id)).timeline.map((t) => t.type)).toContain("Approved");
  });
});

describe("recurrence arithmetic (pure)", () => {
  it("weekly keeps the local wall-clock time across both DST changes", () => {
    const spring = seriesStarts(new Date("2026-03-02T14:00:00Z"), NY, { count: 4, interval: "week" });
    expect(spring.map((d) => localHM(d, NY))).toEqual(["2026-03-02 09:00", "2026-03-09 09:00", "2026-03-16 09:00", "2026-03-23 09:00"]);
    expect(spring.map((d) => d.getUTCHours())).toEqual([14, 13, 13, 13]);
    const fall = seriesStarts(new Date("2026-10-26T13:00:00Z"), NY, { count: 3, interval: "week" });
    expect(fall.map((d) => localHM(d, NY))).toEqual(["2026-10-26 09:00", "2026-11-02 09:00", "2026-11-09 09:00"]);
    expect(fall.map((d) => d.getUTCHours())).toEqual([13, 14, 14]);
  });
  it("monthly keeps the day and clamps to the end of short months without drifting", () => {
    const m = seriesStarts(new Date("2026-01-31T14:00:00Z"), NY, { count: 5, interval: "month" });
    expect(m.map((d) => localHM(d, NY))).toEqual(["2026-01-31 09:00", "2026-02-28 09:00", "2026-03-31 09:00", "2026-04-30 09:00", "2026-05-31 09:00"]);
  });
});

describe("recurring series", () => {
  const nyBook = (eventId: string, startsAt: string, n: string, extra: Partial<Parameters<typeof createBooking>[0]> = {}) =>
    createBooking({ eventTypeId: eventId, startsAt, invitee: invitee(n), ...extra }, { now: NOW });

  it("books N weekly sessions atomically: one series id, own row/token each, 09:00 local across spring DST", async () => {
    const e = await mkEvent("wk", N, { recurrence: { count: 4, interval: "week" }, maxHorizonDays: 365 });
    const r = await nyBook(e, "2026-03-02T14:00:00Z", "wk1", { idempotencyKey: `wk-${run}` });
    expect(r.series).toHaveLength(4);
    const rows = await rowsOf(e);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((x) => x.seriesId)).size).toBe(1);
    expect(rows[0].seriesId).toBeTruthy();
    expect(rows.every((x) => x.status === "confirmed")).toBe(true);
    expect(rows.map((x) => localHM(x.startsAt, NY))).toEqual(["2026-03-02 09:00", "2026-03-09 09:00", "2026-03-16 09:00", "2026-03-23 09:00"]);
    expect(new Set(r.series!.map((s) => s.manageToken)).size).toBe(4);
    // one invitee row per occurrence
    const inv = await db.select().from(schema.invitees).where(inArray(schema.invitees.bookingId, rows.map((x) => x.id)));
    expect(inv).toHaveLength(4);
    // one booking.created event per occurrence, with series positions
    const evs = hookEvents.filter((x) => x.type === "booking.created" && rows.some((b) => b.id === x.id));
    expect(evs.map((x) => x.extra?.seriesIndex).sort()).toEqual([0, 1, 2, 3]);
    // idempotency covers the series: replay returns the same series and creates nothing
    const again = await nyBook(e, "2026-03-02T14:00:00Z", "wk1", { idempotencyKey: `wk-${run}` });
    expect(again.idempotentReplay).toBe(true);
    expect(again.series?.map((s) => s.booking.id)).toEqual(rows.map((x) => x.id));
    expect(await rowsOf(e)).toHaveLength(4);
  });

  it("keeps 09:00 local across the November DST change", async () => {
    const e = await mkEvent("fall", M, { recurrence: { count: 3, interval: "week" }, maxHorizonDays: 365 });
    await nyBook(e, "2026-10-26T13:00:00Z", "fall");
    const rows = await rowsOf(e);
    expect(rows.map((x) => localHM(x.startsAt, NY))).toEqual(["2026-10-26 09:00", "2026-11-02 09:00", "2026-11-09 09:00"]);
    expect(rows.map((x) => x.startsAt.getUTCHours())).toEqual([13, 14, 14]);
  });

  it("monthly series clamps month-end (Jan 31 -> Feb 28 -> Mar 31)", async () => {
    const u = await mkUser("nym", NY);
    const e = await mkEvent("mo", u, { recurrence: { count: 3, interval: "month" }, maxHorizonDays: 365 });
    await nyBook(e, "2026-01-31T14:00:00Z", "mo");
    expect((await rowsOf(e)).map((x) => localHM(x.startsAt, NY))).toEqual(["2026-01-31 09:00", "2026-02-28 09:00", "2026-03-31 09:00"]);
  });

  it("all-or-nothing: occurrence 3 blocked by another booking => SLOT_UNAVAILABLE naming the date, nothing reserved", async () => {
    const u = await mkUser("nyb", NY);
    const e = await mkEvent("aon", u, { recurrence: { count: 4, interval: "week" }, maxHorizonDays: 365 });
    const single = await mkEvent("aon-single", u, { maxHorizonDays: 365 });
    await nyBook(single, "2026-03-16T13:00:00Z", "blocker"); // 3rd occurrence (EDT) of a Mar 2 start
    let err: AppError | undefined;
    try { await nyBook(e, "2026-03-02T14:00:00Z", "aon"); } catch (x) { err = x as AppError; }
    expect(err?.code).toBe("SLOT_UNAVAILABLE");
    expect(err?.status).toBe(409);
    expect(err?.details).toMatchObject({ failedOccurrence: 3, failedStartsAt: "2026-03-16T13:00:00.000Z", count: 4 });
    expect(await rowsOf(e)).toHaveLength(0);
    // also blocked time off
    const u2 = await mkUser("nyc", NY);
    const e2 = await mkEvent("aon2", u2, { recurrence: { count: 3, interval: "week" }, maxHorizonDays: 365 });
    await db.insert(schema.blockedTimes).values({ userId: u2, startsAt: new Date("2026-03-09T12:00:00Z"), endsAt: new Date("2026-03-09T16:00:00Z") });
    const err2 = await nyBook(e2, "2026-03-02T14:00:00Z", "aon2").catch((x) => x as AppError);
    expect((err2 as AppError).details).toMatchObject({ failedOccurrence: 2 });
    expect(await rowsOf(e2)).toHaveLength(0);
    // preview flags the failing date
    const pv = await previewSeries(e, "2026-03-02T14:00:00Z", { now: NOW });
    expect(pv?.occurrences.map((o) => o.available)).toEqual([true, true, false, true]);
  });

  it("series beyond the booking horizon still books (only the first session is horizon-bound)", async () => {
    const u = await mkUser("nyh", NY);
    const e = await mkEvent("hz", u, { recurrence: { count: 8, interval: "week" }, maxHorizonDays: 14 });
    const r = await nyBook(e, "2026-01-12T14:00:00Z", "hz");
    expect(r.series).toHaveLength(8);
  });

  it("cancel ONE occurrence leaves the rest; cancel SERIES cancels every remaining future session", async () => {
    const u = await mkUser("nyd", NY);
    const e = await mkEvent("cx", u, { recurrence: { count: 4, interval: "week" }, maxHorizonDays: 365 });
    const r = await nyBook(e, "2026-03-02T14:00:00Z", "cx");
    const [o1, o2, o3, o4] = r.series!;
    await cancelBooking({ bookingId: o2.booking.id, actor: "host" });
    let rows = await rowsOf(e);
    expect(rows.map((x) => x.status)).toEqual(["confirmed", "cancelled", "confirmed", "confirmed"]);
    // the invitee cancels the whole series from occurrence 3's link at a time when occurrence 1 already happened
    const after1 = new Date("2026-03-03T00:00:00Z");
    await cancelBooking({ manageToken: o3.manageToken!, scope: "series", reason: "moving", actor: "invitee" }, { now: after1 });
    rows = await rowsOf(e);
    expect(rows.map((x) => x.status)).toEqual(["confirmed", "cancelled", "cancelled", "cancelled"]); // past occurrence untouched
    expect(rows[2].cancelReason).toBe("moving");
    expect(rows[2].cancelledBy).toBe("invitee");
    const cancelEvents = hookEvents.filter((x) => x.type === "booking.cancelled" && [o3.booking.id, o4.booking.id].includes(x.id));
    expect(cancelEvents.map((x) => x.extra?.seriesIndex).sort()).toEqual([0, 1]);
    // idempotent
    await cancelBooking({ manageToken: o1.manageToken!, scope: "series", actor: "invitee" }, { now: after1 });
    // the freed slot can be rebooked
    const single = await mkEvent("cx-single", u, { maxHorizonDays: 365 });
    expect((await nyBook(single, "2026-03-16T13:00:00Z", "again")).booking.status).toBe("confirmed");
  });

  it("invitee series-cancel respects the minimum notice window per occurrence", async () => {
    const u = await mkUser("nye", NY);
    const e = await mkEvent("cn", u, { recurrence: { count: 3, interval: "week" }, maxHorizonDays: 365, minCancelNoticeMinutes: 24 * 60 });
    const r = await nyBook(e, "2026-03-02T14:00:00Z", "cn");
    // 10h before occurrence 2: occurrence 2 is inside the notice window, occurrence 3 is not
    await cancelBooking({ manageToken: r.manageToken!, scope: "series", actor: "invitee" }, { now: new Date("2026-03-09T03:00:00Z") });
    expect((await rowsOf(e)).map((x) => x.status)).toEqual(["confirmed", "confirmed", "cancelled"]);
  });

  it("reschedule ONE occurrence keeps the series id and leaves the others", async () => {
    const u = await mkUser("nyf", NY);
    const e = await mkEvent("rs", u, { recurrence: { count: 3, interval: "week" }, maxHorizonDays: 365 });
    const r = await nyBook(e, "2026-03-02T14:00:00Z", "rs");
    const seriesId = r.booking.seriesId!;
    const moved = await rescheduleBooking({ bookingId: r.series![1].booking.id, newStartsAt: "2026-03-10T15:00:00Z", actor: "host" }, { now: NOW });
    expect(moved.booking.seriesId).toBe(seriesId);
    const rows = await rowsOf(e);
    expect(rows.map((x) => x.status)).toEqual(["confirmed", "rescheduled", "confirmed", "confirmed"]);
    expect(rows.filter((x) => x.seriesId === seriesId)).toHaveLength(4);
    expect(rows.filter((x) => x.status === "confirmed").map((x) => x.startsAt.toISOString())).toEqual(["2026-03-02T14:00:00.000Z", "2026-03-10T15:00:00.000Z", "2026-03-16T13:00:00.000Z"]);
    // a conflicting reschedule fails and changes nothing
    const single = await mkEvent("rs-single", u, { maxHorizonDays: 365 });
    await nyBook(single, "2026-03-23T13:00:00Z", "blk");
    expect(await code(rescheduleBooking({ bookingId: r.series![2].booking.id, newStartsAt: "2026-03-23T13:00:00Z", actor: "host" }, { now: NOW }))).toBe("SLOT_UNAVAILABLE:409");
    expect((await rowsOf(e)).filter((x) => x.status === "confirmed")).toHaveLength(3);
  });

  it("concurrent overlapping series: exactly one wins and the loser reserves nothing", async () => {
    const u = await mkUser("nyg", NY);
    const e = await mkEvent("cc", u, { recurrence: { count: 3, interval: "week" }, maxHorizonDays: 365, slotIntervalMinutes: 15 });
    const res = await Promise.allSettled([
      nyBook(e, "2026-03-02T14:00:00Z", "ccA"), // 09:00
      nyBook(e, "2026-03-02T14:15:00Z", "ccB"), // 09:15 overlaps every occurrence of A
      nyBook(e, "2026-03-02T14:00:00Z", "ccC"),
      nyBook(e, "2026-03-02T14:15:00Z", "ccD"),
    ]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of res) if (x.status === "rejected") expect((x.reason as AppError).code).toBe("SLOT_UNAVAILABLE");
    const rows = (await rowsOf(e)).filter((x) => x.status === "confirmed");
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((x) => x.seriesId)).size).toBe(1);
  });

  it("a series that needs approval: all sessions held pending; approve confirms all; decline frees all", async () => {
    const u = await mkUser("nyh2", NY);
    const e = await mkEvent("sra", u, { recurrence: { count: 3, interval: "week" }, maxHorizonDays: 365, requiresConfirmation: true });
    const r = await nyBook(e, "2026-03-02T14:00:00Z", "sra");
    expect((await rowsOf(e)).map((x) => x.status)).toEqual(["pending_confirmation", "pending_confirmation", "pending_confirmation"]);
    expect(await code(nyBook(e, "2026-03-09T13:00:00Z", "other"))).toBe("SLOT_UNAVAILABLE:409"); // held
    await approveBooking({ bookingId: r.series![1].booking.id }, { now: NOW });
    expect((await rowsOf(e)).map((x) => x.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(hookEvents.filter((x) => x.type === "booking.confirmed" && x.extra?.approved && r.series!.some((s) => s.booking.id === x.id)).map((x) => x.extra?.seriesIndex).sort()).toEqual([0, 1, 2]);

    const u2 = await mkUser("nyi", NY);
    const e2 = await mkEvent("srd", u2, { recurrence: { count: 3, interval: "week" }, maxHorizonDays: 365, requiresConfirmation: true });
    const r2 = await nyBook(e2, "2026-03-02T14:00:00Z", "srd");
    await declineBooking({ bookingId: r2.booking.id, reason: "no" });
    expect((await rowsOf(e2)).map((x) => x.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect((await nyBook(e2, "2026-03-02T14:00:00Z", "srd2")).series).toHaveLength(3); // slots released
  });

  it("rejects paid recurring events and never recurs group events", async () => {
    const u = await mkUser("nyj", NY);
    const e = await mkEvent("paidrec", u, { recurrence: { count: 3, interval: "week" }, priceAmount: 1000, priceCurrency: "USD", paymentProvider: "stripe", maxHorizonDays: 365 });
    expect(await code(nyBook(e, "2026-03-02T14:00:00Z", "pr"))).toBe("VALIDATION:400");
    expect(await rowsOf(e)).toHaveLength(0);
    const g = await mkEvent("grouprec", u, { kind: "group", capacity: 3, recurrence: { count: 3, interval: "week" }, maxHorizonDays: 365 });
    const r = await nyBook(g, "2026-03-02T14:00:00Z", "g1");
    expect(r.series).toBeUndefined();
    expect(await rowsOf(g)).toHaveLength(1);
  });

  it("non-recurring events are unaffected (no series id)", async () => {
    const [s] = await freeSlots(plainEvent);
    const r = await createBooking({ eventTypeId: plainEvent, startsAt: s, invitee: invitee("pl") });
    expect(r.booking.seriesId).toBeNull();
    expect(r.series).toBeUndefined();
  });
});
