import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { googleProvider, googleEventId } from "./google";
import { microsoftProvider } from "./microsoft";
import { mergeIntervals } from "./busy";
import { ProviderError } from "./http";
import { createOAuthState, verifyOAuthState, refreshTokens, buildAuthUrl, challengeFor } from "./oauth";
import { passthroughLocation } from "./video";

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];
let responder: (c: Call) => { status?: number; body?: unknown };

function mockFetch() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const raw = init?.body as string | undefined;
    let body: unknown = raw;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { /* form body */ }
    const call: Call = { url: String(url), method: init?.method ?? "GET", body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const r = responder(call);
    const status = r.status ?? 200;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status });
  }));
}

const input = {
  bookingId: "11111111-1111-4111-8111-111111111111", title: "Intro with Ann", description: "d",
  startsAt: new Date("2030-01-01T10:00:00Z"), endsAt: new Date("2030-01-01T10:30:00Z"),
  attendees: [{ email: "ann@example.com", name: "Ann" }],
};

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "gid"; process.env.GOOGLE_CLIENT_SECRET = "gsecret";
  process.env.APP_URL = "https://app.example.com";
  mockFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("google provider", () => {
  it("parses calendar list incl. pagination and writability", async () => {
    responder = (c) => c.url.includes("pageToken=p2")
      ? { body: { items: [{ id: "b", summary: "B", accessRole: "reader" }] } }
      : { body: { items: [{ id: "a", summary: "A", primary: true, accessRole: "owner" }], nextPageToken: "p2" } };
    const r = await googleProvider.getCalendars("tok");
    expect(r).toEqual([{ externalId: "a", name: "A", primary: true, writable: true }, { externalId: "b", name: "B", primary: false, writable: false }]);
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
  });

  it("parses freeBusy into Date intervals", async () => {
    responder = () => ({ body: { calendars: { primary: { busy: [{ start: "2030-01-01T09:00:00Z", end: "2030-01-01T10:00:00Z" }] } } } });
    const r = await googleProvider.getBusyIntervals("t", "primary", new Date("2030-01-01"), new Date("2030-01-02"));
    expect(r).toEqual([{ start: new Date("2030-01-01T09:00:00Z"), end: new Date("2030-01-01T10:00:00Z") }]);
  });

  it("surfaces freeBusy per-calendar errors", async () => {
    responder = () => ({ body: { calendars: { x: { errors: [{ reason: "notFound" }] } } } });
    await expect(googleProvider.getBusyIntervals("t", "x", new Date(), new Date())).rejects.toMatchObject({ kind: "not_found" });
  });

  it("creates an event with deterministic id + Meet request and returns the meet link", async () => {
    responder = () => ({ body: { id: "evt1", hangoutLink: "https://meet.google.com/abc-defg-hij" } });
    const r = await googleProvider.createEvent("t", "primary", { ...input, nativeMeeting: true });
    expect(r).toEqual({ id: "evt1", meetingUrl: "https://meet.google.com/abc-defg-hij" });
    const b = calls[0].body as Record<string, any>;
    expect(calls[0].url).toContain("conferenceDataVersion=1");
    expect(b.id).toBe(googleEventId(input.bookingId, "primary"));
    expect(b.id).toMatch(/^[a-v0-9]{5,}$/);
    expect(b.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    expect(b.attendees[0].email).toBe("ann@example.com");
    expect(b.start.dateTime).toBe("2030-01-01T10:00:00.000Z");
  });

  it("converges on duplicate create (409) by patching the existing event", async () => {
    responder = (c) => c.method === "POST" ? { status: 409, body: { error: { message: "duplicate" } } } : { body: { id: "existing" } };
    const r = await googleProvider.createEvent("t", "primary", input);
    expect(r.id).toBe("existing");
    expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
  });

  it("updates and deletes; delete of a missing event succeeds", async () => {
    responder = () => ({ body: { id: "e1" } });
    await googleProvider.updateEvent("t", "primary", "e1", input);
    expect(calls[0].method).toBe("PATCH");
    responder = () => ({ status: 404, body: { error: { message: "Not Found" } } });
    await expect(googleProvider.deleteEvent("t", "primary", "e1")).resolves.toBeUndefined();
    responder = () => ({ status: 410, body: {} });
    await expect(googleProvider.deleteEvent("t", "primary", "e1")).resolves.toBeUndefined();
    responder = () => ({ status: 500, body: {} });
    await expect(googleProvider.deleteEvent("t", "primary", "e1")).rejects.toMatchObject({ kind: "transient" });
  });

  it("maps incremental changes: cancelled/transparent/own events become removals; sync token returned", async () => {
    responder = () => ({ body: { nextSyncToken: "NEXT", items: [
      { id: "1", start: { dateTime: "2030-01-01T10:00:00Z" }, end: { dateTime: "2030-01-01T11:00:00Z" } },
      { id: "2", status: "cancelled" },
      { id: "3", transparency: "transparent", start: { dateTime: "2030-01-01T10:00:00Z" }, end: { dateTime: "2030-01-01T11:00:00Z" } },
      { id: "4", extendedProperties: { private: { meetflowBookingId: "x" } }, start: { dateTime: "2030-01-01T10:00:00Z" }, end: { dateTime: "2030-01-01T11:00:00Z" } },
      { id: "5", start: { date: "2030-01-02" }, end: { date: "2030-01-03" } },
    ] } });
    const r = await googleProvider.listChanges("t", "primary", { syncToken: "OLD", from: new Date(), to: new Date() });
    expect(r.nextSyncToken).toBe("NEXT");
    expect(r.reset).toBe(false);
    expect(calls[0].url).toContain("syncToken=OLD");
    expect(calls[0].url).not.toContain("timeMin");
    expect(r.changes.map((c) => [c.id, !!c.busy])).toEqual([["1", true], ["2", false], ["3", false], ["4", false], ["5", true]]);
  });

  it("expired sync token (410) propagates as kind gone", async () => {
    responder = () => ({ status: 410, body: { error: { message: "Sync token is no longer valid" } } });
    await expect(googleProvider.listChanges("t", "primary", { syncToken: "OLD", from: new Date(), to: new Date() })).rejects.toMatchObject({ kind: "gone" });
  });

  it("creates a watch channel (https only) and stops the old one", async () => {
    responder = (c) => c.url.endsWith("/watch") ? { body: { id: "chan", resourceId: "res", expiration: String(Date.now() + 1000) } } : { status: 204 };
    const s = await googleProvider.refreshSubscription("t", { calendarId: "primary", existing: { id: "old", resourceId: "oldres" }, notificationUrl: "https://app.example.com/api/webhooks/google-calendar", secret: "s" });
    expect(s?.resourceId).toBe("res");
    const watch = calls[0].body as Record<string, unknown>;
    expect(watch.token).toBe("s"); expect(watch.type).toBe("web_hook");
    expect(calls[1].url).toContain("/channels/stop");
    process.env.APP_URL = "http://localhost:3000";
    expect(await googleProvider.refreshSubscription("t", { calendarId: "primary", notificationUrl: "x", secret: "s" })).toBeNull();
  });
});

describe("microsoft provider", () => {
  it("parses calendarView busy intervals as UTC, skipping free/cancelled/own events, and follows nextLink", async () => {
    responder = (c) => c.url.includes("page2") ? { body: { value: [{ id: "c", showAs: "oof", start: { dateTime: "2030-01-01T12:00:00.0000000" }, end: { dateTime: "2030-01-01T13:00:00.0000000" } }] } }
      : { body: { "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2", value: [
        { id: "a", showAs: "busy", start: { dateTime: "2030-01-01T10:00:00.0000000" }, end: { dateTime: "2030-01-01T11:00:00.0000000" } },
        { id: "b", showAs: "free", start: { dateTime: "2030-01-01T10:00:00.0000000" }, end: { dateTime: "2030-01-01T11:00:00.0000000" } },
        { id: "d", showAs: "busy", isCancelled: true, start: { dateTime: "2030-01-01T10:00:00.0000000" }, end: { dateTime: "2030-01-01T11:00:00.0000000" } },
        { id: "e", showAs: "busy", categories: ["MeetFlow"], start: { dateTime: "2030-01-01T10:00:00.0000000" }, end: { dateTime: "2030-01-01T11:00:00.0000000" } },
      ] } };
    const r = await microsoftProvider.getBusyIntervals("t", "cal1", new Date("2030-01-01"), new Date("2030-01-02"));
    expect(r).toEqual([
      { start: new Date("2030-01-01T10:00:00Z"), end: new Date("2030-01-01T11:00:00Z") },
      { start: new Date("2030-01-01T12:00:00Z"), end: new Date("2030-01-01T13:00:00Z") },
    ]);
    expect(calls[0].headers.Prefer).toContain('outlook.timezone="UTC"');
  });

  it("creates a Teams event (isOnlineMeeting) and returns joinUrl; sends transactionId", async () => {
    responder = () => ({ body: { id: "m1", onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" } } });
    const r = await microsoftProvider.createEvent("t", "cal1", { ...input, nativeMeeting: true });
    expect(r).toEqual({ id: "m1", meetingUrl: "https://teams.microsoft.com/l/meetup-join/x" });
    const b = calls[0].body as Record<string, any>;
    expect(b.isOnlineMeeting).toBe(true); expect(b.onlineMeetingProvider).toBe("teamsForBusiness");
    expect(b.transactionId).toBe(input.bookingId);
    expect(b.start).toEqual({ dateTime: "2030-01-01T10:00:00", timeZone: "UTC" });
    expect(b.categories).toEqual(["MeetFlow"]);
  });

  it("update omits immutable fields; delete tolerates 404", async () => {
    responder = () => ({ body: { id: "m1" } });
    await microsoftProvider.updateEvent("t", "cal1", "m1", { ...input, nativeMeeting: true });
    const b = calls[0].body as Record<string, unknown>;
    expect(calls[0].method).toBe("PATCH");
    expect(b.transactionId).toBeUndefined(); expect(b.isOnlineMeeting).toBeUndefined();
    responder = () => ({ status: 404, body: { error: { code: "ErrorItemNotFound" } } });
    await expect(microsoftProvider.deleteEvent("t", "cal1", "m1")).resolves.toBeUndefined();
  });

  it("delta: removed items become removals and deltaLink is the next sync token", async () => {
    responder = (c) => c.url.includes("skip") ? { body: { "@odata.deltaLink": "https://graph/delta?token=D2", value: [{ id: "x", "@removed": { reason: "deleted" } }] } }
      : { body: { "@odata.nextLink": "https://graph/next?skip=1", value: [{ id: "y", showAs: "busy", start: { dateTime: "2030-01-01T10:00:00" }, end: { dateTime: "2030-01-01T11:00:00" } }] } };
    const r = await microsoftProvider.listChanges("t", "cal1", { syncToken: null, from: new Date("2030-01-01"), to: new Date("2030-02-01") });
    expect(r.reset).toBe(true); expect(r.nextSyncToken).toBe("https://graph/delta?token=D2");
    expect(r.changes.map((c) => [c.id, !!c.busy])).toEqual([["y", true], ["x", false]]);
  });

  it("creates then renews a subscription with clientState", async () => {
    responder = (c) => ({ body: { id: "sub1", expirationDateTime: "2030-01-01T00:00:00Z" }, status: c.method === "PATCH" ? 200 : 201 });
    const s = await microsoftProvider.refreshSubscription("t", { calendarId: "cal1", notificationUrl: "https://app.example.com/api/webhooks/microsoft-graph", secret: "sec" });
    expect(s?.id).toBe("sub1");
    expect((calls[0].body as Record<string, unknown>).clientState).toBe("sec");
    await microsoftProvider.refreshSubscription("t", { calendarId: "cal1", existing: { id: "sub1" }, notificationUrl: "x", secret: "sec" });
    expect(calls[1].method).toBe("PATCH");
  });
});

describe("oauth", () => {
  it("state round-trips and rejects wrong user / tampering / expiry", () => {
    const s = createOAuthState("u1", "google");
    expect(verifyOAuthState({ state: s.state, cookie: s.cookie, userId: "u1", provider: "google" }).verifier).toBe(s.verifier);
    expect(() => verifyOAuthState({ state: s.state, cookie: s.cookie, userId: "u2", provider: "google" })).toThrow(/state/);
    expect(() => verifyOAuthState({ state: s.state + "x", cookie: s.cookie, userId: "u1", provider: "google" })).toThrow(/state/);
    expect(() => verifyOAuthState({ state: s.state, cookie: s.cookie, userId: "u1", provider: "microsoft" })).toThrow(/state/);
    expect(() => verifyOAuthState({ state: null, cookie: undefined, userId: "u1", provider: "google" })).toThrow();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(() => verifyOAuthState({ state: s.state, cookie: s.cookie, userId: "u1", provider: "google" })).toThrow(/expired/);
    vi.useRealTimers();
  });

  it("auth url carries PKCE S256 challenge, offline access and exact redirect uri", () => {
    const s = createOAuthState("u1", "google");
    const u = new URL(buildAuthUrl("google", s.state, s.verifier));
    expect(u.searchParams.get("code_challenge")).toBe(challengeFor(s.verifier));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/integrations/google/callback");
  });

  it("refresh keeps old refresh token when provider omits a new one", async () => {
    responder = () => ({ body: { access_token: "new", expires_in: 3600 } });
    const t = await refreshTokens("google", { accessToken: "old", refreshToken: "rt", expiresAt: 0 });
    expect(t.accessToken).toBe("new"); expect(t.refreshToken).toBe("rt");
    expect(String(calls[0].body)).toContain("grant_type=refresh_token");
  });

  it("invalid_grant on refresh is classified as auth (revoked)", async () => {
    responder = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    await expect(refreshTokens("google", { accessToken: "o", refreshToken: "rt", expiresAt: 0 })).rejects.toMatchObject({ kind: "auth" });
  });

  it("transient token endpoint failures are NOT treated as revocation", async () => {
    responder = () => ({ status: 503, body: {} });
    const err = (await refreshTokens("google", { accessToken: "o", refreshToken: "rt", expiresAt: 0 }).catch((e) => e)) as ProviderError;
    expect(err.kind).toBe("transient");
  });
});

describe("helpers", () => {
  it("mergeIntervals merges overlaps and adjacency", () => {
    const d = (h: number) => new Date(Date.UTC(2030, 0, 1, h));
    const r = mergeIntervals([{ start: d(12), end: d(13) }, { start: d(9), end: d(10) }, { start: d(9.5 as number), end: d(11) }, { start: d(11), end: d(11.5 as number) }]);
    expect(r.map((i) => [i.start.getTime(), i.end.getTime()])).toEqual([[d(9).getTime(), d(11).getTime()], [d(12).getTime(), d(13).getTime()]]);
  });
  it("passthrough locations", () => {
    expect(passthroughLocation("custom_url", "https://x.test/j")).toEqual({ meetingUrl: "https://x.test/j" });
    expect(passthroughLocation("in_person", "1 Main St")).toEqual({ location: "1 Main St" });
    expect(passthroughLocation("phone", "+1 555")).toEqual({ location: "Phone: +1 555" });
    expect(passthroughLocation("google_meet", "x")).toEqual({});
  });
});
