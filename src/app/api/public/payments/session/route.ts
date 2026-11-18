import type { NextRequest } from "next/server";
import { z } from "zod";
import { createPaymentSession } from "@/server/payments/service";
import { handleError, jsonOk, readJson, jsonError } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

const body = z.object({ manageToken: z.string().min(10).max(200) });

/**
 * POST /api/public/payments/session { manageToken }
 *  -> 200 { status: "paid" } | 200 { checkoutUrl } | 404 PAYMENTS_NOT_CONFIGURED | 409 HOLD_EXPIRED / INVALID_STATE
 * Amount and currency always come from the event type, never from the client.
 */
export async function POST(req: NextRequest) {
  try {
    const limited = await limitOr429(req, "pay-session", 20, 60);
    if (limited) return limited;
    let raw: unknown;
    try { raw = await readJson(req, 2_000); } catch { return jsonError("VALIDATION", "Request body too large.", 413); }
    const { manageToken } = body.parse(raw);
    return jsonOk(await createPaymentSession(manageToken));
  } catch (e) {
    return handleError(e);
  }
}
