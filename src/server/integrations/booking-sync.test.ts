/** DB-backed tests (isolated rows, cleaned up) with a mocked HTTP layer. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const enqueue = vi.fn(async () => ({}));
vi.mock("@/server/queue", () => ({ enqueue }));

import { db, schema } from "@/server/db";
import { decrypt } from "@/lib/crypto";
import { encodeCreds, withCalendarToken } from "./tokens";
import { reconcileBooking, afterBookingCreated, afterBookingUpdated, afterBookingCancelled } from "./booking-sync";
import { syncCalendar } from "./sync";
import { getExternalBusy } from "./busy";

const { users, eventTypes, bookings, invitees, connectedCalendars, calendars, calendarBusy, bookingEvents, videoConnections, calendarSyncStates } = schema;

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let responder: (c: Call) => { status?: number; body?: unknown } = () => ({ body: {} });

const uid = randomUUID().slice(0, 8);
const userId = `integ-${uid}`;
let eventTypeId: string, bookingId: string, connId: string, calId: string, calId2: string;

function stubFetch() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    let body: any = init?.body;
    try { body = typeof body === "string" ? JSON.parse(body) : body; } catch { /* form */ }
    const c: Call = { url: String(url), method: init?.method ?? "GET", body };
    calls.push(c);
    const r = responder(c);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
}
const apiCalls = () => calls.filter((c) => !c.url.includes("oauth2.googleapis.com/token"));

async function makeBooking(locationType: "google_meet" | "zoom" | "custom_url" | "teams", startHour = 10) {
  const [et] = await db.insert(eventTypes).values({ ownerUserId: userId, slug: `s-${randomUUID().slice(0, 6)}`, title: "Intro", locationType, locationValue: locationType === "custom_url" ? "https://example.com/room" : null }).returning();
  eventTypeId = et.id;
  const start = new Date(Date.UTC(2031, 0, 5, startHour)), end = new Date(start.getTime() + 30 * 60_000);
  const [b] = await db.insert(bookings).values({ eventTypeId: et.id, hostUserId: userId, startsAt: start, endsAt: end, blockStart: start, blockEnd: end, inviteeTimeZone: "UTC", hostTimeZone: "UTC", locationType }).returning();
  await db.insert(invitees).values({ bookingId: b.id, name: "Ann Invitee", email: "ann@example.com" });
  bookingId = b.id;
  return b;
}
const getBooking = async () => (await db.select().from(bookings).where(eq(bookings.id, bookingId)))[0];

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = "gid"; process.env.GOOGLE_CLIENT_SECRET = "gsecret";
  await db.insert(users).values({ id: userId, name: "Host", email: `${userId}@example.test` });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.delete(bookings).where(eq(bookings.hostUserId, userId));
  await db.delete(users).where(eq(users.id, userId)); // cascades event types, connections, calendars
});

beforeEach(async () => {
  enqueue.mockClear();
  stubFetch();
  responder = () => ({ body: {} });
  await db.delete(bookings).where(eq(bookings.hostUserId, userId));
  await db.delete(connectedCalendars).where(eq(connectedCalendars.userId, userId));
  await db.delete(videoConnections).where(eq(videoConnections.userId, userId));
  const [conn] = await db.insert(connectedCalendars).values({
    userId, provider: "google", externalAccountId: `g-${uid}`, email: "host@gmail.test",
    credentialsEnc: encodeCreds({ accessToken: "AT1", refreshToken: "RT1", expiresAt: Date.now() + 3600_000 }),
  }).returning();
  connId = conn.id;
  const [c1] = await db.insert(calendars).values({ connectedCalendarId: conn.id, externalId: "primary", name: "Primary", isDestination: true, checkConflicts: true }).returning();
  calId = c1.id;
  const [c2] = await db.insert(calendars).values({ connectedCalendarId: conn.id, externalId: "work", name: "Work", isDestination: false, checkConflicts: false }).returning();
  calId2 = c2.id;
});

