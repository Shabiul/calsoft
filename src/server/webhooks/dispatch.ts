import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { UnrecoverableError } from "bullmq";
import { db } from "@/server/db";
import { bookings, webhookDeliveries, webhookEndpoints } from "@/server/db/schema";
import { decrypt } from "@/lib/crypto";
import { enqueue, MAX_ATTEMPTS, QUEUES, type EventJobData } from "@/server/queue";
import { loadBookingContext } from "@/server/notifications/context";
import { postJson } from "./http";
import { signPayload } from "./signing";
import { SsrfError } from "./ssrf";

class HttpStatusError extends Error {}

/** Deterministic uuid from a string (idempotent fan-out on job replays). */
export function detUuid(input: string): string {
  const h = createHash("sha256").update(input).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function buildWebhookPayload(event: Pick<EventJobData, "eventId" | "type" | "at" | "payload">) {
  const ctx = await loadBookingContext(event.payload.bookingId);
  return {
    id: event.eventId,
    type: event.type,
    created_at: event.at,
    data: ctx ? {
      booking: {
        id: ctx.booking.id, status: ctx.booking.status,
        start_time: ctx.booking.startsAt.toISOString(), end_time: ctx.booking.endsAt.toISOString(),
        invitee_time_zone: ctx.booking.inviteeTimeZone, meeting_url: ctx.booking.meetingUrl,
        cancel_reason: ctx.booking.cancelReason, series_id: ctx.booking.seriesId ?? null,
        previous_booking_id: event.payload.previousBookingId ?? null,
        event_type: { id: ctx.eventType.id, title: ctx.eventType.title },
        host: { id: ctx.host.id, name: ctx.host.name, email: ctx.host.email },
        invitee: { name: ctx.invitee.name, email: ctx.invitee.email },
        payment: ctx.payment ?? null,
      },
    } : { booking: { id: event.payload.bookingId } },
  };
}

/** Create + enqueue one delivery per matching endpoint. Idempotent per (event, endpoint). */
export async function fanoutWebhooks(event: EventJobData): Promise<number> {
  const [b] = await db.select({ host: bookings.hostUserId, org: bookings.organizationId }).from(bookings).where(eq(bookings.id, event.payload.bookingId));
  if (!b) return 0;
  const owner = b.org
    ? or(eq(webhookEndpoints.userId, b.host), eq(webhookEndpoints.organizationId, b.org))
    : eq(webhookEndpoints.userId, b.host);
  const endpoints = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.isActive, true), owner));
  const matching = endpoints.filter((e) => e.events.includes(event.type) || e.events.includes("*"));
  if (!matching.length) return 0;
  const payload = await buildWebhookPayload(event);
  for (const ep of matching) {
    const id = detUuid(`${event.eventId}:${ep.id}`);
    await db.insert(webhookDeliveries).values({ id, endpointId: ep.id, event: event.type, payload }).onConflictDoNothing();
    await enqueueDelivery(id);
  }
  return matching.length;
}

export function enqueueDelivery(deliveryId: string, unique = true) {
  return enqueue(QUEUES.webhooks, { name: "deliver", data: { deliveryId } }, {
    jobId: unique ? `whd-${deliveryId}` : `whd-${deliveryId}-${Date.now()}`, attempts: MAX_ATTEMPTS.webhook,
  });
}

/** Deliver one webhook. Throws to trigger retry; marks status 'dead' on final failure. */
export async function processDelivery(deliveryId: string, opts: { attemptsMade: number; isFinal: boolean }): Promise<"sent" | "skipped"> {
  const [row] = await db.select({ d: webhookDeliveries, e: webhookEndpoints }).from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId)).where(eq(webhookDeliveries.id, deliveryId));
  if (!row || row.d.status === "sent" || row.d.status === "dead") return "skipped";
  if (!row.e.isActive) {
    await db.update(webhookDeliveries).set({ status: "dead", error: "endpoint disabled" }).where(eq(webhookDeliveries.id, deliveryId));
    return "skipped";
  }
  const body = JSON.stringify(row.d.payload);
  try {
    const secret = decrypt(row.e.secret);
    const signed = signPayload(secret, body);
    const res = await postJson(row.e.url, body, { ...signed.headers, "MeetFlow-Event": row.d.event, "MeetFlow-Delivery": row.d.id });
    if (res.status >= 200 && res.status < 300) {
      await db.update(webhookDeliveries).set({ status: "sent", attempts: opts.attemptsMade + 1, responseCode: res.status, error: null, deliveredAt: new Date() })
        .where(eq(webhookDeliveries.id, deliveryId));
      return "sent";
    }
    await db.update(webhookDeliveries).set({ status: opts.isFinal ? "dead" : "failed", attempts: opts.attemptsMade + 1, responseCode: res.status, error: `HTTP ${res.status}: ${res.body.slice(0, 200)}` })
      .where(eq(webhookDeliveries.id, deliveryId));
    throw new HttpStatusError(`Webhook endpoint responded ${res.status}`);
  } catch (err) {
    if (err instanceof HttpStatusError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof SsrfError;
    await db.update(webhookDeliveries).set({ status: opts.isFinal || permanent ? "dead" : "failed", attempts: opts.attemptsMade + 1, error: msg.slice(0, 500) })
      .where(eq(webhookDeliveries.id, deliveryId));
    if (permanent) throw new UnrecoverableError(msg);
    throw err;
  }
}
