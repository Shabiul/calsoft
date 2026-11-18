import type { NextRequest } from "next/server";
import { z } from "zod";
import { verifyRazorpayCheckout } from "@/server/payments/webhook";
import { handleError, jsonError, jsonOk, readJson } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

const body = z.object({
  manageToken: z.string().min(10).max(200),
  razorpay_order_id: z.string().min(5).max(100), razorpay_payment_id: z.string().min(5).max(100), razorpay_signature: z.string().min(10).max(200),
});

/** POST /api/public/payments/razorpay/verify - checkout.js success callback (signature = HMAC(order_id|payment_id)). */
export async function POST(req: NextRequest) {
  try {
    const limited = await limitOr429(req, "pay-verify", 30, 60);
    if (limited) return limited;
    let raw: unknown;
    try { raw = await readJson(req, 4_000); } catch { return jsonError("VALIDATION", "Request body too large.", 413); }
    const b = body.parse(raw);
    return jsonOk(await verifyRazorpayCheckout({ manageToken: b.manageToken, orderId: b.razorpay_order_id, paymentId: b.razorpay_payment_id, signature: b.razorpay_signature }));
  } catch (e) {
    return handleError(e);
  }
}
