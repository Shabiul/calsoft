import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  buildLimitIndex, expandAvailability, generateSlotStarts, intersectIntervals, mergeIntervals, pickHost,
  subtractIntervals, withinLimits, type Interval,
} from "./availability";

const Z = (iso: string) => DateTime.fromISO(iso, { zone: "utc" }).toMillis();
const iv = (a: string, b: string): Interval => ({ start: Z(a), end: Z(b) });
const hours = (i: Interval) => (i.end - i.start) / 3_600_000;
const expand = (tz: string, rules: { weekday: number; startTime: string; endTime: string }[], fromIso: string, toIso: string, overrides: Parameters<typeof expandAvailability>[0]["overrides"] = []) =>
  expandAvailability({ rules, overrides, timeZone: tz, from: Z(fromIso), to: Z(toIso) });

describe("interval helpers", () => {
  it("merges, subtracts, intersects", () => {
    expect(mergeIntervals([iv("2026-01-01T10:00Z", "2026-01-01T11:00Z"), iv("2026-01-01T09:00Z", "2026-01-01T10:00Z")])).toEqual([iv("2026-01-01T09:00Z", "2026-01-01T11:00Z")]);
    expect(subtractIntervals([iv("2026-01-01T09:00Z", "2026-01-01T17:00Z")], [iv("2026-01-01T12:00Z", "2026-01-01T13:00Z"), iv("2026-01-01T08:00Z", "2026-01-01T09:30Z")]))
      .toEqual([iv("2026-01-01T09:30Z", "2026-01-01T12:00Z"), iv("2026-01-01T13:00Z", "2026-01-01T17:00Z")]);
    expect(intersectIntervals([iv("2026-01-01T09:00Z", "2026-01-01T12:00Z")], [iv("2026-01-01T11:00Z", "2026-01-01T14:00Z")])).toEqual([iv("2026-01-01T11:00Z", "2026-01-01T12:00Z")]);
  });
});

describe("expandAvailability (DST-correct)", () => {
  it("America/New_York spring forward 2026-03-08: Sunday 01:00-04:00 local is only 2 real hours", () => {
    const r = expand("America/New_York", [{ weekday: 0, startTime: "01:00", endTime: "04:00" }], "2026-03-08T00:00Z", "2026-03-09T00:00Z");
    expect(r).toEqual([iv("2026-03-08T06:00Z", "2026-03-08T08:00Z")]); // 01:00 EST -> 04:00 EDT
    expect(hours(r[0])).toBe(2);
  });
  it("America/New_York keeps 9-17 local across the transition (UTC offset shifts, never +24h)", () => {
    const rules = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" }));
    const r = expand("America/New_York", rules, "2026-03-06T05:00Z", "2026-03-11T00:00Z");
    expect(r[0]).toEqual(iv("2026-03-06T14:00Z", "2026-03-06T22:00Z")); // Fri EST
    expect(r[1]).toEqual(iv("2026-03-09T13:00Z", "2026-03-09T21:00Z")); // Mon EDT
    expect(r[2]).toEqual(iv("2026-03-10T13:00Z", "2026-03-10T21:00Z"));
  });
  it("America/New_York fall back 2026-11-01: Sunday 00:00-04:00 local is 5 real hours", () => {
    const r = expand("America/New_York", [{ weekday: 0, startTime: "00:00", endTime: "04:00" }], "2026-11-01T00:00Z", "2026-11-02T12:00Z");
    expect(r).toEqual([iv("2026-11-01T04:00Z", "2026-11-01T09:00Z")]);
    expect(hours(r[0])).toBe(5);
  });
  it("whole-day 00:00-24:00 on DST days is 23h / 25h", () => {
    const rule = [{ weekday: 0, startTime: "00:00", endTime: "24:00" }];
    expect(hours(expand("America/New_York", rule, "2026-03-08T00:00Z", "2026-03-08T12:00Z")[0])).toBe(23);
    expect(hours(expand("America/New_York", rule, "2026-11-01T00:00Z", "2026-11-01T12:00Z")[0])).toBe(25);
  });
  it("Europe/London spring forward 2026-03-29 and fall back 2026-10-25", () => {
    const spring = expand("Europe/London", [{ weekday: 0, startTime: "00:00", endTime: "03:00" }], "2026-03-29T00:00Z", "2026-03-30T00:00Z");
    expect(spring).toEqual([iv("2026-03-29T00:00Z", "2026-03-29T02:00Z")]); // 00:00 GMT -> 03:00 BST
    const fall = expand("Europe/London", [{ weekday: 0, startTime: "00:00", endTime: "03:00" }], "2026-10-24T23:00Z", "2026-10-26T00:00Z");
    expect(fall).toEqual([iv("2026-10-24T23:00Z", "2026-10-25T03:00Z")]); // 00:00 BST -> 03:00 GMT = 4h
  });
  it("Asia/Kolkata (+05:30, no DST)", () => {
    const r = expand("Asia/Kolkata", [{ weekday: 3, startTime: "09:00", endTime: "17:00" }], "2026-06-01T00:00Z", "2026-06-04T00:00Z");
    expect(r).toEqual([iv("2026-06-03T03:30Z", "2026-06-03T11:30Z")]);
  });
  it("overrides: whole day off, custom hours replace the weekly rule", () => {
    const rules = [{ weekday: 1, startTime: "09:00", endTime: "17:00" }];
    const off = expand("UTC", rules, "2026-06-01T00:00Z", "2026-06-02T00:00Z", [{ date: "2026-06-01", isUnavailable: true, startTime: null, endTime: null }]);
    expect(off).toEqual([]);
    const custom = expand("UTC", rules, "2026-06-01T00:00Z", "2026-06-02T00:00Z", [{ date: "2026-06-01", isUnavailable: false, startTime: "10:00:00", endTime: "12:00:00" }]);
    expect(custom).toEqual([iv("2026-06-01T10:00Z", "2026-06-01T12:00Z")]);
    const extra = expand("UTC", [], "2026-06-06T00:00Z", "2026-06-07T00:00Z", [{ date: "2026-06-06", isUnavailable: false, startTime: "08:00", endTime: "09:00" }]);
    expect(extra).toEqual([iv("2026-06-06T08:00Z", "2026-06-06T09:00Z")]);
  });
  it("rejects an invalid time zone", () => {
    expect(() => expand("Not/AZone", [], "2026-06-01T00:00Z", "2026-06-02T00:00Z")).toThrow();
  });
});

