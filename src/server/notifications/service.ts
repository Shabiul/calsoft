/**
 * Notification pipeline: notification_log row (dedupe_key unique => idempotent) -> BullMQ job ->
 * provider send. Failures retry with exponential backoff; after the final attempt status = 'dead'.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { bookings, connectedCalendars, invitees, notificationLogs } from "@/server/db/schema";
import { enqueue, MAX_ATTEMPTS, QUEUES } from "@/server/queue";
import { loadBookingContext } from "./context";
import { getEmailProvider } from "./provider";
import { renderNotification } from "./templates";
import type { NotificationKind, RenderExtra, Role } from "./types";

export interface QueueNotificationInput {
  kind: NotificationKind;
  bookingId: string | null;
  recipient: string;
  dedupeKey: string;
  extra?: RenderExtra;
}
export interface NotificationJobData { logId: string; extra?: RenderExtra }

/** Idempotent: a second call with the same dedupeKey does nothing. */
export async function queueNotification(input: QueueNotificationInput): Promise<{ id: string; deduped: boolean }> {
  const [row] = await db.insert(notificationLogs).values({
    bookingId: input.bookingId, kind: input.kind, recipient: input.recipient, dedupeKey: input.dedupeKey,
  }).onConflictDoNothing({ target: notificationLogs.dedupeKey }).returning({ id: notificationLogs.id });
  if (!row) {
    const [existing] = await db.select({ id: notificationLogs.id }).from(notificationLogs).where(eq(notificationLogs.dedupeKey, input.dedupeKey));
    return { id: existing?.id ?? "", deduped: true };
  }
  await enqueueNotificationJob(row.id, input.extra);
  return { id: row.id, deduped: false };
}

export function enqueueNotificationJob(logId: string, extra?: RenderExtra) {
  const data: NotificationJobData = { logId, extra };
  return enqueue(QUEUES.notifications, { name: "send", data }, { jobId: `notif-${logId}`, attempts: MAX_ATTEMPTS.default });
}

export type ProcessResult = "sent" | "skipped" | "already_done";

/**
 * Process one notification. Throws on failure so BullMQ retries; `isFinal` marks the log dead.
 */
export async function processNotification(data: NotificationJobData, opts: { attemptsMade: number; isFinal: boolean }): Promise<ProcessResult> {
  const [log] = await db.select().from(notificationLogs).where(eq(notificationLogs.id, data.logId));
  if (!log) return "skipped";
  if (log.status === "sent" || log.status === "dead") return "already_done";
  try {
    if (!log.bookingId) throw new Error("notification has no booking");
    const ctx = await loadBookingContext(log.bookingId);
    if (!ctx) {
      await db.update(notificationLogs).set({ status: "sent", error: "skipped: booking not found" }).where(eq(notificationLogs.id, log.id));
      return "skipped";
    }
    const kind = log.kind as NotificationKind;
    // Don't remind/follow up on bookings that are no longer active.
    if (kind === "reminder" && ctx.booking.status !== "confirmed") {
      await db.update(notificationLogs).set({ status: "sent", error: `skipped: booking ${ctx.booking.status}` }).where(eq(notificationLogs.id, log.id));
      return "skipped";
    }
    // Extra attendees: render the email for them (greeting, calendar attendee) instead of the primary invitee.
    const rcpt = log.recipient.toLowerCase();
    if (rcpt !== ctx.invitee.email.toLowerCase() && rcpt !== ctx.host.email.toLowerCase()) {
      const [g] = await db.select({ name: invitees.name, email: invitees.email }).from(invitees)
        .where(and(eq(invitees.bookingId, log.bookingId), sql`lower(${invitees.email}) = ${rcpt}`)).limit(1);
      if (g) ctx.invitee = { name: g.name, email: g.email };
    }
    // The Meet link is written by the calendar sync, which runs in parallel with this job. Retry (backoff) until it exists;
    // the final attempt sends regardless so a missing link never blocks the email.
    if (["confirmation", "approved", "reschedule", "host_notification"].includes(kind) && ctx.booking.locationType === "google_meet" && !ctx.booking.meetingUrl && !opts.isFinal && opts.attemptsMade < 3) {
      const [conn] = await db.select({ id: connectedCalendars.id }).from(connectedCalendars)
        .innerJoin(bookings, eq(bookings.hostUserId, connectedCalendars.userId))
        .where(and(eq(bookings.id, log.bookingId), eq(connectedCalendars.provider, "google"), eq(connectedCalendars.status, "active"))).limit(1);
      if (conn) throw new Error("waiting for Google Meet link");
    }
    const role: Role = kind === "host_notification" || log.recipient.toLowerCase() === ctx.host.email.toLowerCase() ? "host" : "invitee";
    const extra: RenderExtra = { ...(data.extra ?? {}) };
    if (kind === "reminder" && extra.minutesBefore == null) {
      const m = Number(log.dedupeKey?.split(":")[2]); // reminder:<booking>:<minutes>:<recipient>
      if (Number.isFinite(m)) extra.minutesBefore = m;
    }
    const mail = renderNotification(kind, ctx, role, extra);
    await getEmailProvider().send({ to: log.recipient, ...mail });
    await db.update(notificationLogs)
      .set({ status: "sent", sentAt: new Date(), attempts: opts.attemptsMade + 1, error: null })
      .where(eq(notificationLogs.id, log.id));
    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(notificationLogs)
      .set({ status: opts.isFinal ? "dead" : "failed", attempts: opts.attemptsMade + 1, error: message.slice(0, 1000) })
      .where(eq(notificationLogs.id, log.id));
    throw err;
  }
}

/** Re-enqueue logs stuck in 'queued' (e.g. process died between DB insert and enqueue). BullMQ dedupes by jobId. */
export async function requeueStaleNotifications(olderThanMs = 5 * 60_000, limit = 100): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db.select({ id: notificationLogs.id }).from(notificationLogs)
    .where(and(eq(notificationLogs.status, "queued"), lt(notificationLogs.createdAt, cutoff))).limit(limit);
  for (const r of rows) await enqueueNotificationJob(r.id);
  return rows.length;
}
