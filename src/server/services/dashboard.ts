import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db as defaultDb, schema, type Db } from "@/server/db";

const { bookings, eventTypes, bookingEvents } = schema;

export type BookingStatus = (typeof bookings.$inferSelect)["status"];
export const ALL_STATUSES: BookingStatus[] = ["pending_payment", "pending_confirmation", "confirmed", "rescheduled", "completed", "cancelled", "no_show", "expired"];

export interface DashboardStats {
  upcoming: number;
  today: number;
  thisWeek: number;
  total: number;
  byStatus: Record<string, number>;
  nextBookings: { id: string; startsAt: string; title: string; inviteeName: string | null; inviteeEmail: string | null; status: BookingStatus; color: string | null }[];
  recent: { id: string; type: string; createdAt: string; bookingId: string; title: string; inviteeName: string | null }[];
  eventTypes: { id: string; title: string; color: string | null }[];
}

export async function getDashboardStats(userId: string, timeZone: string, db: Db = defaultDb, now: Date = new Date()): Promise<DashboardStats> {
  const zone = DateTime.local({ zone: timeZone }).isValid ? timeZone : "UTC";
  const local = DateTime.fromJSDate(now, { zone });
  const dayStart = local.startOf("day").toUTC().toJSDate();
  const dayEnd = local.endOf("day").toUTC().toJSDate();
  const weekStart = local.startOf("week").toUTC().toJSDate();
  const weekEnd = local.endOf("week").toUTC().toJSDate();
  const mine = eq(bookings.hostUserId, userId);
  const active = inArray(bookings.status, ["confirmed", "pending_payment", "pending_confirmation"]);

  const [statusRows, [upcoming], [today], [week], next, recent, types] = await Promise.all([
    db.select({ status: bookings.status, n: sql<number>`count(*)::int` }).from(bookings).where(mine).groupBy(bookings.status),
    db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(mine, active, gt(bookings.startsAt, now))),
    db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(mine, active, gte(bookings.startsAt, dayStart), lt(bookings.startsAt, dayEnd))),
    db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(mine, active, gte(bookings.startsAt, weekStart), lt(bookings.startsAt, weekEnd))),
    db.select({
      id: bookings.id, startsAt: bookings.startsAt, status: bookings.status, title: eventTypes.title, color: eventTypes.color,
      inviteeName: sql<string | null>`(select i.name from invitee i where i.booking_id = ${bookings.id} order by i.created_at limit 1)`,
      inviteeEmail: sql<string | null>`(select i.email from invitee i where i.booking_id = ${bookings.id} order by i.created_at limit 1)`,
    }).from(bookings).innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
      .where(and(mine, active, gt(bookings.startsAt, now))).orderBy(asc(bookings.startsAt)).limit(5),
    db.select({
      id: bookingEvents.id, type: bookingEvents.type, createdAt: bookingEvents.createdAt, bookingId: bookings.id, title: eventTypes.title,
      inviteeName: sql<string | null>`(select i.name from invitee i where i.booking_id = ${bookings.id} order by i.created_at limit 1)`,
    }).from(bookingEvents).innerJoin(bookings, eq(bookings.id, bookingEvents.bookingId))
      .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
      .where(mine).orderBy(desc(bookingEvents.createdAt)).limit(8),
    db.select({ id: eventTypes.id, title: eventTypes.title, color: eventTypes.color }).from(eventTypes)
      .where(and(eq(eventTypes.ownerUserId, userId), isNull(eventTypes.deletedAt))).orderBy(asc(eventTypes.title)),
  ]);

  const byStatus: Record<string, number> = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const r of statusRows) { byStatus[r.status] = r.n; total += r.n; }

  return {
    upcoming: upcoming?.n ?? 0, today: today?.n ?? 0, thisWeek: week?.n ?? 0, total, byStatus,
    nextBookings: next.map((b) => ({ ...b, startsAt: b.startsAt.toISOString() })),
    recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    eventTypes: types,
  };
}

export interface CalendarEventDto {
  id: string; title: string; start: string; end: string; status: BookingStatus; eventTypeId: string; color: string | null;
  inviteeName: string | null; inviteeEmail: string | null; meetingUrl: string | null;
}

/** Host's bookings overlapping [from, to). Cancelled/expired are included so the UI can filter by status. */
export async function getCalendarEvents(userId: string, from: Date, to: Date, db: Db = defaultDb): Promise<CalendarEventDto[]> {
  const rows = await db.select({
    id: bookings.id, startsAt: bookings.startsAt, endsAt: bookings.endsAt, status: bookings.status, eventTypeId: bookings.eventTypeId,
    meetingUrl: bookings.meetingUrl, title: eventTypes.title, color: eventTypes.color,
    inviteeName: sql<string | null>`(select i.name from invitee i where i.booking_id = ${bookings.id} order by i.created_at limit 1)`,
    inviteeEmail: sql<string | null>`(select i.email from invitee i where i.booking_id = ${bookings.id} order by i.created_at limit 1)`,
  }).from(bookings).innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .where(and(eq(bookings.hostUserId, userId), lt(bookings.startsAt, to), gt(bookings.endsAt, from)))
    .orderBy(asc(bookings.startsAt)).limit(1000);
  return rows.map((r) => ({
    id: r.id, title: r.title, start: r.startsAt.toISOString(), end: r.endsAt.toISOString(), status: r.status,
    eventTypeId: r.eventTypeId, color: r.color, inviteeName: r.inviteeName, inviteeEmail: r.inviteeEmail, meetingUrl: r.meetingUrl,
  }));
}

