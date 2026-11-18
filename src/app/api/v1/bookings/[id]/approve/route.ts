import { apiRoute } from "@/server/api/handler";
import { getBookingFor } from "@/server/api/resources";
import { approveBooking } from "@/server/services/booking";

/** POST /api/v1/bookings/{id}/approve: host approves a pending_confirmation request (a series is approved as a whole). */
export const POST = apiRoute<{ id: string }>({ scope: "bookings:write" }, async (c) => {
  await getBookingFor(c.key, c.params.id); // tenant check (404 if not yours)
  await approveBooking({ bookingId: c.params.id, actor: "host", actorId: c.key.userId });
  c.setAudit("booking.approved", { type: "booking", id: c.params.id });
  return getBookingFor(c.key, c.params.id);
});
