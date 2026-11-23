/** Real-DB QA-matrix tests: broken calendar connections, a host leaving, late external blocks, Windows time zone names. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { AppError } from "../errors";
import { getAvailableSlots } from "../scheduling/slots";
import { getExternalBusy } from "../integrations/busy";
import { deleteAccount } from "./account";
import { createBooking, setBookingEventHook } from "./booking";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `ec_${run}_${n}`;
const userIds: string[] = [];
const eventIds: string[] = [];
const events: { type: string; bookingId: string }[] = [];
const inv = (n: string) => ({ name: `Inv ${n}`, email: `inv-${n}-${run}@example.test`, timeZone: "UTC" });

async function mkHost(n: string, tz = "UTC") {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name: `Host ${n}`, email: `${id}@example.test`, timeZone: tz });
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "w", timeZone: tz, isDefault: true }).returning();
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "08:00", endTime: "20:00" })));
  const [e] = await db.insert(schema.eventTypes).values({ ownerUserId: id, slug: `ev-${n}-${run}`, title: `Ev ${n}`, minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
  userIds.push(id); eventIds.push(e.id);
  return { id, eventId: e.id };
}
const slots = (eventId: string) => getAvailableSlots({ eventTypeId: eventId, from: new Date(Date.now() + 3600_000), to: new Date(Date.now() + 3 * 86_400_000), inviteeTimeZone: "UTC" });
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? e.code : (e as Error).message; } };

beforeAll(() => setBookingEventHook((type, bookingId) => { events.push({ type, bookingId }); }));
afterAll(async () => {
  setBookingEventHook(null);
  await db.delete(schema.bookings).where(inArray(schema.bookings.eventTypeId, eventIds));
  await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, eventIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await pool.end();
});

describe("a broken calendar connection never reopens the host's calendar", () => {
  it("keeps blocking with the cached events when the token was revoked / consent blocked (needs_reauth)", async () => {
    const h = await mkHost("reauth");
    const [conn] = await db.insert(schema.connectedCalendars).values({ userId: h.id, provider: "google", externalAccountId: `acc-${run}`, credentialsEnc: "x", status: "needs_reauth" }).returning();
    const [cal] = await db.insert(schema.calendars).values({ connectedCalendarId: conn.id, externalId: "primary", name: "Primary", checkConflicts: true }).returning();
    const from = new Date("2030-01-10T00:00:00Z"), to = new Date("2030-01-11T00:00:00Z");
    await db.insert(schema.calendarBusy).values({ calendarId: cal.id, externalEventId: "meeting", startsAt: new Date("2030-01-10T10:00:00Z"), endsAt: new Date("2030-01-10T11:00:00Z") });

    // no live provider call is attempted for a broken connection (that would fail anyway), the cache still counts
    expect(await getExternalBusy(h.id, from, to)).toEqual([{ start: new Date("2030-01-10T10:00:00Z"), end: new Date("2030-01-10T11:00:00Z") }]);
    expect(await getExternalBusy(h.id, from, to, { live: false })).toHaveLength(1);
  });
  it("still ignores calendars the host switched off for conflict checking", async () => {
    const h = await mkHost("off");
    const [conn] = await db.insert(schema.connectedCalendars).values({ userId: h.id, provider: "google", externalAccountId: `acc2-${run}`, credentialsEnc: "x", status: "needs_reauth" }).returning();
    const [cal] = await db.insert(schema.calendars).values({ connectedCalendarId: conn.id, externalId: "side", name: "Side", checkConflicts: false }).returning();
    await db.insert(schema.calendarBusy).values({ calendarId: cal.id, externalEventId: "x", startsAt: new Date("2030-01-10T10:00:00Z"), endsAt: new Date("2030-01-10T11:00:00Z") });
    expect(await getExternalBusy(h.id, new Date("2030-01-10T00:00:00Z"), new Date("2030-01-11T00:00:00Z"))).toEqual([]);
  });
});

describe("a calendar block added moments before the booking is submitted", () => {
  it("is caught when the booking commits (the slot list on screen is stale)", async () => {
    const h = await mkHost("late");
    const s = await slots(h.eventId);
    const target = new Date(s[3]!.startsAt).getTime();
    // the slot was offered a moment ago; now the host's calendar says busy
    const lateBlock = async () => [{ start: target - 60_000, end: target + 60_000 }];
    expect(await code(createBooking({ eventTypeId: h.eventId, startsAt: s[3]!.startsAt, invitee: inv("late") }, { busyProvider: lateBlock }))).toBe("SLOT_UNAVAILABLE");
    // and nothing was created
    const rows = await db.select().from(schema.bookings).where(eq(schema.bookings.eventTypeId, h.eventId));
    expect(rows).toHaveLength(0);
  });
});

describe("the host leaves (account deleted)", () => {
  it("future bookings are cancelled through the normal path so invitees are told and calendar events removed", async () => {
    const h = await mkHost("leaver");
    const s = await slots(h.eventId);
    const a = await createBooking({ eventTypeId: h.eventId, startsAt: s[1]!.startsAt, invitee: inv("l1") });
    const b = await createBooking({ eventTypeId: h.eventId, startsAt: s[5]!.startsAt, invitee: inv("l2") });
    events.length = 0;

    await deleteAccount(h.id);

    const rows = await db.select().from(schema.bookings).where(inArray(schema.bookings.id, [a.booking.id, b.booking.id]));
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);
    expect(rows.every((r) => /closed their account/i.test(r.cancelReason ?? ""))).toBe(true);
    // booking.cancelled drives the cancellation emails, the calendar/meeting teardown and the outgoing webhooks
    expect(events.filter((e) => e.type === "booking.cancelled").map((e) => e.bookingId).sort()).toEqual([a.booking.id, b.booking.id].sort());
    // the host's event types are gone with the account: nothing can be booked any more
    await expect(slots(h.eventId)).rejects.toThrow(/not found/i);
    expect(await code(createBooking({ eventTypeId: h.eventId, startsAt: s[3]!.startsAt, invitee: inv("l3") }))).not.toBeNull();
  });
});

describe("Windows time zone names from Outlook / Exchange", () => {
  it("a booking made with 'India Standard Time' is stored with the IANA zone", async () => {
    const h = await mkHost("win");
    const s = await slots(h.eventId);
    const r = await createBooking({ eventTypeId: h.eventId, startsAt: s[2]!.startsAt, invitee: { ...inv("w"), timeZone: "India Standard Time" } });
    expect(r.booking.inviteeTimeZone).toBe("Asia/Kolkata");
  });
  it("an unknown zone is still rejected", async () => {
    const h = await mkHost("badtz");
    const s = await slots(h.eventId);
    expect(await code(createBooking({ eventTypeId: h.eventId, startsAt: s[2]!.startsAt, invitee: { ...inv("b"), timeZone: "Nowhere Standard Time" } }))).toBe("VALIDATION");
  });
});
