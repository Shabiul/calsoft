import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { razorpayProvider, verifyRazorpayCheckoutSignature, verifyRazorpayWebhookSignature } from "./razorpay";
import { stripeProvider } from "./stripe";
import { WebhookSignatureError } from "./types";

const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("razorpay signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 5000, currency: "INR" } } } });

  beforeEach(() => { process.env.RAZORPAY_WEBHOOK_SECRET = secret; });

  it("accepts a valid signature over the raw body and normalizes the event", () => {
    const ev = razorpayProvider.parseWebhook(body, new Headers({ "x-razorpay-signature": hmac(secret, body), "x-razorpay-event-id": "evt_1" }));
    expect(ev).toMatchObject({ kind: "payment_paid", eventId: "evt_1", providerOrderId: "order_1", providerPaymentId: "pay_1", amount: 5000, currency: "INR" });
  });
  it("rejects invalid, missing, tampered and wrong-secret signatures", () => {
    const h = (sig?: string) => new Headers(sig ? { "x-razorpay-signature": sig } : {});
    expect(() => razorpayProvider.parseWebhook(body, h("deadbeef"))).toThrow(WebhookSignatureError);
    expect(() => razorpayProvider.parseWebhook(body, h())).toThrow(WebhookSignatureError);
    expect(() => razorpayProvider.parseWebhook(body + " ", h(hmac(secret, body)))).toThrow(WebhookSignatureError);
    expect(() => razorpayProvider.parseWebhook(body, h(hmac("other", body)))).toThrow(WebhookSignatureError);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    expect(() => razorpayProvider.parseWebhook(body, h(hmac(secret, body)))).toThrow(WebhookSignatureError);
  });
  it("replay of the same signed body parses to the same event id (idempotency key is stable)", () => {
    const h = () => new Headers({ "x-razorpay-signature": hmac(secret, body) });
    expect(razorpayProvider.parseWebhook(body, h()).eventId).toBe(razorpayProvider.parseWebhook(body, h()).eventId);
  });
  it("verifies checkout callback signature order_id|payment_id", () => {
    const sig = hmac("key_secret", "order_1|pay_1");
    expect(verifyRazorpayCheckoutSignature("order_1", "pay_1", sig, "key_secret")).toBe(true);
    expect(verifyRazorpayCheckoutSignature("order_1", "pay_2", sig, "key_secret")).toBe(false);
    expect(verifyRazorpayCheckoutSignature("order_1", "pay_1", sig, "wrong")).toBe(false);
    expect(verifyRazorpayWebhookSignature("x", null, secret)).toBe(false);
  });
});

describe("stripe signatures (real SDK verification)", () => {
  const secret = "whsec_stripe_test";
  const payload = JSON.stringify({
    id: "evt_s1", object: "event", type: "checkout.session.completed",
    data: { object: { id: "cs_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 5000, currency: "usd" } },
  });
  beforeEach(() => { process.env.STRIPE_SECRET_KEY = "sk_test_dummy"; process.env.STRIPE_WEBHOOK_SECRET = secret; });
  const header = (ts?: number) => new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret, timestamp: ts });

  it("accepts a correctly signed event", () => {
    const ev = stripeProvider.parseWebhook(payload, new Headers({ "stripe-signature": header() }));
    expect(ev).toMatchObject({ kind: "payment_paid", eventId: "evt_s1", providerOrderId: "cs_1", providerPaymentId: "pi_1", amount: 5000, currency: "USD" });
  });
  it("rejects bad signature, tampered body, missing header and stale timestamps (replay window)", () => {
    expect(() => stripeProvider.parseWebhook(payload, new Headers({ "stripe-signature": "t=1,v1=abc" }))).toThrow(WebhookSignatureError);
    expect(() => stripeProvider.parseWebhook(payload.replace("5000", "1"), new Headers({ "stripe-signature": header() }))).toThrow(WebhookSignatureError);
    expect(() => stripeProvider.parseWebhook(payload, new Headers())).toThrow(WebhookSignatureError);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(() => stripeProvider.parseWebhook(payload, new Headers({ "stripe-signature": header(old) }))).toThrow(WebhookSignatureError);
  });
  it("unpaid async checkout completion is ignored until async_payment_succeeded", () => {
    const p2 = payload.replace('"payment_status":"paid"', '"payment_status":"unpaid"');
    const h = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload: p2, secret });
    expect(stripeProvider.parseWebhook(p2, new Headers({ "stripe-signature": h })).kind).toBe("ignored");
  });
});
