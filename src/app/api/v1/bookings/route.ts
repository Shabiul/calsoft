import { z } from "zod";
import { apiRoute, created, hideForbidden, paginationQuery } from "@/server/api/handler";
import { listBookingsFor, serializeBooking } from "@/server/api/resources";
import { getEventType } from "@/server/services/event-types";
import { createBooking } from "@/server/services/booking";
import { db, schema } from "@/server/db";
import { eq } from "drizzle-orm";

const STATUSES = ["pending_payment", "pending_confirmation", "confirmed", "cancelled", "rescheduled", "completed", "no_show", "expired"] as const;
const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

export const GET = apiRoute({ scope: "bookings:read" }, async (c) => {
  const q = c.query(paginationQuery.extend({
    status: z.enum(STATUSES).optional(), event_id: z.string().uuid().optional(),
    from: isoDate.optional(), to: isoDate.optional(), invitee_email: z.string().email().optional(),
  }));
  return listBookingsFor(c.key, q);
});

const createBody = z.object({
  event_id: z.string().uuid(),
  starts_at: z.iso.datetime({ offset: true }),
  invitee: z.object({
    name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(320),
    phone: z.string().trim().max(50).nullish(), time_zone: z.string().min(1).max(100),
  }),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  host_user_id: z.string().optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const POST = apiRoute({ scope: "bookings:write" }, async (c) => {
  const b = await c.body(createBody);
  // Access check: the key's user must own / belong to the event type's org (404 otherwise).
  await hideForbidden(getEventType({ userId: c.key.userId }, b.event_id));
  const idem = b.idempotency_key ?? c.req.headers.get("idempotency-key") ?? undefined;
  const res = await createBooking({
    eventTypeId: b.event_id, startsAt: b.starts_at,
    invitee: { name: b.invitee.name, email: b.invitee.email, phone: b.invitee.phone ?? null, timeZone: b.invitee.time_zone },
    answers: b.answers, hostUserId: b.host_user_id,
    // Namespaced per key so one tenant can never replay another tenant's booking.
    idempotencyKey: idem ? `api:${c.key.id}:${idem}` : undefined,
    actor: "host", actorId: c.key.userId,
  });
  c.setAudit("booking.created", { type: "booking", id: res.booking.id }, { idempotentReplay: res.idempotentReplay ?? false });
  const [inv] = await db.select().from(schema.invitees).where(eq(schema.invitees.bookingId, res.booking.id)).limit(1);
  const body = {
    ...serializeBooking(res.booking, inv), manage_token: res.manageToken,
    // Recurring events: every occurrence (one booking row each, shared series_id). Tokens are only known at creation.
    ...(res.series ? { series: res.series.map((s) => ({ ...serializeBooking(s.booking, inv), manage_token: s.manageToken })) } : {}),
  };
  return res.idempotentReplay ? Response.json(body, { status: 200 }) : created(body);
});