describe("token refresh & revocation", () => {
  it("refreshes an expired access token and persists encrypted rotated credentials", async () => {
    await db.update(connectedCalendars).set({ credentialsEnc: encodeCreds({ accessToken: "old", refreshToken: "RT1", expiresAt: Date.now() - 1000 }) }).where(eq(connectedCalendars.id, connId));
    responder = (c) => c.url.includes("oauth2.googleapis.com/token") ? { body: { access_token: "AT2", expires_in: 3600 } } : { body: { ok: 1 } };
    const used = await withCalendarToken(connId, "google", async (t) => t);
    expect(used).toBe("AT2");
    expect(String(calls[0].body)).toContain("grant_type=refresh_token");
    const [row] = await db.select().from(connectedCalendars).where(eq(connectedCalendars.id, connId));
    expect(row.credentialsEnc).not.toContain("AT2"); // encrypted at rest
    expect(JSON.parse(decrypt(row.credentialsEnc))).toMatchObject({ accessToken: "AT2", refreshToken: "RT1" });
    expect(row.status).toBe("active");
  });

  it("revoked refresh token (invalid_grant) marks needs_reauth and short-circuits later calls without HTTP", async () => {
    await db.update(connectedCalendars).set({ credentialsEnc: encodeCreds({ accessToken: "old", refreshToken: "RT1", expiresAt: Date.now() - 1000 }) }).where(eq(connectedCalendars.id, connId));
    responder = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    await expect(withCalendarToken(connId, "google", async (t) => t)).rejects.toMatchObject({ kind: "auth" });
    const [row] = await db.select().from(connectedCalendars).where(eq(connectedCalendars.id, connId));
    expect(row.status).toBe("needs_reauth");
    expect(row.lastError).toMatch(/revoked|expired/i);
    const before = calls.length;
    await expect(withCalendarToken(connId, "google", async (t) => t)).rejects.toMatchObject({ kind: "auth" });
    expect(calls.length).toBe(before);
  });

  it("a 401 from the API triggers one refresh + retry; a still-401 marks needs_reauth", async () => {
    let apiHits = 0;
    responder = (c) => {
      if (c.url.includes("oauth2.googleapis.com/token")) return { body: { access_token: "AT9", expires_in: 3600 } };
      apiHits++; return apiHits === 1 ? { status: 401, body: { error: { message: "Invalid Credentials" } } } : { body: { ok: true } };
    };
    const { http } = await import("./http");
    const r = await withCalendarToken(connId, "google", (t) => http<{ ok: boolean }>("https://www.googleapis.com/x", { token: t }));
    expect(r.ok).toBe(true); expect(apiHits).toBe(2);

    responder = (c) => c.url.includes("oauth2.googleapis.com/token") ? { body: { access_token: "AT10", expires_in: 3600 } } : { status: 401, body: {} };
    await expect(withCalendarToken(connId, "google", (t) => http("https://www.googleapis.com/x", { token: t }))).rejects.toMatchObject({ kind: "auth" });
    expect((await db.select().from(connectedCalendars).where(eq(connectedCalendars.id, connId)))[0].status).toBe("needs_reauth");
  });
});

