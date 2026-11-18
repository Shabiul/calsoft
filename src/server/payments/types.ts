export type ProviderName = "razorpay" | "stripe";
export const PROVIDER_NAMES: ProviderName[] = ["razorpay", "stripe"];
export const isProviderName = (v: unknown): v is ProviderName => v === "razorpay" || v === "stripe";

export interface CheckoutInput {
  paymentId: string; bookingId: string; manageToken: string;
  amount: number; currency: string; description: string; customerEmail: string;
  successUrl: string; cancelUrl: string;
}
export interface CheckoutResult { providerOrderId: string; checkoutUrl: string }

export type NormalizedEventKind =
  | "payment_paid" | "payment_failed" | "refund_processed"
  | "subscription_upsert" | "ignored";

export interface NormalizedEvent {
  provider: ProviderName;
  /** Provider-unique event id; the idempotency key. */
  eventId: string;
  /** Raw provider event type (for the processing log). */
  rawType: string;
  kind: NormalizedEventKind;
  providerOrderId?: string;
  providerPaymentId?: string;
  amount?: number; currency?: string;
  refundId?: string; refundAmount?: number;
  subscription?: {
    providerSubscriptionId: string; userId?: string; planId?: string; providerPriceId?: string;
    status: "active" | "trialing" | "past_due" | "canceled" | "incomplete";
    currentPeriodEnd?: Date;
  };
}

export type RemoteStatus = "paid" | "pending" | "failed" | "unknown";

export interface SubscriptionCheckoutInput {
  userId: string; email: string; planId: string; providerPriceId: string; successUrl: string; cancelUrl: string;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  isConfigured(): boolean;
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  /** Verifies the signature over the RAW body and returns a normalized event. Throws WebhookSignatureError. */
  parseWebhook(rawBody: string, headers: Headers): NormalizedEvent;
  refund(input: { providerPaymentId: string; amount: number; currency: string; reason?: string; idempotencyKey: string }): Promise<{ providerRefundId: string }>;
  fetchPaymentStatus(input: { providerOrderId: string }): Promise<{ status: RemoteStatus; providerPaymentId?: string; amount?: number }>;
  createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<{ checkoutUrl: string }>;
  cancelSubscription(providerSubscriptionId: string): Promise<void>;
}

export class WebhookSignatureError extends Error {
  constructor(message = "Invalid webhook signature") { super(message); this.name = "WebhookSignatureError"; }
}
export class ProviderNotConfiguredError extends Error {
  constructor(readonly provider: string) { super(`Payment provider "${provider}" is not configured`); this.name = "ProviderNotConfiguredError"; }
}
