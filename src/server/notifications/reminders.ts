/**
 * Reminders. Rows are created from event_type.reminders (minutes before start). A repeatable BullMQ job
 * (see src/worker) calls processDueReminders(); due rows are claimed with FOR UPDATE SKIP LOCKED so
 * several workers never double-send, and notification dedupe keys make any replay a no-op.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { bookings, eventTypes, invitees, notificationLogs, reminders, users } from "@/server/db/schema";
import { enqueueNotificationJob } from "./service";
import { dedupeKey } from "@/server/queue/backoff";

export interface PlannedReminder { minutesBefore: number; sendAt: Date }

/** Pure: which reminders should exist for a booking starting at `startsAt`. Past ones are skipped. */
export function planReminders(startsAt: Date, minutesList: readonly number[], now: Date = new Date()): PlannedReminder[] {
  const uniq = [...new Set(minutesList.filter((m) => Number.isInteger(m) && m > 0 && m <= 60 * 24 * 60))].sort((a, b) => b - a);
  return uniq
    .map((m) => ({ minutesBefore: m, sendAt: new Date(startsAt.getTime() - m * 60_000) }))
    .filter((r) => r.sendAt.getTime() > now.getTime());
}

export async function createRemindersForBooking(bookingId: string, now = new Date()): Promise<number> {
  const [row] = await db.select({ b: bookings, minutes: eventTypes.reminders })
    .from(bookings).innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId)).where(eq(bookings.id, bookingId));
  if (!row || row.b.status !== "confirmed") return 0;
  const plan = planReminders(row.b.startsAt, row.minutes ?? [], now);
  if (!plan.length) return 0;
  const ins = await db.insert(reminders)
    .values(plan.map((p) => ({ bookingId, minutesBefore: p.minutesBefore, sendAt: p.sendAt })))
    .onConflictDoNothing().returning({ id: reminders.id });
  return ins.length;
}

export async function cancelReminders(bookingId: string): Promise<number> {
  const del = await db.delete(reminders).where(and(eq(reminders.bookingId, bookingId), isNull(reminders.sentAt))).returning({ id: reminders.id });
  return del.length;
}

/** After a reschedule (same booking row moved): drop unsent reminders and re-plan from the new start. */
export async function recomputeReminders(bookingId: string, now = new Date()): Promise<number> {
  await cancelReminders(bookingId);
  return createRemindersForBooking(bookingId, now);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface DueReminder { id: string; bookingId: string; minutesBefore: number; startsAt: Date }

/** Claims due, unsent reminders for confirmed bookings. MUST run inside a transaction. */
export async function selectDueReminders(tx: Tx, now: Date, limit = 100): Promise<DueReminder[]> {
  const res = await tx.execute(sql`
    select r.id, r.booking_id, r.minutes_before, b.starts_at
    from reminder r join booking b on b.id = r.booking_id
    where r.sent_at is null and r.send_at <= ${now.toISOString()}::timestamptz and b.status = 'confirmed'
    order by r.send_at
    limit ${limit}
    for update of r skip locked`);
  return (res.rows as { id: string; booking_id: string; minutes_before: number; starts_at: string | Date }[]).map((r) => ({
    id: r.id, bookingId: r.booking_id, minutesBefore: r.minutes_before, startsAt: new Date(r.starts_at),
  }));
}

/** Claim + mark sent + create notification_log rows atomically; enqueue after commit. Returns reminders processed. */
export async function processDueReminders(now = new Date(), limit = 100): Promise<number> {
  const toEnqueue: string[] = [];
  const count = await db.transaction(async (tx) => {
    const due = await selectDueReminders(tx, now, limit);
    for (const r of due) {
      await tx.update(reminders).set({ sentAt: now }).where(eq(reminders.id, r.id));
      if (r.startsAt.getTime() <= now.getTime()) continue; // meeting already started; nothing useful to say
      const [host] = await tx.select({ email: users.email }).from(bookings).innerJoin(users, eq(users.id, bookings.hostUserId)).where(eq(bookings.id, r.bookingId));
      const [inv] = await tx.select({ email: invitees.email }).from(invitees).where(and(eq(invitees.bookingId, r.bookingId), isNull(invitees.cancelledAt))).limit(1);
      const recipients = [inv?.email, host?.email].filter((e): e is string => !!e);
      for (const recipient of [...new Set(recipients)]) {
        const ins = await tx.insert(notificationLogs).values({
          bookingId: r.bookingId, kind: "reminder", recipient,
          dedupeKey: dedupeKey("reminder", r.bookingId, r.minutesBefore, recipient.toLowerCase()),
        }).onConflictDoNothing({ target: notificationLogs.dedupeKey }).returning({ id: notificationLogs.id });
        if (ins[0]) toEnqueue.push(ins[0].id);
      }
    }
    return due.length;
  });
  // minutesBefore is needed by the template: derive it from the dedupe key at send time via extra.
  for (const id of toEnqueue) {
    const [log] = await db.select({ dedupeKey: notificationLogs.dedupeKey }).from(notificationLogs).where(eq(notificationLogs.id, id));
    const minutes = Number(log?.dedupeKey?.split(":")[2]);
    await enqueueNotificationJob(id, { minutesBefore: Number.isFinite(minutes) ? minutes : undefined });
  }
  return count;
}

/** Expire pending_payment holds whose hold_expires_at passed. Returns expired booking ids. */
export async function expirePendingHolds(now = new Date(), limit = 200): Promise<string[]> {
  const res = await db.execute(sql`
    update booking set status = 'expired', updated_at = now()
    where id in (
      select id from booking
      where status = 'pending_payment' and hold_expires_at is not null and hold_expires_at <= ${now.toISOString()}::timestamptz
      order by hold_expires_at limit ${limit} for update skip locked)
    returning id`);
  return (res.rows as { id: string }[]).map((r) => r.id);
}

export interface ExpiredRequest { id: string; seriesIndex?: number; seriesCount?: number }
/**
 * Unanswered approval requests whose start time has passed become `expired` (slot released; the invitee is told via the
 * booking.expired event with reason "unanswered_request"). A recurring series expires as a whole once its first
 * pending occurrence has started. Returns one entry per primary (non-shadow) row, with series positions.
 */
export async function expireUnansweredRequests(now = new Date(), limit = 200): Promise<ExpiredRequest[]> {
  const res = await db.execute(sql`
    with due as (
      select id, series_id from booking
      where status = 'pending_confirmation' and starts_at <= ${now.toISOString()}::timestamptz
      order by starts_at limit ${limit} for update skip locked)
    update booking b set status = 'expired', updated_at = now(), hold_expires_at = null,
      cancel_reason = 'The host did not respond before the requested time.'
    where b.status = 'pending_confirmation'
      and (b.id in (select id from due) or (b.series_id is not null and b.series_id in (select series_id from due where series_id is not null)))
    returning b.id, b.series_id, b.starts_at, (b.external_event_ids ? 'collectiveOf') as shadow`);
  const rows = (res.rows as { id: string; series_id: string | null; starts_at: string | Date; shadow: boolean }[])
    .filter((r) => !r.shadow)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  const bySeries = new Map<string, string[]>();
  for (const r of rows) if (r.series_id) bySeries.set(r.series_id, [...(bySeries.get(r.series_id) ?? []), r.id]);
  return rows.map((r) => {
    const list = r.series_id ? bySeries.get(r.series_id)! : null;
    return list ? { id: r.id, seriesIndex: list.indexOf(r.id), seriesCount: list.length } : { id: r.id };
  });
}
