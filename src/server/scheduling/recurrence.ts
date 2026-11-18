/**
 * Recurring series date arithmetic (pure).
 *
 * Occurrences are derived from the FIRST start with Luxon calendar arithmetic in the host time zone, never by adding
 * 7*24h: a weekly series that starts at 09:00 America/New_York stays at 09:00 local across DST changes, and a monthly
 * series keeps the same local day-of-month, clamping to the month's last day (Jan 31 -> Feb 28 -> Mar 31).
 * Each occurrence is computed from the first start (not from the previous one) so a clamp never "drifts".
 */
import { DateTime } from "luxon";

export type RecurrenceInterval = "week" | "month";
export interface Recurrence { count: number; interval: RecurrenceInterval }

export function seriesStarts(first: Date, timeZone: string, rec: Recurrence): Date[] {
  const base = DateTime.fromJSDate(first, { zone: timeZone });
  if (!base.isValid) throw new Error(`Invalid time zone ${timeZone}`);
  const out: Date[] = [];
  for (let i = 0; i < rec.count; i++) {
    const d = rec.interval === "week" ? base.plus({ weeks: i }) : base.plus({ months: i });
    out.push(d.toJSDate());
  }
  return out;
}

export function describeRecurrence(rec: Recurrence): string {
  return `${rec.count} ${rec.interval === "week" ? "weekly" : "monthly"} sessions`;
}
