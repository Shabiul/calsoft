import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { expandAvailability, generateSlotStarts, type Interval } from "./availability";
import { generateIcs } from "../notifications/ics";
import { formatWhen } from "../notifications/templates";

const Z = (iso: string) => DateTime.fromISO(iso, { zone: "utc" }).toMillis();
const local = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat("HH:mm");

describe("working hours with a lunch break (QA matrix: 10-13 and 14-19, 45-minute meetings)", () => {
  const tz = "Asia/Kolkata";
  // Monday 2026-11-23, 10:00-13:00 and 14:00-19:00 local.
  const rules = [{ weekday: 1, startTime: "10:00", endTime: "13:00" }, { weekday: 1, startTime: "14:00", endTime: "19:00" }];
  const availability = expandAvailability({ rules, overrides: [], timeZone: tz, from: Z("2026-11-22T18:30:00Z"), to: Z("2026-11-23T18:30:00Z") });
  const slots = (intervalMin: number) => generateSlotStarts({
    availability, busyBlocks: [], busyHard: [], durationMin: 45, intervalMin, from: Z("2026-11-22T18:30:00Z"), to: Z("2026-11-23T18:30:00Z"),
    earliest: 0, latest: Number.MAX_SAFE_INTEGER,
  }).map((t) => local(t, tz));

  it("the availability is two separate windows", () => expect(availability).toHaveLength(2));
  it("a 45-minute meeting never starts at 12:30 and spills into the 13:00-14:00 break (15-minute grid)", () => {
    const s = slots(15);
    expect(s).not.toContain("12:30");
    expect(s).not.toContain("12:25");
    expect(s).toContain("12:15"); // last morning start: 12:15 + 45 = 13:00 exactly
    expect(s.filter((x) => x >= "12:16" && x < "14:00")).toEqual([]);
  });
  it("the afternoon starts right at 14:00 and the last start is 18:15 (ends at 19:00)", () => {
    const s = slots(15);
    expect(s).toContain("14:00");
    expect(s[s.length - 1]).toBe("18:15");
  });
  it("on the default grid (step = duration) each window is filled without crossing the break", () => {
    expect(slots(0)).toEqual(["10:00", "10:45", "11:30", "12:15", "14:00", "14:45", "15:30", "16:15", "17:00", "17:45"]);
  });
});

describe("cross-time-zone instants (host Kolkata +05:30, bookee New York / Kathmandu +05:45)", () => {
  const start = new Date("2026-11-20T09:00:00Z"), end = new Date("2026-11-20T09:30:00Z");

  it("renders the same instant correctly in each zone", () => {
    expect(formatWhen(start, "Asia/Kolkata")).toContain("2:30 PM");
    expect(formatWhen(start, "Asia/Kathmandu")).toContain("2:45 PM");
    expect(formatWhen(start, "America/New_York")).toContain("4:00 AM");
    expect(formatWhen(start, "America/New_York")).toContain("November 20");
  });
  it("a late-evening instant lands on the next calendar day in the east and the previous day in the west", () => {
    const late = new Date("2026-11-20T20:00:00Z");
    expect(formatWhen(late, "Asia/Kathmandu")).toContain("November 21"); // 01:45 next day
    expect(formatWhen(late, "America/Los_Angeles")).toContain("November 20"); // 12:00
  });
  it("the .ics carries the exact UTC instant, so every calendar shows the same moment in the viewer's own zone", () => {
    const ics = generateIcs({ uid: "u@meetflow", startsAt: start, endsAt: end, summary: "Intro" });
    expect(ics).toContain("DTSTART:20261120T090000Z");
    expect(ics).toContain("DTEND:20261120T093000Z");
  });
  it("the quarter-hour zone converts back to the identical instant", () => {
    const k = DateTime.fromJSDate(start, { zone: "Asia/Kathmandu" });
    expect(k.offset).toBe(345);
    expect(k.toUTC().toISO()).toBe("2026-11-20T09:00:00.000Z");
  });
});

describe("minimum notice boundary", () => {
  const day: Interval[] = [{ start: Z("2026-11-23T09:00:00Z"), end: Z("2026-11-23T12:00:00Z") }];
  const gen = (earliest: string) => generateSlotStarts({
    availability: day, busyBlocks: [], busyHard: [], durationMin: 30, from: Z("2026-11-23T00:00:00Z"), to: Z("2026-11-24T00:00:00Z"),
    earliest: Z(earliest), latest: Number.MAX_SAFE_INTEGER,
  }).map((t) => DateTime.fromMillis(t, { zone: "utc" }).toFormat("HH:mm"));

  it("a start exactly at now + notice is allowed", () => expect(gen("2026-11-23T10:00:00Z")).toContain("10:00"));
  it("one minute inside the notice window is refused", () => expect(gen("2026-11-23T10:01:00Z")).not.toContain("10:00"));
});
