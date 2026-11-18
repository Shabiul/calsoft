/**
 * Razorpay provider: Orders API + hosted checkout page (/pay/razorpay/[token] loads checkout.js) + HMAC signatures.
 * No card data ever touches this server: the browser talks to Razorpay directly and we only get ids + a signature.
 * UNVERIFIED against a live Razorpay account (SDK calls are mocked in tests).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import {
  WebhookSignatureError, ProviderNotConfiguredError,
  type CheckoutInput, type CheckoutResult, type NormalizedEvent, type PaymentProvider, type RemoteStatus, type SubscriptionCheckoutInput,
} from "./types";

/** Narrow view of the SDK so tests can inject a fake. */
export interface RazorpayClientLike {
  orders: {
    create(p: Record<string, unknown>): Promise<{ id: string }>;
    fetchPayments(orderId: string): Promise<{ items: { id: string; status: string; amount: number }[] }>;
  };
  payments: { refund(paymentId: string, p: Record<string, unknown>): Promise<{ id: string }> };
  subscriptions: {
    create(p: Record<string, unknown>): Promise<{ id: string; short_url: string }>;
    cancel(id: string, cancelAtCycleEnd?: boolean): Promise<unknown>;
  };
}

let injected: RazorpayClientLike | null = null;
export function setRazorpayClient(c: RazorpayClientLike | null) { injected = c; }

const env = () => ({
  keyId: process.env.RAZORPAY_KEY_ID ?? "", keySecret: process.env.RAZORPAY_KEY_SECRET ?? "", webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
});
export const razorpayKeyId = () => env().keyId;

function client(): RazorpayClientLike {
  if (injected) return injected;
  const { keyId, keySecret } = env();
  if (!keyId || !keySecret) throw new ProviderNotConfiguredError("razorpay");
  return new Razorpay({ key_id: keyId, key_secret: keySecret }) as unknown as RazorpayClientLike;
}

const hmacHex = (secret: string, data: string) => createHmac("sha256", secret).update(data, "utf8").digest("hex");
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8"), y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Webhook signature: hex HMAC-SHA256 of the RAW body with the webhook secret (header x-razorpay-signature). */
export function verifyRazorpayWebhookSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!secret || !signature) return false;
  return safeEqualHex(hmacHex(secret, rawBody), signature.trim());
}
/** Checkout-callback signature: HMAC-SHA256 of "order_id|payment_id" with the API key secret. */
export function verifyRazorpayCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret = env().keySecret): boolean {
  if (!keySecret || !orderId || !paymentId || !signature) return false;
  return safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature.trim());
}

type Entity = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

export function normalizeRazorpayEvent(body: Entity, eventId: string): NormalizedEvent {
  const rawType = String(body.event ?? "");
  const payload = (body.payload ?? {}) as Record<string, { entity?: Entity }>;
  const base = { provider: "razorpay" as const, eventId, rawType };
  const pay = payload.payment?.entity;
  switch (rawType) {
    case "payment.captured":
    case "order.paid": {
      const p = pay ?? payload.order?.entity;
      if (!p) break;
      const isPay = !!pay;
      return {
        ...base, kind: "payment_paid", providerOrderId: str(isPay ? p.order_id : p.id), providerPaymentId: isPay ? str(p.id) : undefined,
        amount: num(isPay ? p.amount : p.amount_paid), currency: str(p.currency)?.toUpperCase(),
      };
    }
    case "payment.failed":
      if (!pay) break;
      return { ...base, kind: "payment_failed", providerOrderId: str(pay.order_id), providerPaymentId: str(pay.id), amount: num(pay.amount), currency: str(pay.currency)?.toUpperCase() };
    case "refund.processed":
    case "refund.created": {
      const r = payload.refund?.entity;
      if (!r) break;
      return { ...base, kind: "refund_processed", providerPaymentId: str(r.payment_id), refundId: str(r.id), refundAmount: num(r.amount), currency: str(r.currency)?.toUpperCase() };
    }
    case "subscription.activated": case "subscription.charged": case "subscription.resumed":
    case "subscription.cancelled": case "subscription.completed": case "subscription.halted":
    case "subscription.pending": case "subscription.paused": {
      const s = payload.subscription?.entity;
      if (!s) break;
      const notes = (s.notes ?? {}) as Record<string, unknown>;
      const st = String(s.status ?? "");
      const status = st === "active" ? "active" : st === "authenticated" || st === "created" ? "incomplete"
        : st === "pending" || st === "halted" || st === "paused" ? "past_due" : "canceled";
      const end = num(s.current_end);
      return {
        ...base, kind: "subscription_upsert",
        subscription: { providerSubscriptionId: String(s.id), userId: str(notes.userId), planId: str(notes.planId), providerPriceId: str(s.plan_id), status, currentPeriodEnd: end ? new Date(end * 1000) : undefined },
      };
    }
  }
  return { ...base, kind: "ignored" };
}

export const razorpayProvider: PaymentProvider = {
  name: "razorpay",
  isConfigured: () => { const e = env(); return !!(e.keyId && e.keySecret) || !!injected; },

  async createCheckout(i: CheckoutInput): Promise<CheckoutResult> {
    const order = await client().orders.create({
      amount: i.amount, currency: i.currency.toUpperCase(), receipt: i.paymentId.slice(0, 40), payment_capture: true,
      notes: { paymentId: i.paymentId, bookingId: i.bookingId },
    });
    const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    return { providerOrderId: order.id, checkoutUrl: `${base}/pay/razorpay/${encodeURIComponent(i.manageToken)}` };
  },

  parseWebhook(rawBody, headers) {
    const { webhookSecret } = env();
    if (!verifyRazorpayWebhookSignature(rawBody, headers.get("x-razorpay-signature"), webhookSecret)) throw new WebhookSignatureError();
    let body: Entity;
    try { body = JSON.parse(rawBody) as Entity; } catch { throw new WebhookSignatureError("Malformed webhook body"); }
    const eventId = headers.get("x-razorpay-event-id") || `sha:${createHash("sha256").update(rawBody).digest("hex")}`;
    return normalizeRazorpayEvent(body, eventId);
  },

  async refund(i) {
    const r = await client().payments.refund(i.providerPaymentId, {
      amount: i.amount, speed: "normal", receipt: i.idempotencyKey.slice(0, 40), notes: { reason: i.reason ?? "", refundKey: i.idempotencyKey },
    });
    return { providerRefundId: r.id };
  },

  async fetchPaymentStatus({ providerOrderId }) {
    const res = await client().orders.fetchPayments(providerOrderId);
    const items = res.items ?? [];
    const cap = items.find((p) => p.status === "captured");
    if (cap) return { status: "paid", providerPaymentId: cap.id, amount: cap.amount };
    if (items.length && items.every((p) => p.status === "failed")) return { status: "failed" as RemoteStatus };
    return { status: "pending" };
  },

  async createSubscriptionCheckout(i: SubscriptionCheckoutInput) {
    const sub = await client().subscriptions.create({
      plan_id: i.providerPriceId, total_count: 120, customer_notify: true, notes: { userId: i.userId, planId: i.planId },
    });
    return { checkoutUrl: sub.short_url };
  },
  async cancelSubscription(id) { await client().subscriptions.cancel(id, true); },
};
