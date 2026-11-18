import type { NextRequest } from "next/server";
import { cancelBooking } from "@/server/services/booking";
import { findBookingByToken } from "@/server/public/data";
import { cancelBodySchema } from "@/server/public/schemas";
import { handleError, jsonError, jsonOk, readJson } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

/** POST /api/public/manage/:token/cancel  { reason? } — the service enforces min cancel notice. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    const limited = await limitOr429(req, "manage-write", 10, 60);
    if (limited) return limited;
    const { token } = await ctx.params;
    const b = await findBookingByToken(token);
    if (!b) return jsonError("NOT_FOUND", "Booking not found.", 404);
    const body = cancelBodySchema.parse((await readJson(req)) ?? {});
    const out = await cancelBooking({ manageToken: token, reason: body.reason, actor: "invitee", scope: body.scope });
    return jsonOk({ ok: true, status: out.status, cancelledAt: out.cancelledAt?.toISOString() ?? null });
  } catch (e) {
    return handleError(e);
  }
}
