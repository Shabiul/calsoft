import { DateTime } from "luxon";
import type { AnalyticsQuery } from "@/server/services/analytics";

export const PRESETS = [
  { v: "7d", label: "Last 7 days", days: 7 },
  { v: "30d", label: "Last 30 days", days: 30 },
  { v: "90d", label: "Last 90 days", days: 90 },
  { v: "12m", label: "Last 12 months", days: 365 },
] as const;

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** URL params -> AnalyticsQuery. Dates are interpreted in the viewer's time zone (inclusive end date). */
export function parseRange(sp: Raw, timeZone: string, now = new Date()): AnalyticsQuery & { preset: string; fromStr: string; toStr: string } {
  const zone = DateTime.local().setZone(timeZone).isValid ? timeZone : "UTC";
  const eventTypeId = /^[0-9a-f-]{36}$/i.test(one(sp.event) ?? "") ? one(sp.event) : undefined;
  const f = DateTime.fromISO(one(sp.from) ?? "", { zone }), t = DateTime.fromISO(one(sp.to) ?? "", { zone });
  if (f.isValid && t.isValid) {
    return { timeZone: zone, from: f.startOf("day").toJSDate(), to: t.plus({ days: 1 }).startOf("day").toJSDate(), eventTypeId, preset: "custom", fromStr: f.toISODate()!, toStr: t.toISODate()! };
  }
  const p = PRESETS.find((x) => x.v === one(sp.range)) ?? PRESETS[1];
  const end = DateTime.fromJSDate(now, { zone }).plus({ days: 1 }).startOf("day");
  const start = end.minus({ days: p.days });
  return { timeZone: zone, from: start.toJSDate(), to: end.toJSDate(), eventTypeId, preset: p.v, fromStr: start.toISODate()!, toStr: end.minus({ days: 1 }).toISODate()! };
}