describe("booking sync orchestrator", () => {
  it("creates event + Meet link, stores ids/url, and is idempotent on repeat", async () => {
    await makeBooking("google_meet");
    responder = () => ({ body: { id: "ge1", hangoutLink: "https://meet.google.com/aaa-bbbb-ccc" } });
    const r = await afterBookingCreated(bookingId);
    expect(r.ok).toBe(true);
    const b = await getBooking();
    expect(b.externalEventIds[`cal:${calId}`]).toBe("ge1");
    expect(b.externalEventIds.sig).toBeTruthy();
    expect(b.meetingUrl).toBe("https://meet.google.com/aaa-bbbb-ccc");
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0].body.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    expect(apiCalls()[0].url).toContain("/calendars/primary/events");

    calls = [];
    const again = await afterBookingCreated(bookingId);
    expect(again.ok).toBe(true);
    expect(calls).toHaveLength(0); // nothing re-created
  });

  it("update patches the existing event only when the booking changed", async () => {
    await makeBooking("google_meet");
    responder = () => ({ body: { id: "ge1", hangoutLink: "https://meet.google.com/aaa" } });
    await afterBookingCreated(bookingId);
    const start = new Date(Date.UTC(2031, 0, 5, 14)), end = new Date(start.getTime() + 30 * 60_000);
    await db.update(bookings).set({ startsAt: start, endsAt: end, blockStart: start, blockEnd: end }).where(eq(bookings.id, bookingId));
    calls = [];
    const r = await afterBookingUpdated(bookingId);
    expect(r.ok).toBe(true);
    expect(apiCalls().map((c) => c.method)).toEqual(["PATCH"]);
    expect(apiCalls()[0].url).toContain("/events/ge1");
    expect(apiCalls()[0].body.start.dateTime).toBe(start.toISOString());
  });

  it("cancel deletes the external event and clears stored ids; missing remote event is fine", async () => {
    await makeBooking("google_meet");
    responder = () => ({ body: { id: "ge1", hangoutLink: "https://meet.google.com/aaa" } });
    await afterBookingCreated(bookingId);
    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, bookingId));
    calls = [];
    responder = () => ({ status: 404, body: { error: { message: "Not Found" } } });
    const r = await afterBookingCancelled(bookingId);
    expect(r.ok).toBe(true);
    expect(apiCalls().map((c) => c.method)).toEqual(["DELETE"]);
    expect((await getBooking()).externalEventIds).toEqual({});
  });

  it("transient provider failure is recorded, partial progress kept, and a retry is enqueued; retry converges", async () => {
    await makeBooking("google_meet");
    responder = () => ({ status: 503, body: { error: { message: "backend error" } } });
    const r = await afterBookingCreated(bookingId);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ retryable: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const args = enqueue.mock.calls[0] as unknown as [string, { name: string; data: { bookingId: string; attempt: number } }, { delay: number }];
    expect(args[1].data).toEqual({ bookingId, attempt: 1 });
    const ev = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    expect(ev.some((e) => e.type === "integration_sync_failed")).toBe(true);
    expect((await getBooking()).externalEventIds[`cal:${calId}`]).toBeUndefined();

    responder = () => ({ body: { id: "ge2", hangoutLink: "https://meet.google.com/zzz" } });
    const retry = await reconcileBooking(bookingId, { attempt: 1 });
    expect(retry.ok).toBe(true);
    expect((await getBooking()).externalEventIds[`cal:${calId}`]).toBe("ge2");
  });

  it("revoked calendar token: no crash, connection flagged needs_reauth, non-retryable failure recorded", async () => {
    await makeBooking("google_meet");
    await db.update(connectedCalendars).set({ credentialsEnc: encodeCreds({ accessToken: "x", refreshToken: "RT1", expiresAt: Date.now() - 1 }) }).where(eq(connectedCalendars.id, connId));
    responder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const r = await afterBookingCreated(bookingId);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.retryable)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await db.select().from(connectedCalendars).where(eq(connectedCalendars.id, connId)))[0].status).toBe("needs_reauth");
  });

  it("compensates: booking cancelled while confirmed-sync was in flight gets its event removed", async () => {
    await makeBooking("google_meet");
    responder = (c) => {
      if (c.method === "POST") {
        // simulate a concurrent cancellation landing during the provider call
        return { body: { id: "ge-race", hangoutLink: "https://meet.google.com/r" } };
      }
      return { body: {} };
    };
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => {
      const res = await original(u, i);
      if (i?.method === "POST") await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, bookingId));
      return res;
    }));
    const r = await afterBookingCreated(bookingId);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect((await getBooking()).externalEventIds).toEqual({});
  });

  it("zoom: creates a meeting, stores id + join url, updates and deletes it", async () => {
    process.env.ZOOM_CLIENT_ID = "z"; process.env.ZOOM_CLIENT_SECRET = "zs";
    await db.insert(videoConnections).values({ userId, provider: "zoom", externalAccountId: "z1", credentialsEnc: encodeCreds({ accessToken: "ZT", refreshToken: "ZR", expiresAt: Date.now() + 3600_000 }) });
    await makeBooking("zoom");
    responder = (c) => c.url.includes("api.zoom.us") ? { body: { id: 987654321, join_url: "https://zoom.us/j/987654321" } } : { body: { id: "ge1" } };
    expect((await afterBookingCreated(bookingId)).ok).toBe(true);
    let b = await getBooking();
    expect(b.externalEventIds.zoom).toBe("987654321");
    expect(b.meetingUrl).toBe("https://zoom.us/j/987654321");
    const evCall = calls.find((c) => c.url.includes("googleapis.com/calendar"));
    expect(evCall?.body.location).toBe("https://zoom.us/j/987654321");
    expect(evCall?.body.conferenceData).toBeUndefined();

    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, bookingId));
    calls = [];
    responder = () => ({ status: 204 });
    expect((await afterBookingCancelled(bookingId)).ok).toBe(true);
    b = await getBooking();
    expect(b.externalEventIds).toEqual({});
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("api.zoom.us/v2/meetings/987654321"))).toBe(true);
  });

  it("zoom not connected: booking proceeds, failure recorded as non-retryable", async () => {
    await makeBooking("zoom");
    responder = () => ({ body: { id: "ge1" } });
    const r = await afterBookingCreated(bookingId);
    expect(r.failures[0]).toMatchObject({ step: "zoom", retryable: false });
    expect((await getBooking()).externalEventIds[`cal:${calId}`]).toBe("ge1"); // calendar event still created
  });

  it("custom url passthrough sets meeting url without external meeting APIs", async () => {
    await makeBooking("custom_url");
    responder = () => ({ body: { id: "ge1" } });
    await afterBookingCreated(bookingId);
    expect((await getBooking()).meetingUrl).toBe("https://example.com/room");
  });

  it("Meet requested without a Google destination records a clear failure", async () => {
    await db.update(calendars).set({ isDestination: false }).where(eq(calendars.id, calId));
    await makeBooking("google_meet");
    const r = await afterBookingCreated(bookingId);
    expect(r.failures[0].step).toBe("google_meet");
    expect(calls).toHaveLength(0);
  });
});

