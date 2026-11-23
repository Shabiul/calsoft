import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/server/db";
import { bookings, invitees } from "@/server/db/schema";
import { dedupeKey } from "@/server/queue/backoff";
import type { EventJobData } from "@/server/queue";
import { loadBookingContext } from "./context";
import { cancelReminders, createRemindersForBooking, recomputeReminders } from "./reminders";
import { queueNotification } from "./service";
import type { NotificationKind, RenderExtra } from "./types";

/** Translate a domain event into reminder bookkeeping + notifications. Fully idempotent (dedupe keys). */
export async function handleNotificationEvent(event: EventJobData): Promise<void> {
  const { type, payload } = event;
  const bookingId = payload.bookingId;
  const ctx = await loadBookingContext(bookingId);
  if (!ctx) return;
  const send = (kind: NotificationKind, recipient: string, role: string, extra?: RenderExtra, bId = bookingId) =>
    recipient.toLowerCase().endsWith("@deleted.invalid") ? Promise.resolve({ id: "", deduped: true }) : // anonymised (deleted) account: nobody to email
    queueNotification({ kind, bookingId: bId, recipient, dedupeKey: dedupeKey(kind, bId, role), extra });
  /** Extra attendees (everyone after the primary invitee). They get the same emails, without the manage link. */
  const sendGuests = async (kind: NotificationKind, extra?: RenderExtra) => {
    const rows = await db.select({ email: invitees.email }).from(invitees)
      .where(and(eq(invitees.bookingId, bookingId), isNull(invitees.cancelledAt))).orderBy(asc(invitees.createdAt));
    const seen = new Set([ctx.invitee.email.toLowerCase(), ctx.host.email.toLowerCase()]);
    for (const { email } of rows) {
      const e = email.toLowerCase();
      if (seen.has(e)) continue;
      seen.add(e);
      await send(kind, email, `guest:${e}`, extra);
    }
  };
  const manage = payload.manageToken ? { manageToken: payload.manageToken } : {};

  // Recurring series: every occurrence gets reminders/calendar sync, but the invitee/host get ONE email per series
  // (the event for occurrence 0 carries the manage token and renders the whole series).
  const lead = payload.seriesIndex === undefined || payload.seriesIndex === 0;

  switch (type) {
    case "booking.created":
    case "booking.confirmed":
    case "payment.succeeded": {
      if (type === "payment.succeeded") await send("payment_confirmation", ctx.invitee.email, "invitee", manage);
      if (ctx.booking.status === "pending_confirmation") {
        // Requires host approval: no reminders, no calendar sync yet. Tell both sides (deduped, so replays are no-ops).
        if (!lead) return;
        await send("request_received", ctx.invitee.email, "invitee", manage);
        await send("approval_request", ctx.host.email, "host");
        return;
      }
      if (ctx.booking.status !== "confirmed") return; // pending_payment: wait for the payment/confirmation event
      await createRemindersForBooking(bookingId);
      if (!lead) return;
      if (payload.approved) {
        await send("approved", ctx.invitee.email, "invitee", manage);
        await sendGuests("approved");
        return;
      }
      await send("confirmation", ctx.invitee.email, "invitee", manage);
      await sendGuests("confirmation");
      await send("host_notification", ctx.host.email, "host");
      return;
    }
    case "booking.declined":
      await cancelReminders(bookingId);
      if (lead) await send("declined", ctx.invitee.email, "invitee");
      return;
    case "booking.rescheduled": {
      let previousStartsAt: string | undefined;
      if (payload.previousBookingId) {
        await cancelReminders(payload.previousBookingId);
        const [prev] = await db.select({ s: bookings.startsAt }).from(bookings).where(eq(bookings.id, payload.previousBookingId));
        previousStartsAt = prev?.s.toISOString();
      }
      await recomputeReminders(bookingId);
      if (ctx.booking.status !== "confirmed") return;
      await send("reschedule", ctx.invitee.email, "invitee", { ...manage, previousStartsAt });
      await send("reschedule", ctx.host.email, "host", { previousStartsAt });
      await sendGuests("reschedule", { previousStartsAt });
      return;
    }
    case "booking.cancelled": {
      await cancelReminders(bookingId);
      if (!lead) return;
      const seriesCount = payload.seriesCount && payload.seriesCount > 1 ? { seriesCount: payload.seriesCount } : undefined;
      await send("cancellation", ctx.invitee.email, "invitee", seriesCount);
      await send("cancellation", ctx.host.email, "host", seriesCount);
      await sendGuests("cancellation", seriesCount);
      return;
    }
    case "booking.expired":
      await cancelReminders(bookingId);
      // An unanswered approval request lapsed (see expireUnansweredRequests): tell the invitee.
      if (payload.reason === "unanswered_request" && lead) await send("declined", ctx.invitee.email, "invitee");
      return;
    case "booking.completed":
      await send("follow_up", ctx.invitee.email, "invitee");
      return;
    case "payment.failed":
      await send("payment_failed", ctx.invitee.email, "invitee", manage);
      return;
    default:
      return;
  }
}
