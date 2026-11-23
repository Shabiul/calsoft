import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleProvider } from "./google";
import { microsoftProvider } from "./microsoft";

/** What counts as "busy" when we read a host's calendar (QA matrix: free vs busy, declined, out-of-office, private, all-day, recurring). */
let calls: { url: string }[] = [];
let respond: (url: string) => unknown;
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push({ url: String(url) }); return new Response(JSON.stringify(respond(String(url))), { status: 200 }); }));
});
afterEach(() => vi.unstubAllGlobals());

const win = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2027-01-01T00:00:00Z") };
const timed = (id: string, extra: Record<string, unknown> = {}) => ({
  id, status: "confirmed", start: { dateTime: "2026-11-20T10:00:00Z" }, end: { dateTime: "2026-11-20T11:00:00Z" }, ...extra,
});

describe("Google: which events block time (sync path)", () => {
  const run = async (items: unknown[]) => {
    respond = () => ({ items, nextSyncToken: "NEXT" });
    return googleProvider.listChanges("t", "primary", { syncToken: null, ...win });
  };
  const busyOf = (r: Awaited<ReturnType<typeof run>>, id: string) => r.changes.find((c) => c.id === id)!.busy;

  it("busy, tentative and out-of-office events block; free (transparent) and cancelled do not", async () => {
    const r = await run([
      timed("busy"), timed("tent", { attendees: [{ self: true, responseStatus: "tentative" }] }),
      timed("ooo", { eventType: "outOfOffice" }), timed("free", { transparency: "transparent" }), timed("gone", { status: "cancelled" }),
    ]);
    expect(busyOf(r, "busy")).not.toBeNull();
    expect(busyOf(r, "tent")).not.toBeNull();
    expect(busyOf(r, "ooo")).not.toBeNull();
    expect(busyOf(r, "free")).toBeNull();
    expect(busyOf(r, "gone")).toBeNull();
  });
  it("an invite the host DECLINED does not block time, but one declined by someone else does", async () => {
    const r = await run([
      timed("declined", { attendees: [{ self: true, responseStatus: "declined" }, { responseStatus: "accepted" }] }),
      timed("other-declined", { attendees: [{ self: true, responseStatus: "accepted" }, { responseStatus: "declined" }] }),
    ]);
    expect(busyOf(r, "declined")).toBeNull();
    expect(busyOf(r, "other-declined")).not.toBeNull();
  });
  it("working-location markers ('Working from home') do not block time", async () => {
    const r = await run([timed("wl", { eventType: "workingLocation" })]);
    expect(busyOf(r, "wl")).toBeNull();
  });
  it("our own bookings are not double counted", async () => {
    const r = await run([timed("own", { extendedProperties: { private: { meetflowBookingId: "b1" } } })]);
    expect(busyOf(r, "own")).toBeNull();
  });
  it("all-day events come back as DATES for the host-timezone resolver, not as UTC instants", async () => {
    const r = await run([{ id: "hol", status: "confirmed", start: { date: "2026-11-14" }, end: { date: "2026-11-15" } }]);
    expect(busyOf(r, "hol")?.allDay).toEqual({ startDate: "2026-11-14", endDate: "2026-11-15" });
  });
  it("private/confidential events never leak details: a busy window carries only times", async () => {
    const r = await run([timed("secret", { summary: "Divorce lawyer", description: "very private", visibility: "private", attendees: [{ email: "x@y.z" }] })]);
    const b = busyOf(r, "secret")!;
    expect(Object.keys(b).sort()).toEqual(["end", "start"]);
    expect(JSON.stringify(b)).not.toMatch(/lawyer|private|x@y/);
  });
  it("recurring events are read as individual instances (a moved or cancelled single occurrence only affects its own date)", async () => {
    await run([]);
    expect(calls[0]!.url).toContain("singleEvents=true");
    // An incremental change to ONE instance arrives as that instance's id; the others are untouched.
    respond = () => ({ items: [timed("series_20261120", { status: "cancelled" })], nextSyncToken: "N2" });
    const inc = await googleProvider.listChanges("t", "primary", { syncToken: "N1", ...win });
    expect(inc.reset).toBe(false);
    expect(inc.changes).toEqual([{ id: "series_20261120", busy: null }]);
  });
});

describe("Microsoft: which events block time", () => {
  const ev = (id: string, extra: Record<string, unknown> = {}) => ({
    id, showAs: "busy", isCancelled: false, start: { dateTime: "2026-11-20T10:00:00.0000000" }, end: { dateTime: "2026-11-20T11:00:00.0000000" }, ...extra,
  });
  const busy = async (items: unknown[]) => { respond = () => ({ value: items }); return microsoftProvider.getBusyIntervals("t", "cal1", win.from, win.to); };

  it("busy, tentative and out-of-office block; free and 'working elsewhere' do not", async () => {
    expect(await busy([ev("a"), ev("b", { showAs: "tentative" }), ev("c", { showAs: "oof" })])).toHaveLength(3);
    expect(await busy([ev("d", { showAs: "free" }), ev("e", { showAs: "workingElsewhere" })])).toHaveLength(0);
  });
  it("cancelled events and events the host declined do not block", async () => {
    expect(await busy([ev("x", { isCancelled: true }), ev("y", { responseStatus: { response: "declined" } })])).toHaveLength(0);
    expect(await busy([ev("z", { responseStatus: { response: "accepted" } }), ev("w", { responseStatus: { response: "tentativelyAccepted" } })])).toHaveLength(2);
  });
  it("our own MeetFlow events are not double counted", async () => {
    expect(await busy([ev("own", { categories: ["MeetFlow"] })])).toHaveLength(0);
  });
  it("all-day events come back as dates for the host-timezone resolver", async () => {
    const [i] = await busy([ev("hol", { isAllDay: true, start: { dateTime: "2026-11-14T00:00:00.0000000" }, end: { dateTime: "2026-11-15T00:00:00.0000000" } })]);
    expect(i!.allDay).toEqual({ startDate: "2026-11-14", endDate: "2026-11-15" });
  });
  it("busy windows never carry subject/body (private events cannot leak)", async () => {
    const [i] = await busy([ev("s", { subject: "Therapy", body: { content: "private" }, sensitivity: "private" })]);
    expect(Object.keys(i!).sort()).toEqual(["end", "start"]);
  });
  it("asks Graph for the response status and all-day flag the rules above depend on", async () => {
    await busy([]);
    expect(decodeURIComponent(calls[0]!.url)).toMatch(/\$select=[^&]*responseStatus/);
    expect(decodeURIComponent(calls[0]!.url)).toMatch(/\$select=[^&]*isAllDay/);
  });
});
