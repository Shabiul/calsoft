import type { NextRequest } from "next/server";
import { rescheduleBooking } from "@/server/services/booking";
import { findBookingByToken } from "@/server/public/data";
import { rescheduleBodySchema } from "@/server/public/schemas";
import { handleError, jsonError, jsonOk, readJson } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

/** POST /api/public/manage/:token/reschedule { startsAt, timeZone } -> { manageToken (new), booking } */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    const limited = await limitOr429(req, "manage-write", 10, 60);
    if (limited) return limited;
    const { token } = await ctx.params;
    const b = await findBookingByToken(token);
    if (!b) return jsonError("NOT_FOUND", "Booking not found.", 404);
    const body = rescheduleBodySchema.parse(await readJson(req));
    const res = await rescheduleBooking({ manageToken: token, newStartsAt: body.startsAt, inviteeTimeZone: body.timeZone, actor: "invitee" });
    return jsonOk({
      manageToken: res.manageToken,
      booking: { id: res.booking.id, startsAt: res.booking.startsAt.toISOString(), endsAt: res.booking.endsAt.toISOString(), status: res.booking.status },
    });
  } catch (e) {
    return handleError(e);
  }
}