const base = {
  busyBlocks: [] as Interval[], busyHard: [] as Interval[], durationMin: 30,
  from: Z("2026-06-01T00:00Z"), to: Z("2026-06-02T00:00Z"), earliest: 0, latest: Number.MAX_SAFE_INTEGER,
};
const day = [iv("2026-06-01T09:00Z", "2026-06-01T12:00Z")];
const t = (s: number[]) => s.map((x) => new Date(x).toISOString().slice(11, 16));

describe("generateSlotStarts", () => {
  it("duration & default interval", () => {
    expect(t(generateSlotStarts({ ...base, availability: day }))).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
  });
  it("custom slot interval keeps the full duration inside availability", () => {
    expect(t(generateSlotStarts({ ...base, availability: day, durationMin: 60, intervalMin: 30 }))).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
  });
  it("busy time removes overlapping slots only", () => {
    const s = generateSlotStarts({ ...base, availability: day, busyHard: [iv("2026-06-01T10:00Z", "2026-06-01T10:30Z")] });
    expect(t(s)).toEqual(["09:00", "09:30", "10:30", "11:00", "11:30"]);
  });
  it("buffers: an existing booking's block + the new slot's buffers both apply", () => {
    // existing booking 10:00-10:30 with no own buffers; new event has 15m before/after
    const s = generateSlotStarts({ ...base, availability: day, bufferBeforeMin: 15, bufferAfterMin: 15, busyBlocks: [iv("2026-06-01T10:00Z", "2026-06-01T10:30Z")], intervalMin: 15 });
    expect(t(s)).toEqual(["09:00", "09:15", "10:45", "11:00", "11:15", "11:30"]);
  });
  it("buffers do not need to fit inside availability", () => {
    const s = generateSlotStarts({ ...base, availability: [iv("2026-06-01T09:00Z", "2026-06-01T09:30Z")], bufferBeforeMin: 30, bufferAfterMin: 30 });
    expect(t(s)).toEqual(["09:00"]);
  });
  it("min notice and max horizon", () => {
    const s = generateSlotStarts({ ...base, availability: day, earliest: Z("2026-06-01T10:10Z"), latest: Z("2026-06-01T11:00Z") });
    expect(t(s)).toEqual(["10:30", "11:00"]);
  });
  it("from/to restrict slot starts but not the grid anchor", () => {
    const s = generateSlotStarts({ ...base, availability: [iv("2026-06-01T09:10Z", "2026-06-01T11:00Z")], durationMin: 30, from: Z("2026-06-01T09:45Z"), to: Z("2026-06-01T10:40Z") });
    expect(t(s)).toEqual(["10:10"]);
  });
});

describe("limits", () => {
  it("daily & weekly limits are evaluated in the host's time zone", () => {
    // 2026-06-02 02:00Z is still Monday June 1 in New York
    const idx = buildLimitIndex([Z("2026-06-02T02:00Z"), Z("2026-06-02T03:00Z")], "America/New_York");
    expect(withinLimits(Z("2026-06-01T15:00Z"), idx, 2, null)).toBe(false); // same NY day (Mon)
    expect(withinLimits(Z("2026-06-02T15:00Z"), idx, 2, null)).toBe(true);  // Tue
    expect(withinLimits(Z("2026-06-04T15:00Z"), idx, null, 2)).toBe(false); // same ISO week
    expect(withinLimits(Z("2026-06-08T15:00Z"), idx, null, 2)).toBe(true);  // next week
    expect(withinLimits(Z("2026-06-04T15:00Z"), idx, null, null)).toBe(true);
    // same instants in UTC land on a different day
    const utc = buildLimitIndex([Z("2026-06-02T02:00Z"), Z("2026-06-02T03:00Z")], "UTC");
    expect(withinLimits(Z("2026-06-01T15:00Z"), utc, 2, null)).toBe(true);
  });
});

describe("pickHost", () => {
  const c = (userId: string, priority: number, weight: number, load: number) => ({ userId, priority, weight, load });
  it("prefers lower priority number", () => expect(pickHost([c("a", 2, 1, 0), c("b", 1, 1, 9)])?.userId).toBe("b"));
  it("least weighted load within priority", () => expect(pickHost([c("a", 0, 1, 4), c("b", 0, 2, 4), c("c", 0, 1, 5)])?.userId).toBe("b"));
  it("deterministic tie-break", () => expect(pickHost([c("z", 0, 1, 0), c("m", 0, 1, 0)])?.userId).toBe("m"));
  it("empty", () => expect(pickHost([])).toBeUndefined());
});