describe("busy sync & lookup", () => {
  it("incremental sync caches busy rows, applies removals, and recovers from an expired sync token", async () => {
    await db.update(calendars).set({ checkConflicts: true }).where(eq(calendars.id, calId));
    const ev = (id: string, h: number) => ({ id, start: { dateTime: `2031-02-01T${h}:00:00Z` }, end: { dateTime: `2031-02-01T${h + 1}:00:00Z` } });
    responder = () => ({ body: { items: [ev("a", 10), ev("b", 12)], nextSyncToken: "T1" } });
    expect((await syncCalendar(calId)).ok).toBe(true);
    expect((await db.select().from(calendarBusy).where(eq(calendarBusy.calendarId, calId))).length).toBe(2);
    let [st] = await db.select().from(calendarSyncStates).where(eq(calendarSyncStates.calendarId, calId));
    expect(st.syncToken).toBe("T1");

    responder = () => ({ body: { items: [{ id: "a", status: "cancelled" }, ev("c", 15)], nextSyncToken: "T2" } });
    await syncCalendar(calId);
    expect(calls.at(-1)!.url).toContain("syncToken=T1");
    const ids = (await db.select().from(calendarBusy).where(eq(calendarBusy.calendarId, calId))).map((r) => r.externalEventId).sort();
    expect(ids).toEqual(["b", "c"]);

    // expired token => 410 => automatic full resync which replaces the cache
    let first = true;
    responder = (c) => { if (c.url.includes("syncToken=") && first) { first = false; return { status: 410, body: { error: { message: "gone" } } }; } return { body: { items: [ev("z", 13)], nextSyncToken: "T3" } }; };
    expect((await syncCalendar(calId)).ok).toBe(true);
    expect((await db.select().from(calendarBusy).where(eq(calendarBusy.calendarId, calId))).map((r) => r.externalEventId)).toEqual(["z"]);
    [st] = await db.select().from(calendarSyncStates).where(eq(calendarSyncStates.calendarId, calId));
    expect(st.syncToken).toBe("T3");
  });

  it("getExternalBusy merges cache + live, only for conflict-checking calendars, and degrades to cache on failure", async () => {
    await db.insert(calendarBusy).values([
      { calendarId: calId, externalEventId: "cached", startsAt: new Date("2031-03-01T10:00:00Z"), endsAt: new Date("2031-03-01T11:00:00Z") },
      { calendarId: calId2, externalEventId: "ignored", startsAt: new Date("2031-03-01T20:00:00Z"), endsAt: new Date("2031-03-01T21:00:00Z") },
    ]);
    responder = () => ({ body: { calendars: { primary: { busy: [{ start: "2031-03-01T10:30:00Z", end: "2031-03-01T12:00:00Z" }] } } } });
    const from = new Date("2031-03-01T00:00:00Z"), to = new Date("2031-03-02T00:00:00Z");
    const live = await getExternalBusy(userId, from, to);
    expect(live).toEqual([{ start: new Date("2031-03-01T10:00:00Z"), end: new Date("2031-03-01T12:00:00Z") }]);
    expect(calls.filter((c) => c.url.includes("freeBusy"))).toHaveLength(1); // work calendar not queried

    responder = () => ({ status: 500, body: {} });
    const degraded = await getExternalBusy(userId, from, to);
    expect(degraded).toEqual([{ start: new Date("2031-03-01T10:00:00Z"), end: new Date("2031-03-01T11:00:00Z") }]);
    expect(await getExternalBusy(userId, from, to, { live: false })).toHaveLength(1);
  });

  it("needs_reauth connections are excluded from busy lookups", async () => {
    await db.update(connectedCalendars).set({ status: "needs_reauth" }).where(eq(connectedCalendars.id, connId));
    expect(await getExternalBusy(userId, new Date("2031-03-01"), new Date("2031-03-02"))).toEqual([]);
  });
});
