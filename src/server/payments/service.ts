/**
 * Payments service: checkout sessions, provider-event processing (idempotent), refunds, reconciliation.
 * Booking concurrency guarantees are untouched: a pending_payment booking already holds the slot (exclusion constraint);
 * we only flip its status through `markBooking` (or a guarded revive of an expired hold, protected by the same constraint).
 */
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { AppError } from "../errors";
import { hashToken, markBooking, onBookingEvent, statusAfterPayment, type Booking } from "../services/booking";
import { applyPaymentEvent, isRefundable } from "./state";
import { computeRefundAmount } from "./policy";
import { getProvider, pickProvider } from "./providers";
import { ProviderNotConfiguredError, type NormalizedEvent, type ProviderName } from "./types";

const { bookings, payments, refunds, paymentWebhookEvents, eventTypes, invitees, subscriptions, subscriptionPlans, planProviderPrices, users, bookingEvents } = schema;
export type PaymentRow = typeof payments.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ───────── event emission (injectable for tests; defaults to the durable queue)
type PaymentEmit = (type: "payment.succeeded" | "payment.failed", payload: { bookingId: string }) => Promise<unknown>;
let emitter: PaymentEmit | null = null;
export function setPaymentEventEmitter(fn: PaymentEmit | null) { emitter = fn; }
async function emit(type: "payment.succeeded" | "payment.failed", bookingId: string) {
  try {
    if (emitter) await emitter(type, { bookingId });
    else { const q = await import("../queue"); await q.emitEvent(type, { bookingId }); }
  } catch (e) { console.warn(`[payments] emit ${type} failed:`, (e as Error).message); }
}

function pgCode(e: unknown): string | undefined {
  let cur = e as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 4 && cur; i++) { if (typeof cur.code === "string" && /^[0-9A-Z]{5}$/.test(cur.code)) return cur.code; cur = cur.cause as typeof cur; }
  return undefined;
}
const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const sum = (xs: { amount: number }[]) => xs.reduce((a, r) => a + r.amount, 0);

// ───────── booking lookups
async function primaryByToken(token: string): Promise<Booking> {
  if (!token) throw new AppError("NOT_FOUND", "Booking not found", 404);
  const [row] = await db.select().from(bookings).where(eq(bookings.manageTokenHash, hashToken(token))).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Booking not found", 404);
  return row;
}

/** Follows reschedule chains (a rescheduled pending_payment booking continues as a new row) to the live primary row. */
export async function currentBooking(bookingId: string): Promise<Booking> {
  let id = bookingId;
  for (let i = 0; i < 8; i++) {
    const [row] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    if (!row) throw new AppError("NOT_FOUND", "Booking not found", 404);
    const parent = (row.externalEventIds as Record<string, string>)?.collectiveOf;
    if (parent) { id = parent; continue; }
    if (row.status !== "rescheduled") return row;
    const [next] = await db.select({ id: bookings.id }).from(bookings)
      .where(and(eq(bookings.rescheduledFromId, row.id), sql`not (${bookings.externalEventIds} ? 'collectiveOf')`)).limit(1);
    if (!next) return row;
    id = next.id;
  }
  throw new AppError("INTERNAL", "Reschedule chain too long", 500);
}

async function groupIds(primary: Booking): Promise<string[]> {
  const rows = await db.select({ id: bookings.id }).from(bookings)
    .where(sql`${bookings.id} = ${primary.id} or ${bookings.externalEventIds}->>'collectiveOf' = ${primary.id}`);
  return rows.map((r) => r.id);
}

// ───────── checkout session
export type SessionResult = { status: "paid" } | { checkoutUrl: string };

