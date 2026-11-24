import { describe, expect, it } from "vitest";
import { planReminders } from "./reminders";

describe("planReminders: 9 AM on the day and 10 minutes before", () => {
  const now = new Date("2030-03-04T00:00:00Z");
  it("plans both, 9:00 in the invitee's zone", () => {
    const start = new Date("2030-03-05T14:00:00Z"); // 09:00 Lagos (UTC+1) = 08:00Z
    const p = planReminders(start, [0, 10], now, "Africa/Lagos");
    expect(p.map((r) => r.minutesBefore)).toEqual([0, 10]);
    expect(p[0]!.sendAt.toISOString()).toBe("2030-03-05T08:00:00.000Z");
    expect(p[1]!.sendAt.toISOString()).toBe("2030-03-05T13:50:00.000Z");
  });
  it("skips the morning mail when the meeting is within an hour of 9:00", () => {
    expect(planReminders(new Date("2030-03-05T08:30:00Z"), [0, 10], now, "Africa/Lagos").map((r) => r.minutesBefore)).toEqual([10]);
  });
  it("skips reminders that are already in the past", () => {
    expect(planReminders(new Date("2030-03-04T00:05:00Z"), [0, 10], now, "UTC")).toEqual([]);
  });
});
