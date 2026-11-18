import type { NextRequest } from "next/server";
import { getAvailableSlots } from "@/server/scheduling/slots";
import { loadEventById, findBookingByToken } from "@/server/public/data";
import { slotsQuerySchema } from "@/server/public/schemas";
import { handleError, jsonError, jsonOk } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

/** GET /api/public/slots?eventTypeId&from&to&tz[&token]  -> { slots: [{ startsAt }] } (genuinely bookable only) */
export async function GET(req: NextRequest) {
  try {
    const limited = await limitOr429(req, "slots", 120, 60);
    if (limited) return limited;
    const sp = req.nextUrl.searchParams;
    const q = slotsQuerySchema.parse({
      eventTypeId: sp.get("eventTypeId"), from: sp.get("from"), to: sp.get("to"), tz: sp.get("tz"), token: sp.get("token") ?? undefined,
    });
    const event = await loadEventById(q.eventTypeId);
    if (!event) return jsonError("NOT_FOUND", "This event is not available.", 404);

    // Reschedule: the manage token (not a raw booking id) authorizes excluding the booking being moved.
    let excludeBookingId: string | undefined;
    if (q.token) {
      const b = await findBookingByToken(q.token);
      if (!b || b.eventTypeId !== event.id) return jsonError("NOT_FOUND", "Booking not found.", 404);
      excludeBookingId = b.id;
    }
    const slots = await getAvailableSlots({ eventTypeId: event.id, from: q.from, to: q.to, inviteeTimeZone: q.tz, excludeBookingId });
    return jsonOk({
      slots: slots.map((s) => ({ startsAt: s.startsAt, ...(s.spotsLeft !== undefined ? { spotsLeft: s.spotsLeft } : {}) })),
      durationMinutes: event.durationMinutes,
    });
  } catch (e) {
    return handleError(e);
  }
}
