import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { AppError } from "../errors";
import { hashToken } from "../services/booking";
import { getProvider } from "./providers";
import { processProviderEvent, currentBooking } from "./service";
import { verifyRazorpayCheckoutSignature } from "./razorpay";
import { ProviderNotConfiguredError, WebhookSignatureError, type ProviderName } from "./types";

const MAX_BODY = 512_000;

/**
 * Shared webhook entrypoint. Reads the RAW body (never re-serialized JSON), verifies the signature through the provider,
 * then processes idempotently. 400 = bad signature (provider must not retry), 5xx = retry later, 200 = handled/duplicate.
 */
export async function handleWebhookRequest(name: ProviderName, req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "payload too large" }, { status: 413 });
  const provider = getProvider(name);
  let ev;
  try {
    ev = provider.parseWebhook(raw, req.headers);
  } catch (e) {
    if (e instanceof ProviderNotConfiguredError) return Response.json({ error: "provider not configured" }, { status: 404 });
    if (e instanceof WebhookSignatureError) return Response.json({ error: "invalid signature" }, { status: 400 });
    console.error(`[webhook:${name}] parse error`, e);
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const outcome = await processProviderEvent(ev);
    return Response.json({ ok: true, outcome });
  } catch (e) {
    console.error(`[webhook:${name}] processing failed for ${ev.eventId}:`, (e as Error).message);
    return Response.json({ error: "processing failed" }, { status: 500 });
  }
}

/** Razorpay checkout.js success callback: verifies order_id|payment_id signature, then settles like a webhook. */
export async function verifyRazorpayCheckout(input: { manageToken: string; orderId: string; paymentId: string; signature: string }) {
  if (!verifyRazorpayCheckoutSignature(input.orderId, input.paymentId, input.signature)) throw new AppError("INVALID_SIGNATURE", "Payment signature could not be verified.", 400);
  const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.manageTokenHash, hashToken(input.manageToken))).limit(1);
  if (!booking) throw new AppError("NOT_FOUND", "Booking not found", 404);
  const [pay] = await db.select().from(schema.payments).where(and(eq(schema.payments.provider, "razorpay"), eq(schema.payments.providerOrderId, input.orderId))).limit(1);
  if (!pay || (pay.bookingId !== booking.id && (await currentBooking(pay.bookingId)).id !== booking.id)) throw new AppError("NOT_FOUND", "Payment not found", 404);
  await processProviderEvent({
    provider: "razorpay", eventId: `checkout:${input.paymentId}`, rawType: "checkout.verified", kind: "payment_paid",
    providerOrderId: input.orderId, providerPaymentId: input.paymentId,
  });
  return { status: "paid" as const };
}
