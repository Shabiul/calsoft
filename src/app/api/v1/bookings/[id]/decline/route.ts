import { z } from "zod";
import { apiRoute } from "@/server/api/handler";
import { getBookingFor } from "@/server/api/resources";
import { declineBooking } from "@/server/services/booking";
import { AppError } from "@/server/errors";

const body = z.object({ reason: z.string().max(500).optional() });

/** POST /api/v1/bookings/{id}/decline  { reason? }: host declines a pending_confirmation request (slot released, paid bookings refunded). */
export const POST = apiRoute<{ id: string }>({ scope: "bookings:write" }, async (c) => {
  const text = (await c.req.text()).trim();
  let reason: string | undefined;
  if (text) {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new AppError("VALIDATION", "Request body must be valid JSON", 422, [{ path: "", message: "Invalid JSON" }]); }
    const r = body.safeParse(raw);
    if (!r.success) throw new AppError("VALIDATION", "Invalid request body", 422, r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    reason = r.data.reason;
  }
  await getBookingFor(c.key, c.params.id);
  await declineBooking({ bookingId: c.params.id, actor: "host", actorId: c.key.userId, reason });
  c.setAudit("booking.declined", { type: "booking", id: c.params.id });
  return getBookingFor(c.key, c.params.id);
});
