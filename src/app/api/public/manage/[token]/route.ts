import type { NextRequest } from "next/server";
import { loadBookingView } from "@/server/public/data";
import { handleError, jsonError, jsonOk } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

/** GET /api/public/manage/:token -> booking details visible to the token holder. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    const limited = await limitOr429(req, "manage-get", 60, 60);
    if (limited) return limited;
    const { token } = await ctx.params;
    const v = await loadBookingView(token);
    if (!v) return jsonError("NOT_FOUND", "Booking not found.", 404);
    return jsonOk({ booking: v });
  } catch (e) {
    return handleError(e);
  }
}
