/**
 * Integration tests against the real dev Postgres. Each run creates isolated fixtures (random suffix) and deletes them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { AppError } from "../errors";
import { getAvailableSlots } from "../scheduling/slots";
import {
  cancelBooking, createBooking, getBookingByManageToken, hashToken, markBooking, rescheduleBooking,
  setBookingEventHook,
} from "./booking";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `t_${run}_${n}`;
const events: { type: string; id: string }[] = [];
setBookingEventHook((type, id) => { events.push({ type, id }); });

const userIds: string[] = [];
const eventIds: string[] = [];
const scheduleIds: string[] = [];
const ev: Record<string, string> = {};

async function mkUser(n: string) {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name: `User ${n}`, email: `${id}@example.test`, timeZone: "UTC" });
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "Work", timeZone: "UTC", isDefault: true }).returning();
  scheduleIds.push(s.id);
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "08:00", endTime: "20:00" })));
  userIds.push(id);
  return id;
}
async function mkEvent(name: string, owner: string, o: Partial<typeof schema.eventTypes.$inferInsert> = {}, hosts: { userId: string; priority?: number; weight?: number }[] = []) {
  const [e] = await db.insert(schema.eventTypes).values({
    ownerUserId: owner, slug: `${name}-${run}`, title: name, durationMinutes: 30, minNoticeMinutes: 0, maxHorizonDays: 30, ...o,
  }).returning();
  if (hosts.length) await db.insert(schema.eventHosts).values(hosts.map((h) => ({ eventTypeId: e.id, userId: h.userId, priority: h.priority ?? 0, weight: h.weight ?? 1, isRequired: true })));
  eventIds.push(e.id);
  ev[name] = e.id;
  return e.id;
}
const slots = (eventId: string, days = 4) =>
  getAvailableSlots({ eventTypeId: eventId, from: new Date(), to: new Date(Date.now() + days * 86_400_000), inviteeTimeZone: "UTC" });
const invitee = (n: string) => ({ name: `Inv ${n}`, email: `inv-${n}-${run}@example.test`, timeZone: "Europe/London" });
const activeRows = (eventId: string) =>
  db.select().from(schema.bookings).where(and(eq(schema.bookings.eventTypeId, eventId), inArray(schema.bookings.status, ["confirmed", "pending_payment"])));
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? `${e.code}:${e.status}` : (e as Error).message; } };

let A: string, B: string, C: string, D: string, E: string, F: string, G: string;

beforeAll(async () => {
  [A, B, C, D, E, F, G] = await Promise.all(["a", "b", "c", "d", "e", "f", "g"].map(mkUser));
  await mkEvent("solo", A);
  await mkEvent("solo2", G);
  await mkEvent("group", B, { kind: "group", capacity: 2 });
  await mkEvent("collective", C, { kind: "collective" }, [{ userId: C }, { userId: D }]);
  await mkEvent("rr", E, { kind: "round_robin" }, [{ userId: E, priority: 0 }, { userId: F, priority: 0 }]);
  await mkEvent("buffered", G, { bufferBeforeMinutes: 15, bufferAfterMinutes: 15, slug: `buf-${run}` });
});

afterAll(async () => {
  setBookingEventHook(null);
  if (eventIds.length) {
    const bs = await db.select({ id: schema.bookings.id }).from(schema.bookings).where(inArray(schema.bookings.eventTypeId, eventIds));
    if (bs.length) await db.delete(schema.bookings).where(inArray(schema.bookings.id, bs.map((b) => b.id)));
    await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, eventIds));
  }
  if (userIds.length) {
    await db.delete(schema.blockedTimes).where(inArray(schema.blockedTimes.userId, userIds));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds)); // cascades schedules, rules, contacts
  }
  await pool.end();
});

describe("slot generation from DB", () => {
  it("offers slots from the host schedule and respects min notice", async () => {
    const s = await slots(ev.solo);
    expect(s.length).toBeGreaterThan(10);
    expect(s.every((x) => x.hostUserId === A)).toBe(true);
    const [late] = await db.insert(schema.eventTypes).values({ ownerUserId: A, slug: `late-${run}`, title: "late", minNoticeMinutes: 60 * 24 * 2, maxHorizonDays: 30 }).returning();
    eventIds.push(late.id);
    const l = await slots(late.id, 10);
    expect(new Date(l[0].startsAt).getTime()).toBeGreaterThanOrEqual(Date.now() + 2 * 86_400_000);
  });
  it("a suspended personal-event owner offers no slots and cannot be booked", async () => {
    const owner = await mkUser("susp");
    const e = await mkEvent("susp-event", owner);
    expect((await slots(e)).length).toBeGreaterThan(0);
    await db.update(schema.users).set({ status: "suspended" }).where(eq(schema.users.id, owner));
    await expect(slots(e)).rejects.toThrow();
  });
  it("blocked_time removes slots", async () => {
    const s = await slots(ev.solo2);
    const first = new Date(s[0].startsAt);
    const [bt] = await db.insert(schema.blockedTimes).values({ userId: G, startsAt: first, endsAt: new Date(first.getTime() + 30 * 60_000) }).returning();
    const after = await slots(ev.solo2);
    expect(after.some((x) => x.startsAt === s[0].startsAt)).toBe(false);
    await db.delete(schema.blockedTimes).where(eq(schema.blockedTimes.id, bt.id));
  });
  it("external busy from an injected provider removes slots", async () => {
    const s = await slots(ev.solo2);
    const t0 = new Date(s[1].startsAt).getTime();
    const out = await getAvailableSlots({
      eventTypeId: ev.solo2, from: new Date(), to: new Date(Date.now() + 4 * 86_400_000), inviteeTimeZone: "UTC",
      busyProvider: async () => [{ start: t0 - 1000, end: t0 + 1000 }],
    });
    expect(out.some((x) => x.startsAt === s[1].startsAt)).toBe(false);
  });
});

describe("createBooking: double-booking safety", () => {
  it("10 concurrent requests for one slot -> exactly 1 success, 9 SLOT_UNAVAILABLE", async () => {
    const [slot] = await slots(ev.solo);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => createBooking({ eventTypeId: ev.solo, startsAt: slot.startsAt, invitee: invitee(`c${i}`) })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(9);
    for (const b of bad) {
      expect(b.reason).toBeInstanceOf(AppError);
      expect(b.reason.code).toBe("SLOT_UNAVAILABLE");
      expect(b.reason.status).toBe(409);
    }
    const rows = await db.select().from(schema.bookings).where(and(eq(schema.bookings.eventTypeId, ev.solo), eq(schema.bookings.startsAt, new Date(slot.startsAt))));
    expect(rows).toHaveLength(1);
  });

  it("the EXCLUDE constraint itself rejects overlapping rows (DB backstop)", async () => {
    const [existing] = await activeRows(ev.solo);
    const bad = db.insert(schema.bookings).values({
      eventTypeId: ev.solo, hostUserId: A, startsAt: existing.startsAt, endsAt: existing.endsAt, blockStart: existing.blockStart, blockEnd: existing.blockEnd,
      inviteeTimeZone: "UTC", hostTimeZone: "UTC",
    });
    await expect(bad).rejects.toSatisfy((e: { cause?: { code?: string }; code?: string }) => (e.cause?.code ?? e.code) === "23P01");
  });

  it("overlapping (not identical) start is also rejected", async () => {
    const [existing] = await activeRows(ev.solo);
    const s = await slots(ev.solo);
    // no offered slot overlaps the booked one
    const bookedStart = existing.startsAt.getTime();
    expect(s.some((x) => Math.abs(new Date(x.startsAt).getTime() - bookedStart) < 30 * 60_000)).toBe(false);
    expect(await code(createBooking({ eventTypeId: ev.solo, startsAt: new Date(bookedStart + 15 * 60_000), invitee: invitee("ov") }))).toBe("SLOT_UNAVAILABLE:409");
  });

  it("rejects off-grid / outside-availability starts and validates input", async () => {
    expect(await code(createBooking({ eventTypeId: ev.solo, startsAt: "2020-01-01T10:00:00Z", invitee: invitee("past") }))).toBe("SLOT_UNAVAILABLE:409");
    expect(await code(createBooking({ eventTypeId: ev.solo, startsAt: "nope", invitee: invitee("x") }))).toBe("VALIDATION:400");
    expect(await code(createBooking({ eventTypeId: ev.solo, startsAt: new Date(Date.now() + 86_400_000), invitee: { ...invitee("y"), email: "bad" } }))).toBe("VALIDATION:400");
  });
});

describe("createBooking: data & idempotency", () => {
  it("stores invitee, contact, history; manage token is hashed", async () => {
    const s = await slots(ev.solo);
    const r = await createBooking({ eventTypeId: ev.solo, startsAt: s[3].startsAt, invitee: invitee("d1") });
    expect(r.manageToken).toBeTruthy();
    expect(r.booking.manageTokenHash).toBe(hashToken(r.manageToken!));
    expect(r.booking.manageTokenHash).not.toBe(r.manageToken);
    expect(r.booking.status).toBe("confirmed");
    expect(r.booking.hostTimeZone).toBe("UTC");
    const [inv] = await db.select().from(schema.invitees).where(eq(schema.invitees.bookingId, r.booking.id));
    expect(inv.email).toBe(`inv-d1-${run}@example.test`);
    expect(inv.contactId).toBeTruthy();
    const hist = await db.select().from(schema.bookingEvents).where(eq(schema.bookingEvents.bookingId, r.booking.id));
    expect(hist.map((h) => h.type)).toEqual(["created"]);
    expect(events.some((e) => e.type === "booking.created" && e.id === r.booking.id)).toBe(true);
    const got = await getBookingByManageToken(r.manageToken!);
    expect(got.booking.id).toBe(r.booking.id);
    expect(got.invitee?.name).toBe("Inv d1");
    expect(await code(getBookingByManageToken("wrong"))).toBe("NOT_FOUND:404");
  });

  it("required questions are enforced and answers stored", async () => {
    const [q] = await db.insert(schema.eventQuestions).values({ eventTypeId: ev.solo, label: "Why?", type: "short_text", required: true }).returning();
    const s = await slots(ev.solo);
    expect(await code(createBooking({ eventTypeId: ev.solo, startsAt: s[5].startsAt, invitee: invitee("q0") }))).toBe("VALIDATION:400");
    const r = await createBooking({ eventTypeId: ev.solo, startsAt: s[5].startsAt, invitee: invitee("q1"), answers: { [q.id]: "because" } });
    const [inv] = await db.select().from(schema.invitees).where(eq(schema.invitees.bookingId, r.booking.id));
    const ans = await db.select().from(schema.inviteeAnswers).where(eq(schema.inviteeAnswers.inviteeId, inv.id));
    expect(ans).toMatchObject([{ question: "Why?", answer: "because" }]);
    await cancelBooking({ bookingId: r.booking.id, actor: "host" });
    await db.delete(schema.eventQuestions).where(eq(schema.eventQuestions.id, q.id));
  });

  it("idempotencyKey returns the existing booking (sequential and concurrent)", async () => {
    const s = await slots(ev.solo);
    const key = `idem-${run}`;
    const first = await createBooking({ eventTypeId: ev.solo, startsAt: s[7].startsAt, invitee: invitee("i1"), idempotencyKey: key });
    const second = await createBooking({ eventTypeId: ev.solo, startsAt: s[7].startsAt, invitee: invitee("i1"), idempotencyKey: key });
    expect(second.booking.id).toBe(first.booking.id);
    expect(second.idempotentReplay).toBe(true);

    const key2 = `idem2-${run}`;
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => createBooking({ eventTypeId: ev.solo, startsAt: s[8].startsAt, invitee: invitee("i2"), idempotencyKey: key2 })));
    expect(rs.every((r) => r.status === "fulfilled")).toBe(true);
    const ids = new Set(rs.map((r) => (r as PromiseFulfilledResult<{ booking: { id: string } }>).value.booking.id));
    expect(ids.size).toBe(1);
  });
});

describe("reschedule & cancel", () => {
  it("reschedule creates a linked row, retires the old one, frees the old slot, keeps history", async () => {
    const s = await slots(ev.solo);
    const a = await createBooking({ eventTypeId: ev.solo, startsAt: s[10].startsAt, invitee: invitee("r1") });
    const moved = await rescheduleBooking({ manageToken: a.manageToken!, newStartsAt: s[11].startsAt });
    expect(moved.booking.id).not.toBe(a.booking.id);
    expect(moved.booking.rescheduledFromId).toBe(a.booking.id);
    expect(moved.booking.startsAt.toISOString()).toBe(s[11].startsAt);
    const [old] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, a.booking.id));
    expect(old.status).toBe("rescheduled");
    const oldHist = await db.select().from(schema.bookingEvents).where(eq(schema.bookingEvents.bookingId, a.booking.id));
    expect(oldHist.map((h) => h.type).sort()).toEqual(["created", "rescheduled"]);
    const [inv] = await db.select().from(schema.invitees).where(eq(schema.invitees.bookingId, moved.booking.id));
    expect(inv.email).toBe(`inv-r1-${run}@example.test`);
    // old slot is free again
    const again = await createBooking({ eventTypeId: ev.solo, startsAt: s[10].startsAt, invitee: invitee("r2") });
    expect(again.booking.status).toBe("confirmed");
    // old manage link points forward
    const view = await getBookingByManageToken(a.manageToken!);
    expect(view.rescheduledTo?.id).toBe(moved.booking.id);
    // cannot reschedule a rescheduled booking
    expect(await code(rescheduleBooking({ bookingId: a.booking.id, newStartsAt: s[12].startsAt }))).toBe("INVALID_STATE:409");
    expect(events.some((e) => e.type === "booking.rescheduled" && e.id === moved.booking.id)).toBe(true);
  });

  it("reschedule onto a taken slot fails and leaves the original untouched; own overlapping slot is allowed", async () => {
    const s = await slots(ev.solo);
    const a = await createBooking({ eventTypeId: ev.solo, startsAt: s[14].startsAt, invitee: invitee("r3") });
    const b = await createBooking({ eventTypeId: ev.solo, startsAt: s[15].startsAt, invitee: invitee("r4") });
    expect(await code(rescheduleBooking({ bookingId: a.booking.id, newStartsAt: b.booking.startsAt }))).toBe("SLOT_UNAVAILABLE:409");
    const [still] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, a.booking.id));
    expect(still.status).toBe("confirmed");
    const hist = await db.select().from(schema.bookingEvents).where(eq(schema.bookingEvents.bookingId, a.booking.id));
    expect(hist.map((h) => h.type)).toEqual(["created"]); // failed tx rolled back
  });

  it("cancel keeps the row and history, frees the slot, is idempotent", async () => {
    const s = await slots(ev.solo);
    const a = await createBooking({ eventTypeId: ev.solo, startsAt: s[18].startsAt, invitee: invitee("x1") });
    const c = await cancelBooking({ manageToken: a.manageToken!, reason: "changed mind" });
    expect(c.status).toBe("cancelled");
    expect(c.cancelledBy).toBe("invitee");
    expect(c.cancelReason).toBe("changed mind");
    const [row] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, a.booking.id));
    expect(row).toBeTruthy();
    const hist = await db.select().from(schema.bookingEvents).where(eq(schema.bookingEvents.bookingId, a.booking.id));
    expect(hist.map((h) => h.type).sort()).toEqual(["cancelled", "created"]);
    const [inv] = await db.select().from(schema.invitees).where(eq(schema.invitees.bookingId, a.booking.id));
    expect(inv.cancelledAt).toBeTruthy();
    const again = await cancelBooking({ bookingId: a.booking.id });
    expect(again.status).toBe("cancelled");
    const hist2 = await db.select().from(schema.bookingEvents).where(eq(schema.bookingEvents.bookingId, a.booking.id));
    expect(hist2).toHaveLength(2);
    expect(await code(rescheduleBooking({ bookingId: a.booking.id, newStartsAt: s[19].startsAt }))).toBe("INVALID_STATE:409");
    const rebook = await createBooking({ eventTypeId: ev.solo, startsAt: s[18].startsAt, invitee: invitee("x2") });
    expect(rebook.booking.status).toBe("confirmed");
  });

  it("markBooking transitions", async () => {
    const s = await slots(ev.solo);
    const a = await createBooking({ eventTypeId: ev.solo, startsAt: s[22].startsAt, invitee: invitee("m1") });
    expect((await markBooking({ bookingId: a.booking.id, status: "no_show" })).status).toBe("no_show");
    expect((await markBooking({ bookingId: a.booking.id, status: "completed" })).status).toBe("completed");
    expect(await code(markBooking({ bookingId: a.booking.id, status: "expired" }))).toBe("INVALID_STATE:409");
  });

  it("invitee cancel is blocked inside minCancelNotice", async () => {
    const [e] = await db.insert(schema.eventTypes).values({ ownerUserId: G, slug: `notice-${run}`, title: "n", minNoticeMinutes: 0, minCancelNoticeMinutes: 60 * 24 * 30, maxHorizonDays: 30 }).returning();
    eventIds.push(e.id);
    const s = await slots(e.id);
    const a = await createBooking({ eventTypeId: e.id, startsAt: s[0].startsAt, invitee: invitee("n1") });
    expect(await code(cancelBooking({ manageToken: a.manageToken! }))).toBe("FORBIDDEN:403");
    expect((await cancelBooking({ bookingId: a.booking.id, actor: "host" })).status).toBe("cancelled");
  });
});

describe("buffers", () => {
  it("adjacent slots inside the buffer are no longer offered; block window stored", async () => {
    const s = await slots(ev.buffered);
    // A mid-day slot (host works 08:00-20:00 UTC): the checks below look an hour either side of it, which must stay inside working hours
    // whatever time of day the test runs. (s[2] was "the third slot from now": at 17:30 UTC that is ~19:00 and t0 + 60 min is 20:00.)
    const pick = s.find((x) => { const h = new Date(x.startsAt).getUTCHours(); return h >= 10 && h <= 15; })!;
    const t0 = new Date(pick.startsAt).getTime();
    const r = await createBooking({ eventTypeId: ev.buffered, startsAt: pick.startsAt, invitee: invitee("b1") });
    expect(r.booking.blockStart.getTime()).toBe(t0 - 15 * 60_000);
    expect(r.booking.blockEnd.getTime()).toBe(t0 + 45 * 60_000);
    const after = await slots(ev.buffered);
    const starts = new Set(after.map((x) => new Date(x.startsAt).getTime()));
    expect(starts.has(t0)).toBe(false);
    expect(starts.has(t0 + 30 * 60_000)).toBe(false); // would start inside our after-buffer
    expect(starts.has(t0 - 30 * 60_000)).toBe(false); // its end + buffer collides with our before-buffer
    expect(starts.has(t0 + 60 * 60_000)).toBe(true);
  });
});

describe("daily limit", () => {
  it("hides the rest of the day once the limit is reached", async () => {
    const [e] = await db.insert(schema.eventTypes).values({ ownerUserId: G, slug: `lim-${run}`, title: "lim", minNoticeMinutes: 0, maxHorizonDays: 30, dailyLimit: 1 }).returning();
    eventIds.push(e.id);
    // use a fresh host so other tests' bookings do not interfere
    const H = await mkUser("h");
    await db.update(schema.eventTypes).set({ ownerUserId: H }).where(eq(schema.eventTypes.id, e.id));
    const s = await slots(e.id, 3);
    const day = s[0].startsAt.slice(0, 10);
    await createBooking({ eventTypeId: e.id, startsAt: s[0].startsAt, invitee: invitee("l1") });
    const after = await slots(e.id, 3);
    expect(after.some((x) => x.startsAt.slice(0, 10) === day)).toBe(false);
    expect(after.length).toBeGreaterThan(0);
    expect(await code(createBooking({ eventTypeId: e.id, startsAt: s[1].startsAt, invitee: invitee("l2") }))).toBe(
      s[1].startsAt.slice(0, 10) === day ? "SLOT_UNAVAILABLE:409" : null,
    );
  });
});

describe("group events", () => {
  it("allow bookings up to capacity, then SLOT_UNAVAILABLE; duplicate invitee rejected", async () => {
    const s = await slots(ev.group);
    expect(s[0].spotsLeft).toBe(2);
    const t = s[0].startsAt;
    const a = await createBooking({ eventTypeId: ev.group, startsAt: t, invitee: invitee("g1") });
    expect(a.booking.exclusiveSlot).toBe(false);
    expect((await slots(ev.group)).find((x) => x.startsAt === t)?.spotsLeft).toBe(1);
    expect(await code(createBooking({ eventTypeId: ev.group, startsAt: t, invitee: invitee("g1") }))).toBe("ALREADY_BOOKED:409");
    await createBooking({ eventTypeId: ev.group, startsAt: t, invitee: invitee("g2") });
    expect(await code(createBooking({ eventTypeId: ev.group, startsAt: t, invitee: invitee("g3") }))).toBe("SLOT_UNAVAILABLE:409");
    expect((await slots(ev.group)).some((x) => x.startsAt === t)).toBe(false);
    expect(await activeRows(ev.group)).toHaveLength(2);
    // cancelling one frees a seat
    await cancelBooking({ bookingId: a.booking.id, actor: "host" });
    expect((await slots(ev.group)).find((x) => x.startsAt === t)?.spotsLeft).toBe(1);
  });

  it("concurrent requests never exceed capacity", async () => {
    const s = await slots(ev.group);
    const t = s[4].startsAt;
    const rs = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createBooking({ eventTypeId: ev.group, startsAt: t, invitee: invitee(`gc${i}`) })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(rs.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "SLOT_UNAVAILABLE")).toBe(true);
  });
});

describe("collective events", () => {
  it("books every required host; each host is blocked; cancel/reschedule apply to all", async () => {
    const s = await slots(ev.collective);
    const t = s[0].startsAt;
    const r = await createBooking({ eventTypeId: ev.collective, startsAt: t, invitee: invitee("co1") });
    const rows = await activeRows(ev.collective);
    expect(rows.map((x) => x.hostUserId).sort()).toEqual([C, D].sort());
    expect(rows.filter((x) => x.manageTokenHash)).toHaveLength(1);
    expect((await slots(ev.collective)).some((x) => x.startsAt === t)).toBe(false);
    // host D is individually blocked for another event of D's own
    const dEvent = await mkEvent("dsolo", D);
    expect((await slots(dEvent)).some((x) => x.startsAt === t)).toBe(false);

    const moved = await rescheduleBooking({ manageToken: r.manageToken!, newStartsAt: s[1].startsAt });
    const rows2 = await activeRows(ev.collective);
    expect(rows2).toHaveLength(2);
    expect(rows2.every((x) => x.startsAt.toISOString() === s[1].startsAt)).toBe(true);
    const old = await db.select().from(schema.bookings).where(and(eq(schema.bookings.eventTypeId, ev.collective), eq(schema.bookings.status, "rescheduled")));
    expect(old).toHaveLength(2);
    expect((await slots(dEvent)).some((x) => x.startsAt === t)).toBe(true);

    await cancelBooking({ manageToken: moved.manageToken! });
    expect(await activeRows(ev.collective)).toHaveLength(0);
    expect((await slots(dEvent)).some((x) => x.startsAt === s[1].startsAt)).toBe(true);
  });

  it("slot disappears when ANY required host is busy; concurrent bookings -> 1 winner", async () => {
    const s = await slots(ev.collective);
    const t = new Date(s[2].startsAt);
    const [bt] = await db.insert(schema.blockedTimes).values({ userId: D, startsAt: t, endsAt: new Date(t.getTime() + 30 * 60_000) }).returning();
    expect((await slots(ev.collective)).some((x) => x.startsAt === s[2].startsAt)).toBe(false);
    await db.delete(schema.blockedTimes).where(eq(schema.blockedTimes.id, bt.id));
    const rs = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createBooking({ eventTypeId: ev.collective, startsAt: s[3].startsAt, invitee: invitee(`cc${i}`) })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await activeRows(ev.collective)).toHaveLength(2);
  });
});

describe("round robin", () => {
  it("spreads bookings across hosts and fills a slot only up to the number of free hosts", async () => {
    const s = await slots(ev.rr);
    const t = s[0].startsAt;
    expect(s[0].hostUserIds?.sort()).toEqual([E, F].sort());
    const b1 = await createBooking({ eventTypeId: ev.rr, startsAt: t, invitee: invitee("rr1") });
    const slotAfter = (await slots(ev.rr)).find((x) => x.startsAt === t);
    expect(slotAfter?.hostUserId).not.toBe(b1.booking.hostUserId); // other host is next
    const b2 = await createBooking({ eventTypeId: ev.rr, startsAt: t, invitee: invitee("rr2") });
    expect(new Set([b1.booking.hostUserId, b2.booking.hostUserId]).size).toBe(2);
    expect(await code(createBooking({ eventTypeId: ev.rr, startsAt: t, invitee: invitee("rr3") }))).toBe("SLOT_UNAVAILABLE:409");
  });

  it("prefers the least-loaded host for a new time", async () => {
    const s = await slots(ev.rr);
    const r = await createBooking({ eventTypeId: ev.rr, startsAt: s[3].startsAt, invitee: invitee("rr4") });
    const loads = await db.select({ h: schema.bookings.hostUserId, n: sql<number>`count(*)::int` }).from(schema.bookings)
      .where(and(eq(schema.bookings.eventTypeId, ev.rr), eq(schema.bookings.status, "confirmed"))).groupBy(schema.bookings.hostUserId);
    const max = Math.max(...loads.map((l) => l.n)), min = Math.min(...loads.map((l) => l.n));
    expect(max - min).toBeLessThanOrEqual(1);
    expect([E, F]).toContain(r.booking.hostUserId);
  });
});

// keep imports used
void or;
