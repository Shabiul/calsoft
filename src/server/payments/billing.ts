import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { AppError } from "../errors";
import { currentUsage, getPlanLimits, type PlanMetric } from "../services/plan-limits";
import { configuredProviders, getProvider } from "./providers";
import { providerPriceFor } from "./service";
import { PROVIDER_NAMES, type ProviderName } from "./types";

const { subscriptions, subscriptionPlans, payments, refunds, bookings, eventTypes, invitees } = schema;

const USAGE_METRICS: { metric: PlanMetric; label: string }[] = [
  { metric: "maxEventTypes", label: "Event types" },
  { metric: "maxSchedules", label: "Availability schedules" },
];

export interface BillingOverview {
  plan: { id: string | null; name: string; priceMonthly: number; currency: string } | null;
  subscription: { id: string; status: string; provider: string | null; currentPeriodEnd: Date | null; canCancel: boolean } | null;
  usage: { metric: string; label: string; used: number; limit: number | null }[];
  features: { key: string; enabled: boolean }[];
  plans: { id: string; name: string; priceMonthly: number; currency: string; current: boolean; limits: Record<string, number | boolean>; providers: ProviderName[] }[];
  providersConfigured: ProviderName[];
  payments: PaymentListItem[];
  totals: { currency: string; collected: number; refunded: number }[];
}
export interface PaymentListItem {
  id: string; createdAt: Date; amount: number; currency: string; status: string; provider: string; refunded: number;
  eventTitle: string; inviteeName: string | null; inviteeEmail: string | null; bookingId: string;
}

export async function listHostPayments(userId: string, limit = 50, paymentId?: string): Promise<PaymentListItem[]> {
  const rows = await db.select({
    id: payments.id, createdAt: payments.createdAt, amount: payments.amount, currency: payments.currency, status: payments.status, provider: payments.provider,
    bookingId: payments.bookingId, eventTitle: eventTypes.title,
  }).from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .where(and(eq(bookings.hostUserId, userId), paymentId ? eq(payments.id, paymentId) : inArray(payments.status, ["paid", "refunded", "partially_refunded", "failed"])))
    .orderBy(desc(payments.createdAt)).limit(limit);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id), bids = rows.map((r) => r.bookingId);
  const refunded = await db.select({ paymentId: refunds.paymentId, n: sql<number>`coalesce(sum(${refunds.amount}),0)::int` }).from(refunds)
    .where(and(inArray(refunds.paymentId, ids), sql`${refunds.providerRefundId} is not null`)).groupBy(refunds.paymentId);
  const inv = await db.select({ bookingId: invitees.bookingId, name: invitees.name, email: invitees.email }).from(invitees).where(inArray(invitees.bookingId, bids));
  const rm = new Map(refunded.map((r) => [r.paymentId, r.n])), im = new Map(inv.map((i) => [i.bookingId, i]));
  return rows.map((r) => ({
    ...r, refunded: rm.get(r.id) ?? 0, inviteeName: im.get(r.bookingId)?.name ?? null, inviteeEmail: im.get(r.bookingId)?.email ?? null,
  }));
}

export async function getBillingOverview(userId: string): Promise<BillingOverview> {
  const { planId, limits } = await getPlanLimits({ userId });
  const allPlans = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.isActive, true)).orderBy(subscriptionPlans.priceMonthly);
  const prices = await db.select().from(schema.planProviderPrices);
  const current = planId ? (await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)))[0] : undefined;
  const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ["active", "trialing", "past_due"]))).orderBy(desc(subscriptions.createdAt)).limit(1);

  const configured = configuredProviders();
  const planProviders = async (id: string) => {
    const out: ProviderName[] = [];
    for (const p of configured) {
      if (prices.some((x) => x.planId === id && x.provider === p) || (await providerPriceFor(p, id))) out.push(p);
    }
    return out;
  };

  const usage = [];
  for (const { metric, label } of USAGE_METRICS) {
    const lim = limits[metric];
    usage.push({ metric, label, used: await currentUsage({ userId }, metric), limit: typeof lim === "number" && lim >= 0 ? lim : null });
  }
  const features = Object.entries(limits).filter(([, v]) => typeof v === "boolean").map(([key, v]) => ({ key, enabled: v === true }));

  const list = await listHostPayments(userId);
  const totals = new Map<string, { collected: number; refunded: number }>();
  for (const p of list) {
    if (p.status === "failed") continue;
    const t = totals.get(p.currency) ?? { collected: 0, refunded: 0 };
    t.collected += p.amount; t.refunded += p.refunded; totals.set(p.currency, t);
  }

  return {
    plan: current ? { id: current.id, name: current.name, priceMonthly: current.priceMonthly, currency: current.currency } : null,
    subscription: sub ? { id: sub.id, status: sub.status, provider: sub.provider, currentPeriodEnd: sub.currentPeriodEnd, canCancel: !!sub.providerSubscriptionId && sub.status !== "canceled" } : null,
    usage, features,
    plans: await Promise.all(allPlans.map(async (p) => ({
      id: p.id, name: p.name, priceMonthly: p.priceMonthly, currency: p.currency, current: p.id === planId, limits: p.limits, providers: await planProviders(p.id),
    }))),
    providersConfigured: configured,
    payments: list,
    totals: [...totals].map(([currency, t]) => ({ currency, ...t })),
  };
}

/** Starts hosted subscription checkout. Throws 404 PAYMENTS_NOT_CONFIGURED when no provider/price mapping exists. */
export async function startUpgradeCheckout(user: { id: string; email: string }, planId: string, providerName?: string): Promise<{ checkoutUrl: string }> {
  const [plan] = await db.select().from(subscriptionPlans).where(and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.isActive, true)));
  if (!plan) throw new AppError("NOT_FOUND", "Plan not found", 404);
  if (plan.priceMonthly <= 0) throw new AppError("INVALID_STATE", "This plan is free; no checkout is needed.", 409);
  const { planId: cur } = await getPlanLimits({ userId: user.id });
  if (cur === plan.id) throw new AppError("INVALID_STATE", "You are already on this plan.", 409);

  const candidates = (providerName ? PROVIDER_NAMES.filter((p) => p === providerName) : configuredProviders()).filter((p) => getProvider(p).isConfigured());
  for (const p of candidates) {
    const priceId = await providerPriceFor(p, plan.id);
    if (!priceId) continue;
    const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    try {
      return await getProvider(p).createSubscriptionCheckout({
        userId: user.id, email: user.email, planId: plan.id, providerPriceId: priceId,
        successUrl: `${base}/dashboard/billing?upgraded=1`, cancelUrl: `${base}/dashboard/billing`,
      });
    } catch (e) {
      console.error("[billing] subscription checkout failed:", (e as Error).message);
      throw new AppError("PROVIDER_ERROR", "Could not start checkout with the payment provider. Please try again.", 502);
    }
  }
  throw new AppError("PAYMENTS_NOT_CONFIGURED", "Online upgrades are not configured for this plan yet.", 404);
}

export async function cancelMySubscription(userId: string): Promise<void> {
  const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ["active", "trialing", "past_due"]))).orderBy(desc(subscriptions.createdAt)).limit(1);
  if (!sub?.provider || !sub.providerSubscriptionId) throw new AppError("NOT_FOUND", "No cancellable subscription found.", 404);
  try { await getProvider(sub.provider as ProviderName).cancelSubscription(sub.providerSubscriptionId); }
  catch (e) { console.error("[billing] cancel failed:", (e as Error).message); throw new AppError("PROVIDER_ERROR", "Could not cancel with the payment provider. Please try again.", 502); }
  // local status follows the provider webhook (cancels at period end)
}
