import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { zohoCalendar, zohoDate, parseZohoDate } from "./zoho";
import { ProviderError } from "./http";

type Call = { url: string; method: string; headers: Record<string, string> };
let calls: Call[];
let handler: (url: string, method: string) => { status?: number; body?: unknown };

beforeEach(() => {
  calls = [];
  handler = () => ({ body: {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: init?.headers as Record<string, string> });
    const r = handler(url, method);
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.body ?? {}), { status });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const input = {
  bookingId: "b1", title: "Intro", description: "Hi", startsAt: new Date("2030-01-02T10:30:00Z"), endsAt: new Date("2030-01-02T11:00:00Z"),
  attendees: [{ email: "a@x.com", name: "A" }],
};
const eventdata = (url: string) => JSON.parse(decodeURIComponent(url.split("eventdata=")[1]));

describe("dates", () => {
  it("formats and parses", () => {
    expect(zohoDate(new Date("2030-01-02T10:30:05Z"))).toBe("20300102T103005Z");
    expect(parseZohoDate("20170718T205000+0530")?.toISOString()).toBe("2017-07-18T15:20:00.000Z");
    expect(parseZohoDate("20170718T205000-0800")?.toISOString()).toBe("2017-07-19T04:50:00.000Z");
    expect(parseZohoDate("20170718T205000Z")?.toISOString()).toBe("2017-07-18T20:50:00.000Z");
    expect(parseZohoDate("20170718")?.toISOString()).toBe("2017-07-18T00:00:00.000Z");
    expect(parseZohoDate("garbage")).toBeNull();
  });
});

describe("getCalendars", () => {
  it("maps primary/writable and uses Zoho auth header", async () => {
    handler = () => ({ body: { calendars: [{ uid: "c1", name: "Mine", isdefault: true, privilege: "owner" }, { uid: "c2", name: "Shared", privilege: "view" }] } });
    const r = await zohoCalendar.getCalendars("tok");
    expect(r).toEqual([
      { externalId: "c1", name: "Mine", primary: true, writable: true },
      { externalId: "c2", name: "Shared", primary: false, writable: false },
    ]);
    expect(calls[0].url).toBe("https://calendar.zoho.com/api/v1/calendars");
    expect(calls[0].headers.Authorization).toBe("Zoho-oauthtoken tok");
  });
});

describe("getBusyIntervals", () => {
  it("skips free/own events, parses offsets, chunks into <=31 day ranges", async () => {
    handler = (url) => url.includes("range=") && calls.length === 1 ? { body: { events: [
      { uid: "e1", dateandtime: { start: "20300102T103000+0530", end: "20300102T113000+0530" } },
      { uid: "e2", transparency: "free", dateandtime: { start: "20300102T103000Z", end: "20300102T113000Z" } },
      { uid: "e3", description: "x\n\nBooked via MeetFlow", dateandtime: { start: "20300102T103000Z", end: "20300102T113000Z" } },
      { uid: "e4", dateandtime: { start: "20300102T103000Z", end: "20300102T103000Z" } },
    ] } } : { body: {} };
    const out = await zohoCalendar.getBusyIntervals("t", "c1", new Date("2030-01-01T00:00:00Z"), new Date("2030-03-01T00:00:00Z"));
    expect(out).toEqual([{ start: new Date("2030-01-02T05:00:00Z"), end: new Date("2030-01-02T06:00:00Z") }]);
    expect(calls.length).toBe(2);
    const range = JSON.parse(new URL(calls[0].url).searchParams.get("range")!);
    expect(range.start).toBe("20300101T000000Z");
  });
});

describe("createEvent", () => {
  it("sends eventdata with UTC dates, attendees, meeting url in location", async () => {
    handler = () => ({ body: { events: [{ uid: "new1", etag: 1 }] } });
    const r = await zohoCalendar.createEvent("t", "c1", { ...input, meetingUrl: "https://zoom.us/j/1", nativeMeeting: true });
    expect(r).toEqual({ id: "new1" });
    expect(calls[0].method).toBe("POST");
    const d = eventdata(calls[0].url);
    expect(d.dateandtime).toEqual({ timezone: "UTC", start: "20300102T103000Z", end: "20300102T110000Z" });
    expect(d.attendees[0].email).toBe("a@x.com");
    expect(d.location).toBe("https://zoom.us/j/1");
    expect(d.description).toContain("Join: https://zoom.us/j/1");
  });
  it("uses plain location otherwise", async () => {
    handler = () => ({ body: { events: [{ uid: "n" }] } });
    await zohoCalendar.createEvent("t", "c1", { ...input, location: "Office" });
    expect(eventdata(calls[0].url).location).toBe("Office");
  });
  it("classifies 401 and 429", async () => {
    handler = () => ({ status: 401, body: { error: "invalid" } });
    await expect(zohoCalendar.createEvent("t", "c1", input)).rejects.toMatchObject({ kind: "auth" });
    handler = () => ({ status: 429, body: {} });
    const e = await zohoCalendar.createEvent("t", "c1", input).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe("rate_limit");
    expect(e.retryable).toBe(true);
  });
});

describe("updateEvent", () => {
  it("fetches etag then PUTs with it", async () => {
    handler = (_u, m) => m === "GET" ? { body: { events: [{ uid: "e1", etag: 1500612091546 }] } } : { body: { events: [{ uid: "e1", etag: 2 }] } };
    const r = await zohoCalendar.updateEvent("t", "c1", "e1", input);
    expect(r).toEqual({ id: "e1" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(calls[1].headers.etag).toBe("1500612091546");
    expect(eventdata(calls[1].url).etag).toBe("1500612091546");
  });
});

describe("deleteEvent", () => {
  it("sends etag header on DELETE", async () => {
    handler = (_u, m) => m === "GET" ? { body: { events: [{ uid: "e1", etag: 7 }] } } : { body: { events: [{ uid: "e1", estatus: "deleted" }] } };
    await zohoCalendar.deleteEvent("t", "c1", "e1");
    expect(calls[1].method).toBe("DELETE");
    expect(calls[1].headers.etag).toBe("7");
  });
  it("treats 404 as success on lookup and on delete", async () => {
    handler = () => ({ status: 404, body: {} });
    await expect(zohoCalendar.deleteEvent("t", "c1", "e1")).resolves.toBeUndefined();
    handler = (_u, m) => m === "GET" ? { body: { events: [{ uid: "e1", etag: 7 }] } } : { status: 404, body: {} };
    await expect(zohoCalendar.deleteEvent("t", "c1", "e1")).resolves.toBeUndefined();
  });
  it("propagates auth errors", async () => {
    handler = () => ({ status: 401, body: {} });
    await expect(zohoCalendar.deleteEvent("t", "c1", "e1")).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("subscriptions and listChanges", () => {
  it("has no push", async () => {
    expect(await zohoCalendar.refreshSubscription("t", { calendarId: "c1", notificationUrl: "https://x", secret: "s" })).toBeNull();
    await expect(zohoCalendar.stopSubscription("t", { id: "x" })).resolves.toBeUndefined();
    expect(calls.length).toBe(0);
  });
  it("lists a full window with reset", async () => {
    handler = () => ({ body: { events: [
      { uid: "e1", dateandtime: { start: "20300102T103000Z", end: "20300102T113000Z" } },
      { uid: "e2", transparency: "free", dateandtime: { start: "20300102T103000Z", end: "20300102T113000Z" } },
    ] } });
    const r = await zohoCalendar.listChanges("t", "c1", { syncToken: "ignored", from: new Date("2030-01-01T00:00:00Z"), to: new Date("2030-01-10T00:00:00Z") });
    expect(r.reset).toBe(true);
    expect(r.nextSyncToken).toBeNull();
    expect(r.changes.map((c) => [c.id, !!c.busy])).toEqual([["e1", true], ["e2", false]]);
    expect(calls[0].url).toContain("byinstance=true");
  });
  it("gives recurring occurrences unique ids and dedupes across chunks", async () => {
    const occ = (rid: string, day: string) => ({ uid: "r1", recurrenceid: rid, dateandtime: { start: `${day}T100000Z`, end: `${day}T110000Z` } });
    handler = () => ({ body: { events: [occ("20300102T100000Z", "20300102"), occ("20300109T100000Z", "20300109")] } });
    const r = await zohoCalendar.listChanges("t", "c1", { from: new Date("2030-01-01T00:00:00Z"), to: new Date("2030-03-01T00:00:00Z") });
    expect(calls.length).toBe(2); // two chunks, same payload: duplicates must collapse
    expect(r.changes.map((c) => c.id)).toEqual(["r1:20300102T100000Z", "r1:20300109T100000Z"]);
  });
});
