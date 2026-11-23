import { and, eq, gt, lt, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getProvider } from "./provider";
import { withCalendarToken } from "./tokens";
import { DateTime } from "luxon";
import type { Interval } from "./types";

export type { Interval };

/**
 * All-day events are dates, not instants: an all-day "2026-11-14" blocks that LOCAL day for the host (00:00 to 24:00 in their zone),
 * not UTC midnight to UTC midnight (which would spill onto the previous evening for the Americas and leave the first hours of the
 * day open in Asia). `endDate` is exclusive (Google, Outlook and Zoho all use the next day as the end). Invalid zones fall back to UTC.
 */
export function resolveAllDay(list: Interval[], timeZone: string): Interval[] {
  const zone = DateTime.local().setZone(timeZone).isValid ? timeZone : "UTC";
  return list.map((i) => {
    if (!i.allDay) return i;
    const s = DateTime.fromISO(i.allDay.startDate, { zone }).startOf("day");
    let e = DateTime.fromISO(i.allDay.endDate, { zone }).startOf("day");
    if (!s.isValid) return { start: i.start, end: i.end };
    if (!e.isValid || e <= s) e = s.plus({ days: 1 }); // a one-day event with a missing/odd end
    return { start: s.toJSDate(), end: e.toJSDate() };
  });
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].filter((i) => i.end > i.start).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) { if (i.end > last.end) last.end = i.end; }
    else out.push({ start: new Date(i.start), end: new Date(i.end) });
  }
  return out;
}

/**
 * Busy intervals from a user's external calendars (only calendars with check_conflicts on).
 * Always includes the synced cache, EVEN when the connection is broken (revoked token, admin-blocked consent, needs_reauth): the
 * last known events are stale but far safer than treating the host as fully free and double-booking them. When `live` (default)
 * it also asks the provider directly (active connections only) so a booking never relies on a stale cache alone. If a live call
 * fails (outage) we degrade to the cache for that calendar.
 */
export async function getExternalBusy(userId: string, from: Date, to: Date, opts: { live?: boolean } = {}): Promise<Interval[]> {
  const { calendars, connectedCalendars, calendarBusy } = schema;
  const rows = await db.select({ cal: calendars, conn: connectedCalendars }).from(calendars)
    .innerJoin(connectedCalendars, eq(calendars.connectedCalendarId, connectedCalendars.id))
    .where(and(eq(connectedCalendars.userId, userId), eq(calendars.checkConflicts, true)));
  if (!rows.length) return [];
  const cached = await db.select().from(calendarBusy).where(and(
    inArray(calendarBusy.calendarId, rows.map((r) => r.cal.id)), lt(calendarBusy.startsAt, to), gt(calendarBusy.endsAt, from)));
  const all: Interval[] = cached.map((c) => ({ start: c.startsAt, end: c.endsAt }));
  if (opts.live !== false) {
    const [u] = await db.select({ tz: schema.users.timeZone }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const hostTz = u?.tz ?? "UTC";
    await Promise.all(rows.filter((r) => r.conn.status === "active").map(async ({ cal, conn }) => {
      try {
        const p = getProvider(conn.provider);
        all.push(...resolveAllDay(await withCalendarToken(conn.id, conn.provider, (t) => p.getBusyIntervals(t, cal.externalId, from, to)), hostTz));
      } catch { /* degrade to cache; token problems are recorded on the connection by withCalendarToken */ }
    }));
  }
  return mergeIntervals(all);
}
