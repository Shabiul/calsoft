import { describe, expect, it } from "vitest";
import { mergeIntervals, resolveAllDay } from "./busy";
import type { Interval } from "./types";

const allDay = (startDate: string, endDate: string): Interval => ({ start: new Date(`${startDate}T00:00:00Z`), end: new Date(`${endDate}T00:00:00Z`), allDay: { startDate, endDate } });
const iso = (i: Interval) => [i.start.toISOString(), i.end.toISOString()];

describe("resolveAllDay (all-day events are local days, not UTC days)", () => {
  it("a UTC host blocks exactly the UTC day", () => {
    expect(iso(resolveAllDay([allDay("2026-11-14", "2026-11-15")], "UTC")[0]!)).toEqual(["2026-11-14T00:00:00.000Z", "2026-11-15T00:00:00.000Z"]);
  });
  it("a Pacific host's all-day Nov 14 is Nov 14 00:00-24:00 LOCAL, not the previous evening", () => {
    // PST = UTC-8: local midnight Nov 14 = 08:00Z. UTC-midnight would have blocked Nov 13 16:00 local onward.
    expect(iso(resolveAllDay([allDay("2026-11-14", "2026-11-15")], "America/Los_Angeles")[0]!)).toEqual(["2026-11-14T08:00:00.000Z", "2026-11-15T08:00:00.000Z"]);
  });
  it("an Indian host's all-day Nov 14 starts at local midnight (18:30Z the day before)", () => {
    expect(iso(resolveAllDay([allDay("2026-11-14", "2026-11-15")], "Asia/Kolkata")[0]!)).toEqual(["2026-11-13T18:30:00.000Z", "2026-11-14T18:30:00.000Z"]);
  });
  it("handles the +05:45 offset", () => {
    expect(iso(resolveAllDay([allDay("2026-11-14", "2026-11-15")], "Asia/Kathmandu")[0]!)).toEqual(["2026-11-13T18:15:00.000Z", "2026-11-14T18:15:00.000Z"]);
  });
  it("multi-day events cover every local day (end date exclusive)", () => {
    const [r] = resolveAllDay([allDay("2026-12-24", "2026-12-27")], "Asia/Kolkata");
    expect((r!.end.getTime() - r!.start.getTime()) / 3_600_000).toBe(72);
  });
  it("an all-day event on a DST transition day is 23h / 25h long", () => {
    const spring = resolveAllDay([allDay("2026-03-08", "2026-03-09")], "America/New_York")[0]!;
    const fall = resolveAllDay([allDay("2026-11-01", "2026-11-02")], "America/New_York")[0]!;
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
  });
  it("a missing or odd end date still blocks one day", () => {
    expect((resolveAllDay([allDay("2026-11-14", "2026-11-14")], "UTC")[0]!.end.getTime() - Date.UTC(2026, 10, 14)) / 3_600_000).toBe(24);
    expect((resolveAllDay([allDay("2026-11-14", "garbage")], "UTC")[0]!.end.getTime() - Date.UTC(2026, 10, 14)) / 3_600_000).toBe(24);
  });
  it("an invalid host zone falls back to UTC instead of throwing; timed events pass through untouched", () => {
    const timed: Interval = { start: new Date("2026-11-14T10:00:00Z"), end: new Date("2026-11-14T11:00:00Z") };
    const out = resolveAllDay([allDay("2026-11-14", "2026-11-15"), timed], "Not/AZone");
    expect(iso(out[0]!)).toEqual(["2026-11-14T00:00:00.000Z", "2026-11-15T00:00:00.000Z"]);
    expect(out[1]).toBe(timed);
  });
  it("resolved all-day blocks merge with overlapping timed events", () => {
    const merged = mergeIntervals(resolveAllDay([allDay("2026-11-14", "2026-11-15"), { start: new Date("2026-11-14T20:00:00Z"), end: new Date("2026-11-14T21:00:00Z") }], "Asia/Kolkata"));
    expect(merged).toHaveLength(2); // 18:30Z Nov 13 -> 18:30Z Nov 14, then the 20:00Z event is separate
  });
});