export async function createPaymentSession(manageToken: string, now = new Date()): Promise<SessionResult> {
  const booking = await primaryByToken(manageToken);
  const [event] = await db.select().from(eventTypes).where(eq(eventTypes.id, booking.eventTypeId)).limit(1);
  if (!event) throw new AppError("NOT_FOUND", "Booking not found", 404);

  const [paid] = await db.select().from(payments).where(and(eq(payments.bookingId, booking.id), inArray(payments.status, ["paid", "partially_refunded"]))).limit(1);
  if (paid) {
    if (booking.status === "pending_payment") await settleBookingForPayment(paid.id);
    return { status: "paid" };
  }
  const price = event.priceAmount ?? 0;
  if (booking.status === "confirmed" || price <= 0) {
    if (booking.status === "pending_payment") throw new AppError("INVALID_STATE", "This booking does not require payment.", 409);
    return { status: "paid" };
  }
  if (booking.status !== "pending_payment") throw new AppError("INVALID_STATE", `Booking is ${booking.status}; payment is no longer possible.`, 409);
  if (booking.holdExpiresAt && booking.holdExpiresAt.getTime() <= now.getTime()) {
    throw new AppError("HOLD_EXPIRED", "Your reserved time slot has expired. Please pick a new time.", 409);
  }

  const currency = (event.priceCurrency ?? "USD").toUpperCase();
  const provider = pickProvider(event.paymentProvider, currency);
  if (!provider) throw new AppError("PAYMENTS_NOT_CONFIGURED", "Payments are not configured for this host.", 404);

  const [inv] = await db.select({ email: invitees.email }).from(invitees).where(eq(invitees.bookingId, booking.id)).limit(1);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"pay:" + booking.id}, 0))`);
    const [again] = await tx.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, booking.id)).for("update");
    if (again?.status !== "pending_payment") throw new AppError("INVALID_STATE", "Booking is no longer awaiting payment.", 409);

    const [reuse] = await tx.select().from(payments)
      .where(and(eq(payments.bookingId, booking.id), eq(payments.provider, provider.name), inArray(payments.status, ["requires_payment", "pending", "failed"])))
      .orderBy(desc(payments.createdAt)).limit(1);
    const row = reuse ?? (await tx.insert(payments).values({ bookingId: booking.id, provider: provider.name, amount: price, currency }).returning())[0];

    let checkout;
    try {
      checkout = await provider.createCheckout({
        paymentId: row.id, bookingId: booking.id, manageToken, amount: price, currency,
        description: event.title, customerEmail: inv?.email ?? "",
        successUrl: `${appUrl()}/booking/${encodeURIComponent(manageToken)}?payment=success`,
        cancelUrl: `${appUrl()}/booking/${encodeURIComponent(manageToken)}?payment=cancelled`,
      });
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) throw new AppError("PAYMENTS_NOT_CONFIGURED", "Payments are not configured for this host.", 404);
      console.error("[payments] createCheckout failed:", (e as Error).message);
      throw new AppError("PROVIDER_ERROR", "Could not start checkout with the payment provider. Please try again.", 502);
    }
    const t = applyPaymentEvent(row.status, { type: "session_created" });
    await tx.update(payments).set({ providerOrderId: checkout.providerOrderId, amount: price, currency, status: t.status, updatedAt: new Date() }).where(eq(payments.id, row.id));
    return { checkoutUrl: checkout.checkoutUrl };
  });
}

/** Data for the hosted Razorpay checkout page. null when there is nothing to pay. */
export async function getRazorpayCheckoutView(manageToken: string) {
  const booking = await primaryByToken(manageToken).catch(() => null);
  if (!booking || booking.status !== "pending_payment") return null;
  const [p] = await db.select().from(payments).where(and(eq(payments.bookingId, booking.id), eq(payments.provider, "razorpay"), eq(payments.status, "pending"))).orderBy(desc(payments.createdAt)).limit(1);
  if (!p?.providerOrderId) return null;
  const [ev] = await db.select({ title: eventTypes.title }).from(eventTypes).where(eq(eventTypes.id, booking.eventTypeId));
  const [inv] = await db.select({ email: invitees.email, name: invitees.name }).from(invitees).where(eq(invitees.bookingId, booking.id)).limit(1);
  return { orderId: p.providerOrderId, amount: p.amount, currency: p.currency, title: ev?.title ?? "Booking", email: inv?.email ?? "", name: inv?.name ?? "" };
}

// ───────── provider event processing (idempotent)
export type ProcessOutcome = "processed" | "duplicate" | "ignored";
const STALE_CLAIM_MS = 2 * 60_000;

export async function processProviderEvent(ev: NormalizedEvent, now = new Date()): Promise<ProcessOutcome> {
  const inserted = await db.insert(paymentWebhookEvents).values({ provider: ev.provider, eventId: ev.eventId, type: ev.rawType }).onConflictDoNothing().returning({ id: paymentWebhookEvents.id });
  let rowId = inserted[0]?.id;
  if (!rowId) {
    // Reclaim only failed or abandoned attempts; a processed/in-flight event is a duplicate delivery.
    const re = await db.update(paymentWebhookEvents).set({ status: "received", error: null, receivedAt: now })
      .where(and(eq(paymentWebhookEvents.provider, ev.provider), eq(paymentWebhookEvents.eventId, ev.eventId), or(
        eq(paymentWebhookEvents.status, "failed"),
        and(eq(paymentWebhookEvents.status, "received"), lt(paymentWebhookEvents.receivedAt, new Date(now.getTime() - STALE_CLAIM_MS))),
      ))).returning({ id: paymentWebhookEvents.id });
    if (!re[0]) return "duplicate";
    rowId = re[0].id;
  }
  try {
    const res = await dispatch(ev);
    await db.update(paymentWebhookEvents).set({ status: res.ignored ? "ignored" : "processed", error: res.note ?? null, processedAt: new Date() }).where(eq(paymentWebhookEvents.id, rowId));
    return res.ignored ? "ignored" : "processed";
  } catch (e) {
    await db.update(paymentWebhookEvents).set({ status: "failed", error: String((e as Error).message).slice(0, 500) }).where(eq(paymentWebhookEvents.id, rowId)).catch(() => undefined);
    throw e;
  }
}

async function dispatch(ev: NormalizedEvent): Promise<{ ignored?: boolean; note?: string }> {
  switch (ev.kind) {
    case "payment_paid": return handlePaid(ev);
    case "payment_failed": return handleFailed(ev);
    case "refund_processed": return handleExternalRefund(ev);
    case "subscription_upsert": return handleSubscription(ev);
    default: return { ignored: true };
  }
}

async function findPayment(x: Pick<typeof db, "select">, ev: NormalizedEvent): Promise<PaymentRow | null> {
  if (ev.providerOrderId) {
    const [p] = await x.select().from(payments).where(and(eq(payments.provider, ev.provider), eq(payments.providerOrderId, ev.providerOrderId))).limit(1);
    if (p) return p;
  }
  if (ev.providerPaymentId) {
    const [p] = await x.select().from(payments).where(and(eq(payments.provider, ev.provider), eq(payments.providerPaymentId, ev.providerPaymentId))).limit(1);
    if (p) return p;
  }
  return null;
}

async function handlePaid(ev: NormalizedEvent) {
  const found = await findPayment(db, ev);
  if (!found) return { ignored: true, note: "unknown payment" };
  if ((ev.amount !== undefined && ev.amount !== found.amount) || (ev.currency && ev.currency !== found.currency.toUpperCase())) {
    console.error(`[payments] amount/currency mismatch for payment ${found.id}: expected ${found.amount} ${found.currency}, got ${ev.amount} ${ev.currency}`);
    return { ignored: true, note: "amount mismatch" };
  }
  const changed = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, found.id)).for("update");
    const t = applyPaymentEvent(p.status, { type: "paid" });
    if (t.changed || (!p.providerPaymentId && ev.providerPaymentId)) {
      await tx.update(payments).set({ status: t.status, providerPaymentId: p.providerPaymentId ?? ev.providerPaymentId ?? null, updatedAt: new Date() }).where(eq(payments.id, p.id));
    }
    return t.changed;
  });
  const outcome = await settleBookingForPayment(found.id);
  if (outcome === "needs_refund") {
    await refundPayment(found.id, { reason: "Booking is no longer active; automatic refund" }).catch((e) => console.error("[payments] auto-refund failed:", (e as Error).message));
  } else if (changed || outcome === "confirmed") {
    const [p] = await db.select({ bookingId: payments.bookingId }).from(payments).where(eq(payments.id, found.id));
    await emit("payment.succeeded", p.bookingId);
  }
  return {};
}

async function handleFailed(ev: NormalizedEvent) {
  const found = await findPayment(db, ev);
  if (!found) return { ignored: true, note: "unknown payment" };
  const changed = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, found.id)).for("update");
    const t = applyPaymentEvent(p.status, { type: "failed" });
    if (t.changed) await tx.update(payments).set({ status: t.status, providerPaymentId: p.providerPaymentId ?? ev.providerPaymentId ?? null, updatedAt: new Date() }).where(eq(payments.id, p.id));
    return t.changed;
  });
  if (changed) await emit("payment.failed", found.bookingId);
  return {};
}

// ───────── booking settlement
/** Confirms the booking for a paid payment. 'needs_refund' = money received but the booking can no longer be honoured. */
export async function settleBookingForPayment(paymentId: string): Promise<"confirmed" | "noop" | "needs_refund"> {
  const [pay] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!pay) return "noop";
  const b = await currentBooking(pay.bookingId);
  if (b.id !== pay.bookingId) await db.update(payments).set({ bookingId: b.id, updatedAt: new Date() }).where(eq(payments.id, pay.id));
  if (b.status === "confirmed" || b.status === "pending_confirmation" || b.status === "completed" || b.status === "no_show") return "noop";
  if (b.status === "pending_payment") {
    try { await markBooking({ bookingId: b.id, status: "confirmed", actor: "system" }); return "confirmed"; }
    catch (e) { if (e instanceof AppError && e.code === "INVALID_STATE") return settleBookingForPayment(paymentId); throw e; }
  }
  if (b.status === "expired") {
    // Hold lapsed before the money arrived: re-confirm if nobody took the slot meanwhile (exclusion constraint decides).
    const ids = await groupIds(b);
    const [evt] = await db.select({ requiresConfirmation: eventTypes.requiresConfirmation }).from(eventTypes).where(eq(eventTypes.id, b.eventTypeId));
    const target = evt ? statusAfterPayment(evt) : "confirmed";
    try {
      const flipped = await db.transaction(async (tx) => {
        const res = await tx.update(bookings).set({ status: target, holdExpiresAt: null, updatedAt: new Date() })
          .where(and(inArray(bookings.id, ids), eq(bookings.status, "expired"))).returning({ id: bookings.id });
        for (const r of res) await tx.insert(bookingEvents).values({ bookingId: r.id, type: `marked_${target}`, actor: "system", data: { from: "expired", reason: "payment received after hold expiry" } });
        return res.length > 0;
      });
      if (flipped && target === "confirmed") await onBookingEvent("booking.confirmed", b.id);
      return "confirmed";
    } catch (e) {
      if (pgCode(e) === "23P01") return "needs_refund";
      throw e;
    }
  }
  return "needs_refund"; // cancelled
}

// ───────── refunds
export interface RefundResult { refundId: string; providerRefundId: string; amount: number }

export async function refundPayment(paymentId: string, opts: { amount?: number; reason?: string } = {}): Promise<RefundResult | null> {
  const reserved = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!p || !isRefundable(p.status)) return null;
    const existing = await tx.select({ amount: refunds.amount }).from(refunds).where(eq(refunds.paymentId, p.id));
    const refundable = p.amount - sum(existing);
    const amount = Math.min(opts.amount ?? refundable, refundable);
    if (amount <= 0) return null;
    if (!p.providerPaymentId) throw new AppError("INVALID_STATE", "Payment has no provider payment id yet; cannot refund.", 409);
    const [r] = await tx.insert(refunds).values({ paymentId: p.id, amount, reason: opts.reason ?? null }).returning();
    return { payment: p, refund: r };
  });
  if (!reserved) return null;
  const { payment, refund } = reserved;
  let providerRefundId: string;
  try {
    ({ providerRefundId } = await getProvider(payment.provider as ProviderName).refund({
      providerPaymentId: payment.providerPaymentId!, amount: refund.amount, currency: payment.currency, reason: opts.reason, idempotencyKey: refund.id,
    }));
  } catch (e) {
    await db.delete(refunds).where(and(eq(refunds.id, refund.id), isNull(refunds.providerRefundId)));
    throw new AppError("REFUND_FAILED", `Provider refund failed: ${(e as Error).message}`, 502);
  }
  await finalizeRefund(payment.id, { providerRefundId, amount: refund.amount, reservedId: refund.id });
  return { refundId: refund.id, providerRefundId, amount: refund.amount };
}

/** Records a confirmed provider refund (ours or external) under the payment lock and advances the payment state. */
async function finalizeRefund(paymentId: string, r: { providerRefundId: string; amount: number; reservedId?: string; reason?: string }, tx?: Tx) {
  const run = async (t: Tx) => {
    const [p] = await t.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    const [dupe] = await t.select().from(refunds).where(and(eq(refunds.paymentId, paymentId), eq(refunds.providerRefundId, r.providerRefundId))).limit(1);
    if (dupe) {
      if (r.reservedId && dupe.id !== r.reservedId) await t.delete(refunds).where(and(eq(refunds.id, r.reservedId), isNull(refunds.providerRefundId)));
    } else if (r.reservedId) {
      await t.update(refunds).set({ providerRefundId: r.providerRefundId }).where(eq(refunds.id, r.reservedId));
    } else {
      // Adopt an in-flight reservation of ours with the same amount before creating a new row.
      const [open] = await t.select().from(refunds).where(and(eq(refunds.paymentId, paymentId), isNull(refunds.providerRefundId), eq(refunds.amount, r.amount))).limit(1);
      if (open) await t.update(refunds).set({ providerRefundId: r.providerRefundId }).where(eq(refunds.id, open.id));
      else await t.insert(refunds).values({ paymentId, amount: r.amount, providerRefundId: r.providerRefundId, reason: r.reason ?? "Refund issued at payment provider" });
    }
    const confirmed = await t.select({ amount: refunds.amount, pid: refunds.providerRefundId }).from(refunds).where(eq(refunds.paymentId, paymentId));
    const total = sum(confirmed.filter((x) => x.pid));
    const tr = applyPaymentEvent(p.status, { type: "refund", refundedTotal: total, amount: p.amount });
    if (tr.changed) await t.update(payments).set({ status: tr.status, updatedAt: new Date() }).where(eq(payments.id, paymentId));
  };
  if (tx) await run(tx); else await db.transaction(run);
}

async function handleExternalRefund(ev: NormalizedEvent) {
  const found = await findPayment(db, ev);
  if (!found || !ev.refundId || !ev.refundAmount) return { ignored: true, note: "unknown payment/refund" };
  if (!isRefundable(found.status) && found.status !== "refunded") return { ignored: true, note: `payment ${found.status}` };
  await finalizeRefund(found.id, { providerRefundId: ev.refundId, amount: ev.refundAmount });
  return {};
}

/** Applies the cancellation policy to a cancelled booking's paid payments. Safe to call repeatedly. */
export async function refundForCancelledBooking(bookingId: string, now = new Date()): Promise<RefundResult[]> {
  const b = await currentBooking(bookingId);
  if (b.status !== "cancelled") return [];
  const [ev] = await db.select({ min: eventTypes.minCancelNoticeMinutes }).from(eventTypes).where(eq(eventTypes.id, b.eventTypeId));
  const pays = await db.select().from(payments).where(and(inArray(payments.bookingId, [b.id, bookingId]), inArray(payments.status, ["paid", "partially_refunded"])));
  const out: RefundResult[] = [];
  for (const p of pays) {
    const done = await db.select({ amount: refunds.amount }).from(refunds).where(eq(refunds.paymentId, p.id));
    const amount = computeRefundAmount({
      amount: p.amount, refunded: sum(done), startsAt: b.startsAt, cancelledAt: b.cancelledAt ?? now, cancelledBy: b.cancelledBy, minCancelNoticeMinutes: ev?.min ?? 0,
    });
    if (amount <= 0) continue;
    const r = await refundPayment(p.id, { amount, reason: `Booking cancelled${b.cancelledBy ? ` by ${b.cancelledBy}` : ""}` });
    if (r) out.push(r);
  }
  return out;
}

// ───────── subscriptions
function envPlanPriceId(provider: ProviderName, planId: string): string | undefined {
  const key = `${provider === "stripe" ? "STRIPE_PRICE" : "RAZORPAY_PLAN"}_${planId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return process.env[key] || undefined;
}
export async function providerPriceFor(provider: ProviderName, planId: string): Promise<string | undefined> {
  const [row] = await db.select().from(planProviderPrices).where(and(eq(planProviderPrices.planId, planId), eq(planProviderPrices.provider, provider))).limit(1);
  return row?.providerPriceId ?? envPlanPriceId(provider, planId);
}

