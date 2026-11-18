/**
 * Stripe provider: hosted Checkout Sessions (card data never touches this server) + SDK webhook verification
 * (signature over the raw body + timestamp tolerance => replay window). UNVERIFIED against a live Stripe account.
 */
import Stripe from "stripe";
import {
  WebhookSignatureError, ProviderNotConfiguredError,
  type CheckoutInput, type CheckoutResult, type NormalizedEvent, type PaymentProvider, type RemoteStatus, type SubscriptionCheckoutInput,
} from "./types";

/** Narrow view of the SDK so tests can inject a fake. */
export interface StripeClientLike {
  checkout: { sessions: {
    create(p: Record<string, unknown>, o?: Record<string, unknown>): Promise<{ id: string; url: string | null }>;
    retrieve(id: string): Promise<{ id: string; status?: string | null; payment_status?: string; payment_intent?: string | { id: string } | null; amount_total?: number | null }>;
  } };
  refunds: { create(p: Record<string, unknown>, o?: Record<string, unknown>): Promise<{ id: string }> };
  webhooks: { constructEvent(payload: string, header: string, secret: string, tolerance?: number): { id: string; type: string; data: { object: Record<string, unknown> } } };
  subscriptions: { update(id: string, p: Record<string, unknown>): Promise<unknown> };
}

let injected: StripeClientLike | null = null;
export function setStripeClient(c: StripeClientLike | null) { injected = c; }

function client(): StripeClientLike {
  if (injected) return injected;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ProviderNotConfiguredError("stripe");
  return new Stripe(key) as unknown as StripeClientLike;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const idOf = (v: unknown) => (typeof v === "string" ? v : str((v as Obj | null)?.id));

export function normalizeStripeEvent(ev: { id: string; type: string; data: { object: Obj } }): NormalizedEvent {
  const o = ev.data.object;
  const base = { provider: "stripe" as const, eventId: ev.id, rawType: ev.type };
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (o.mode === "subscription") {
        const md = (o.metadata ?? {}) as Obj;
        const sid = idOf(o.subscription);
        if (!sid) break;
        return { ...base, kind: "subscription_upsert", subscription: { providerSubscriptionId: sid, userId: str(md.userId), planId: str(md.planId), status: "active" } };
      }
      // completed + async method still unpaid: wait for async_payment_succeeded
      if (o.payment_status !== "paid") return { ...base, kind: "ignored" };
      return { ...base, kind: "payment_paid", providerOrderId: str(o.id), providerPaymentId: idOf(o.payment_intent), amount: num(o.amount_total), currency: str(o.currency)?.toUpperCase() };
    }
    case "checkout.session.async_payment_failed":
      return { ...base, kind: "payment_failed", providerOrderId: str(o.id), providerPaymentId: idOf(o.payment_intent) };
    case "refund.created":
    case "refund.updated": {
      if (o.status === "failed" || o.status === "canceled") return { ...base, kind: "ignored" };
      return { ...base, kind: "refund_processed", providerPaymentId: idOf(o.payment_intent), refundId: str(o.id), refundAmount: num(o.amount), currency: str(o.currency)?.toUpperCase() };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const md = (o.metadata ?? {}) as Obj;
      const items = ((o.items as Obj | undefined)?.data as Obj[] | undefined) ?? [];
      const st = String(o.status ?? "");
      const status = st === "active" ? "active" : st === "trialing" ? "trialing" : st === "past_due" || st === "unpaid" ? "past_due"
        : st === "incomplete" ? "incomplete" : "canceled";
      const end = num(o.current_period_end) ?? num(items[0]?.current_period_end);
      return {
        ...base, kind: "subscription_upsert",
        subscription: {
          providerSubscriptionId: String(o.id), userId: str(md.userId), planId: str(md.planId),
          providerPriceId: str((items[0]?.price as Obj | undefined)?.id), status: ev.type === "customer.subscription.deleted" ? "canceled" : status,
          currentPeriodEnd: end ? new Date(end * 1000) : undefined,
        },
      };
    }
  }
  return { ...base, kind: "ignored" };
}

export const stripeProvider: PaymentProvider = {
  name: "stripe",
  isConfigured: () => !!process.env.STRIPE_SECRET_KEY || !!injected,

  async createCheckout(i: CheckoutInput): Promise<CheckoutResult> {
    const s = await client().checkout.sessions.create({
      mode: "payment", client_reference_id: i.paymentId, customer_email: i.customerEmail,
      line_items: [{ quantity: 1, price_data: { currency: i.currency.toLowerCase(), unit_amount: i.amount, product_data: { name: i.description } } }],
      success_url: i.successUrl, cancel_url: i.cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60, // Stripe minimum is 30 min
      metadata: { paymentId: i.paymentId, bookingId: i.bookingId },
      payment_intent_data: { metadata: { paymentId: i.paymentId, bookingId: i.bookingId } },
    }, { idempotencyKey: `checkout-${i.paymentId}-${Date.now().toString(36)}` });
    if (!s.url) throw new Error("Stripe did not return a checkout URL");
    return { providerOrderId: s.id, checkoutUrl: s.url };
  },

  parseWebhook(rawBody, headers) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const sig = headers.get("stripe-signature");
    if (!secret || !sig) throw new WebhookSignatureError();
    let ev: { id: string; type: string; data: { object: Obj } };
    try {
      ev = client().webhooks.constructEvent(rawBody, sig, secret, 300);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) throw e;
      throw new WebhookSignatureError();
    }
    return normalizeStripeEvent(ev);
  },

  async refund(i) {
    const r = await client().refunds.create(
      { payment_intent: i.providerPaymentId, amount: i.amount, metadata: { refundKey: i.idempotencyKey, reason: i.reason ?? "" } },
      { idempotencyKey: `refund-${i.idempotencyKey}` },
    );
    return { providerRefundId: r.id };
  },

  async fetchPaymentStatus({ providerOrderId }) {
    const s = await client().checkout.sessions.retrieve(providerOrderId);
    const pi = idOf(s.payment_intent);
    if (s.payment_status === "paid") return { status: "paid", providerPaymentId: pi, amount: s.amount_total ?? undefined };
    if (s.status === "expired") return { status: "failed" as RemoteStatus };
    return { status: "pending" };
  },

  async createSubscriptionCheckout(i: SubscriptionCheckoutInput) {
    const md = { userId: i.userId, planId: i.planId };
    const s = await client().checkout.sessions.create({
      mode: "subscription", customer_email: i.email, line_items: [{ price: i.providerPriceId, quantity: 1 }],
      success_url: i.successUrl, cancel_url: i.cancelUrl, metadata: md, subscription_data: { metadata: md },
    });
    if (!s.url) throw new Error("Stripe did not return a checkout URL");
    return { checkoutUrl: s.url };
  },
  async cancelSubscription(id) { await client().subscriptions.update(id, { cancel_at_period_end: true }); },
};
