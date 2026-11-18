import { z } from "zod";

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const timeStr = z.string().regex(TIME_RE, "Use 24h HH:mm");

export const WEEKDAYS = [
  { value: 0, label: "Sunday", short: "Sun" },
  { value: 1, label: "Monday", short: "Mon" },
  { value: 2, label: "Tuesday", short: "Tue" },
  { value: 3, label: "Wednesday", short: "Wed" },
  { value: 4, label: "Thursday", short: "Thu" },
  { value: 5, label: "Friday", short: "Fri" },
  { value: 6, label: "Saturday", short: "Sat" },
] as const;

export const toMinutes = (t: string): number => {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
};
/** Normalise "HH:mm:ss" (pg time) to "HH:mm". */
export const normTime = (t: string): string => t.slice(0, 5);

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export const timeZoneStr = z.string().min(1).refine(isValidTimeZone, "Unknown IANA time zone");

export const intervalSchema = z.object({ start: timeStr, end: timeStr });
export type Interval = z.infer<typeof intervalSchema>;

/** Returns a human readable problem or null. Touching intervals (end == next start) are allowed. */
export function findIntervalProblem(intervals: Interval[]): string | null {
  const sorted = [...intervals].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (const i of sorted) {
    if (toMinutes(i.start) >= toMinutes(i.end)) return `Start time ${i.start} must be before end time ${i.end}`;
  }
  for (let k = 1; k < sorted.length; k++) {
    if (toMinutes(sorted[k].start) < toMinutes(sorted[k - 1].end)) {
      return `Intervals ${sorted[k - 1].start}-${sorted[k - 1].end} and ${sorted[k].start}-${sorted[k].end} overlap`;
    }
  }
  return null;
}

export const weeklyRulesSchema = z
  .array(z.object({ weekday: z.number().int().min(0).max(6), start: timeStr, end: timeStr }))
  .max(7 * 12, "Too many intervals")
  .superRefine((rules, ctx) => {
    for (let d = 0; d < 7; d++) {
      const p = findIntervalProblem(rules.filter((r) => r.weekday === d));
      if (p) ctx.addIssue({ code: "custom", message: `${WEEKDAYS[d].label}: ${p}` });
    }
  });
export type WeeklyRules = z.infer<typeof weeklyRulesSchema>;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const overrideSchema = z.object({
  date: dateStr,
  unavailable: z.boolean().default(false),
  intervals: z.array(intervalSchema).max(12).default([]),
});
export const overridesSchema = z
  .array(overrideSchema)
  .max(400)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const o of list) {
      if (seen.has(o.date)) ctx.addIssue({ code: "custom", message: `Duplicate override for ${o.date}` });
      seen.add(o.date);
      if (!o.unavailable) {
        if (o.intervals.length === 0) ctx.addIssue({ code: "custom", message: `${o.date}: add hours or mark unavailable` });
        const p = findIntervalProblem(o.intervals);
        if (p) ctx.addIssue({ code: "custom", message: `${o.date}: ${p}` });
      }
    }
  });
export type OverrideInput = z.infer<typeof overrideSchema>;

export const scheduleInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  timeZone: timeZoneStr,
  rules: weeklyRulesSchema,
  overrides: overridesSchema.optional(),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const createScheduleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  timeZone: timeZoneStr,
  template: z.enum(["weekdays_9_5", "empty"]).default("weekdays_9_5"),
});

export const blockedTimeSchema = z
  .object({
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((v) => new Date(v.startsAt) < new Date(v.endsAt), { message: "End must be after start", path: ["endsAt"] });
export type BlockedTimeInput = z.infer<typeof blockedTimeSchema>;
