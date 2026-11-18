import { z } from "zod";
import { apiRoute } from "@/server/api/handler";
import { getBookingFor } from "@/server/api/resources";
import { rescheduleBooking } from "@/server/services/booking";

export const POST = apiRoute<{ id: string }>({ scope: "bookings:write" }, async (c) => {
  const b = await c.body(z.object({
    starts_at: z.iso.datetime({ offset: true }), reason: z.string().max(1000).optional(), invitee_time_zone: z.string().max(100).optional(),
  }));
  await getBookingFor(c.key, c.params.id); // tenant check
  const res = await rescheduleBooking({
    bookingId: c.params.id, newStartsAt: b.starts_at, actor: "host", actorId: c.key.userId, reason: b.reason, inviteeTimeZone: b.invitee_time_zone,
  });
  c.setAudit("booking.rescheduled", { type: "booking", id: c.params.id }, { newBookingId: res.booking.id });
  return { ...(await getBookingFor(c.key, res.booking.id)), rescheduled_from_id: c.params.id, manage_token: res.manageToken };
});
