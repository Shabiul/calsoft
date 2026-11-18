import { and, eq, gt, lt, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getProvider } from "./provider";
import { withCalendarToken } from "./tokens";
import type { Interval } from "./types";

export type { Interval };

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
 * Busy intervals from a user's external calendars (only calendars with check_conflicts on, on active connections).
 * Always includes the synced cache; when `live` (default) also asks the provider directly so a booking never relies
 * on stale cache. If a live call fails (revoked token, outage) we degrade to the cache for that calendar.
 */
export async function getExternalBusy(userId: string, from: Date, to: Date, opts: { live?: boolean } = {}): Promise<Interval[]> {
  const { calendars, connectedCalendars, calendarBusy } = schema;
  const rows = await db.select({ cal: calendars, conn: connectedCalendars }).from(calendars)
    .innerJoin(connectedCalendars, eq(calendars.connectedCalendarId, connectedCalendars.id))
    .where(and(eq(connectedCalendars.userId, userId), eq(calendars.checkConflicts, true), eq(connectedCalendars.status, "active")));
  if (!rows.length) return [];
  const cached = await db.select().from(calendarBusy).where(and(
    inArray(calendarBusy.calendarId, rows.map((r) => r.cal.id)), lt(calendarBusy.startsAt, to), gt(calendarBusy.endsAt, from)));
  const all: Interval[] = cached.map((c) => ({ start: c.startsAt, end: c.endsAt }));
  if (opts.live !== false) {
    await Promise.all(rows.map(async ({ cal, conn }) => {
      try {
        const p = getProvider(conn.provider);
        all.push(...await withCalendarToken(conn.id, conn.provider, (t) => p.getBusyIntervals(t, cal.externalId, from, to)));
      } catch { /* degrade to cache; token problems are recorded on the connection by withCalendarToken */ }
    }));
  }
  return mergeIntervals(all);
}