async function handleSubscription(ev: NormalizedEvent) {
  const s = ev.subscription;
  if (!s) return { ignored: true };
  const superseded: { provider: ProviderName; id: string }[] = [];
  const res = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"sub:" + s.providerSubscriptionId}, 0))`);
    const [existing] = await tx.select().from(subscriptions).where(and(eq(subscriptions.provider, ev.provider), eq(subscriptions.providerSubscriptionId, s.providerSubscriptionId))).limit(1);

    let planId = s.planId;
    if (!planId && s.providerPriceId) {
      const [m] = await tx.select({ planId: planProviderPrices.planId }).from(planProviderPrices).where(and(eq(planProviderPrices.provider, ev.provider), eq(planProviderPrices.providerPriceId, s.providerPriceId))).limit(1);
      planId = m?.planId;
    }
    if (planId) {
      const [plan] = await tx.select({ id: subscriptionPlans.id }).from(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
      if (!plan) planId = undefined;
    }

    if (existing) {
      await tx.update(subscriptions).set({
        status: s.status, ...(planId ? { planId } : {}), ...(s.currentPeriodEnd ? { currentPeriodEnd: s.currentPeriodEnd } : {}),
      }).where(eq(subscriptions.id, existing.id));
      return { ignored: false };
    }
    if (!s.userId || !planId) return { ignored: true, note: "subscription without resolvable user/plan" };
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, s.userId));
    if (!u) return { ignored: true, note: "unknown user" };
    if (s.status === "active" || s.status === "trialing") {
      const old = await tx.select().from(subscriptions).where(and(eq(subscriptions.userId, s.userId), inArray(subscriptions.status, ["active", "trialing"])));
      for (const o of old) {
        await tx.update(subscriptions).set({ status: "canceled" }).where(eq(subscriptions.id, o.id));
        if (o.provider && o.providerSubscriptionId) superseded.push({ provider: o.provider as ProviderName, id: o.providerSubscriptionId });
      }
    }
    await tx.insert(subscriptions).values({
      userId: s.userId, planId, status: s.status, provider: ev.provider, providerSubscriptionId: s.providerSubscriptionId, currentPeriodEnd: s.currentPeriodEnd ?? null,
    });
    return { ignored: false };
  });
  // stop double billing for the plan being replaced (best effort; failure is logged, reconcile/billing page can retry)
  for (const o of superseded) {
    await getProvider(o.provider).cancelSubscription(o.id).catch((e) => console.error("[payments] cancel superseded subscription failed:", (e as Error).message));
  }
  return res;
}

// ───────── reconciliation
export interface ReconcileReport { checked: number; healed: number; refundsIssued: number; mismatches: string[]; errors: string[] }

/**
 * Compares local payments with the provider and heals drift (missed webhooks):
 *  1. unsettled payments (requires_payment/pending/failed, 2 min..7 d old) -> ask provider; paid => apply as a paid event
 *  2. paid payments whose booking is still pending_payment/expired -> settle again
 *  3. cancelled bookings with refundable payments -> apply refund policy
 *  4. reports orphaned refund reservations (provider call lost mid-flight) for manual review
 */
export async function reconcilePayments(now = new Date(), limit = 100): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, healed: 0, refundsIssued: 0, mismatches: [], errors: [] };
  const from = new Date(now.getTime() - 7 * 86_400_000), to = new Date(now.getTime() - 2 * 60_000);

  const open = await db.select().from(payments)
    .where(and(inArray(payments.status, ["requires_payment", "pending", "failed"]), sql`${payments.providerOrderId} is not null`, lt(payments.createdAt, to), sql`${payments.createdAt} > ${from.toISOString()}::timestamptz`))
    .limit(limit);
  for (const p of open) {
    report.checked++;
    try {
      const provider = getProvider(p.provider as ProviderName);
      if (!provider.isConfigured()) continue;
      const remote = await provider.fetchPaymentStatus({ providerOrderId: p.providerOrderId! });
      if (remote.status === "paid") {
        if (remote.amount !== undefined && remote.amount !== p.amount) { report.mismatches.push(`${p.id}: provider amount ${remote.amount} != local ${p.amount}`); continue; }
        const o = await processProviderEvent({ provider: p.provider as ProviderName, eventId: `reconcile:${p.provider}:${p.providerOrderId}`, rawType: "reconcile.paid", kind: "payment_paid", providerOrderId: p.providerOrderId!, providerPaymentId: remote.providerPaymentId, amount: remote.amount, currency: p.currency.toUpperCase() });
        if (o === "processed") report.healed++;
      }
    } catch (e) { report.errors.push(`${p.id}: ${(e as Error).message}`); }
  }

  const stuck = await db.select({ id: payments.id }).from(payments).innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(and(inArray(payments.status, ["paid"]), inArray(bookings.status, ["pending_payment", "expired", "rescheduled"]))).limit(limit);
  for (const s of stuck) {
    report.checked++;
    try {
      const o = await settleBookingForPayment(s.id);
      if (o === "confirmed") { report.healed++; const [p] = await db.select({ b: payments.bookingId }).from(payments).where(eq(payments.id, s.id)); await emit("payment.succeeded", p.b); }
      if (o === "needs_refund") { await refundPayment(s.id, { reason: "Booking is no longer active; automatic refund" }); report.refundsIssued++; }
    } catch (e) { report.errors.push(`${s.id}: ${(e as Error).message}`); }
  }

  const cancelled = await db.select({ bookingId: payments.bookingId }).from(payments).innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(and(inArray(payments.status, ["paid", "partially_refunded"]), eq(bookings.status, "cancelled"))).limit(limit);
  for (const c of cancelled) {
    try { report.refundsIssued += (await refundForCancelledBooking(c.bookingId, now)).length; } catch (e) { report.errors.push(`refund ${c.bookingId}: ${(e as Error).message}`); }
  }

  const orphans = await db.select({ id: refunds.id, paymentId: refunds.paymentId }).from(refunds)
    .where(and(isNull(refunds.providerRefundId), lt(refunds.createdAt, new Date(now.getTime() - 10 * 60_000)))).limit(50);
  for (const o of orphans) report.mismatches.push(`refund ${o.id} (payment ${o.paymentId}) has no provider refund id: verify at the provider`);
  return report;
}
