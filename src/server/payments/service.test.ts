/**
 * Integration tests against the real dev Postgres with provider SDKs replaced by fakes.
 * Fixtures are isolated by a random suffix and removed afterwards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { AppError } from "../errors";
import { getAvailableSlots } from "../scheduling/slots";
import { cancelBooking, createBooking, setBookingEventHook } from "../services/booking";
import { setStripeClient, type StripeClientLike } from "./stripe";
import { setRazorpayClient, type RazorpayClientLike } from "./razorpay";
import {
  createPaymentSession, processProviderEvent, reconcilePayments, refundForCancelledBooking, setPaymentEventEmitter,
} from "./service";
import { handleWebhookRequest, verifyRazorpayCheckout } from "./webhook";
import type { NormalizedEvent } from "./types";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `t_${run}_${n}`;
const bookingEvents: { type: string; id: string }[] = [];
const paymentEvents: { type: string; id: string }[] = [];
setBookingEventHook((type, id) => { bookingEvents.push({ type, id }); });
setPaymentEventEmitter(async (type, p) => { paymentEvents.push({ type, id: p.bookingId }); });

const stripe = {
  checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
  refunds: { create: vi.fn() },
  webhooks: { constructEvent: vi.fn() },
  subscriptions: { update: vi.fn() },
};
const razorpay = {
  orders: { create: vi.fn(), fetchPayments: vi.fn() },
  payments: { refund: vi.fn() },
  subscriptions: { create: vi.fn(), cancel: vi.fn() },
};

const userIds: string[] = [];
const eventIds: string[] = [];
const planIds: string[] = [];
let host: string;
let paidEvent: string;
let rzpEvent: string;
let slotCursor = 0;
let seq = 0;
const evId = (p: string) => `${run}-${p}-${++seq}`;

async function slots(eventId: string) {
  return getAvailableSlots({ eventTypeId: eventId, from: new Date(), to: new Date(Date.now() + 6 * 86_400_000), inviteeTimeZone: "UTC" });
}
/** A pending_payment booking for the given paid event, each at a fresh slot. */
async function mkBooking(eventId = paidEvent) {
  const s = await slots(eventId);
  const slot = s[slotCursor += 3];
  const r = await createBooking({ eventTypeId: eventId, startsAt: slot.startsAt, invitee: { name: "Pat Payer", email: `pat-${run}@example.test`, timeZone: "UTC" } });
  expect(r.booking.status).toBe("pending_payment");
  return { booking: r.booking, token: r.manageToken!, startsAt: slot.startsAt };
}
const payRow = async (bookingId: string) => (await db.select().from(schema.payments).where(eq(schema.payments.bookingId, bookingId)))[0];
const status = async (bookingId: string) => (await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)))[0].status;
const paidEv = (orderId: string, id = evId("paid"), extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  provider: "stripe", eventId: id, rawType: "checkout.session.completed", kind: "payment_paid", providerOrderId: orderId, providerPaymentId: `pi_${id}`, amount: 5000, currency: "USD", ...extra,
});

async function startStripeSession(token: string) {
  const orderId = `cs_${evId("s")}`;
  stripe.checkout.sessions.create.mockResolvedValueOnce({ id: orderId, url: `https://checkout.stripe.test/${orderId}` });
  const r = await createPaymentSession(token);
  return { r, orderId };
}

beforeAll(async () => {
  setStripeClient(stripe as unknown as StripeClientLike);
  setRazorpayClient(razorpay as unknown as RazorpayClientLike);
  host = uid("host");
  await db.insert(schema.users).values({ id: host, name: "Host", email: `${host}@example.test`, timeZone: "UTC" });
  userIds.push(host);
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: host, name: "Work", timeZone: "UTC", isDefault: true }).returning();
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "00:00", endTime: "23:59" })));
  const mk = async (slug: string, o: Partial<typeof schema.eventTypes.$inferInsert>) => {
    const [e] = await db.insert(schema.eventTypes).values({
      ownerUserId: host, slug: `${slug}-${run}`, title: slug, durationMinutes: 15, minNoticeMinutes: 0, maxHorizonDays: 30,
      priceAmount: 5000, priceCurrency: "USD", paymentProvider: "stripe", ...o,
    }).returning();
    eventIds.push(e.id);
    return e.id;
  };
  paidEvent = await mk("paid", {});
  rzpEvent = await mk("rzp", { priceCurrency: "INR", paymentProvider: "razorpay" });
});

beforeEach(() => { bookingEvents.length = 0; paymentEvents.length = 0; });

afterAll(async () => {
  setBookingEventHook(null); setPaymentEventEmitter(null); setStripeClient(null); setRazorpayClient(null);
  const bs = eventIds.length ? await db.select({ id: schema.bookings.id }).from(schema.bookings).where(inArray(schema.bookings.eventTypeId, eventIds)) : [];
  if (bs.length) {
    const ps = await db.select({ id: schema.payments.id }).from(schema.payments).where(inArray(schema.payments.bookingId, bs.map((b) => b.id)));
    if (ps.length) {
      await db.delete(schema.refunds).where(inArray(schema.refunds.paymentId, ps.map((p) => p.id)));
      await db.delete(schema.payments).where(inArray(schema.payments.id, ps.map((p) => p.id)));
    }
    await db.delete(schema.bookings).where(inArray(schema.bookings.id, bs.map((b) => b.id)));
  }
  if (eventIds.length) await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, eventIds));
  await db.delete(schema.paymentWebhookEvents).where(like(schema.paymentWebhookEvents.eventId, `${run}%`));
  await db.delete(schema.paymentWebhookEvents).where(like(schema.paymentWebhookEvents.eventId, `reconcile:%cs_${run}%`));
  await db.delete(schema.subscriptions).where(inArray(schema.subscriptions.userId, userIds));
  if (planIds.length) await db.delete(schema.subscriptionPlans).where(inArray(schema.subscriptionPlans.id, planIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await pool.end();
});

describe("checkout session", () => {
  it("creates a pending payment from the event price (never client input) and returns the hosted URL", async () => {
    const { booking, token } = await mkBooking();
    const { r, orderId } = await startStripeSession(token);
    expect(r).toEqual({ checkoutUrl: `https://checkout.stripe.test/${orderId}` });
    const p = await payRow(booking.id);
    expect(p).toMatchObject({ provider: "stripe", providerOrderId: orderId, amount: 5000, currency: "USD", status: "pending" });
    const call = stripe.checkout.sessions.create.mock.calls.at(-1)![0] as { line_items: { price_data: { unit_amount: number } }[] };
    expect(call.line_items[0].price_data.unit_amount).toBe(5000);
    expect(await status(booking.id)).toBe("pending_payment");
  });

  it("retrying reuses the payment row (one payment per booking attempt)", async () => {
    const { booking, token } = await mkBooking();
    await startStripeSession(token);
    const second = await startStripeSession(token);
    const rows = await db.select().from(schema.payments).where(eq(schema.payments.bookingId, booking.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].providerOrderId).toBe(second.orderId);
  });

  it("404 PAYMENTS_NOT_CONFIGURED when the provider has no credentials; unknown token is 404", async () => {
    const { token } = await mkBooking();
    setStripeClient(null);
    const saved = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
    try {
      await expect(createPaymentSession(token)).rejects.toMatchObject({ code: "PAYMENTS_NOT_CONFIGURED", status: 404 });
    } finally { if (saved) process.env.STRIPE_SECRET_KEY = saved; setStripeClient(stripe as unknown as StripeClientLike); }
    await expect(createPaymentSession("nope-nope-nope-nope")).rejects.toMatchObject({ status: 404 });
  });

  it("provider failure surfaces as 502 and leaves the hold intact", async () => {
    const { booking, token } = await mkBooking();
    stripe.checkout.sessions.create.mockRejectedValueOnce(new Error("boom"));
    await expect(createPaymentSession(token)).rejects.toMatchObject({ code: "PROVIDER_ERROR", status: 502 });
    expect(await status(booking.id)).toBe("pending_payment");
  });

  it("an expired hold cannot start checkout (409)", async () => {
    const { token } = await mkBooking();
    await expect(createPaymentSession(token, new Date(Date.now() + 16 * 60_000))).rejects.toMatchObject({ code: "HOLD_EXPIRED", status: 409 });
  });
});

describe("paid events: confirm flow + idempotency", () => {
  it("paid event confirms the booking and emits booking.confirmed + payment.succeeded exactly once", async () => {
    const { booking, token } = await mkBooking();
    const { orderId } = await startStripeSession(token);
    const ev = paidEv(orderId);
    expect(await processProviderEvent(ev)).toBe("processed");
    expect(await status(booking.id)).toBe("confirmed");
    expect((await payRow(booking.id)).status).toBe("paid");
    expect((await payRow(booking.id)).providerPaymentId).toBe(ev.providerPaymentId);
    expect(bookingEvents.filter((e) => e.type === "booking.confirmed")).toHaveLength(1);
    expect(paymentEvents).toEqual([{ type: "payment.succeeded", id: booking.id }]);
    // same provider event id replayed
    expect(await processProviderEvent(ev)).toBe("duplicate");
    // different provider event for the same payment (e.g. order.paid after payment.captured): state machine no-op
    expect(await processProviderEvent(paidEv(orderId, evId("again")))).toBe("processed");
    expect(paymentEvents).toHaveLength(1);
    expect(bookingEvents.filter((e) => e.type === "booking.confirmed")).toHaveLength(1);
    // session endpoint now reports paid
    expect(await createPaymentSession(token)).toEqual({ status: "paid" });
  });

  it("concurrent duplicate deliveries still confirm once", async () => {
    const { booking, token } = await mkBooking();
    const { orderId } = await startStripeSession(token);
    const ev = paidEv(orderId);
    const res = await Promise.allSettled([processProviderEvent(ev), processProviderEvent(ev), processProviderEvent(ev)]);
    expect(res.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await status(booking.id)).toBe("confirmed");
    expect(paymentEvents.filter((e) => e.type === "payment.succeeded")).toHaveLength(1);
  });

  it("amount mismatch is rejected: booking stays pending", async () => {
    const { booking, token } = await mkBooking();
    const { orderId } = await startStripeSession(token);
    expect(await processProviderEvent(paidEv(orderId, evId("bad"), { amount: 100 }))).toBe("ignored");
    expect(await status(booking.id)).toBe("pending_payment");
    expect((await payRow(booking.id)).status).toBe("pending");
  });

  it("unknown payment ids are ignored, not errors", async () => {
    expect(await processProviderEvent(paidEv(`cs_unknown_${run}`))).toBe("ignored");
  });

  it("failed event emits payment.failed, keeps the hold, and a later success still confirms", async () => {
    const { booking, token } = await mkBooking();
    const { orderId } = await startStripeSession(token);
    await processProviderEvent({ provider: "stripe", eventId: evId("fail"), rawType: "checkout.session.async_payment_failed", kind: "payment_failed", providerOrderId: orderId });
    expect(paymentEvents).toEqual([{ type: "payment.failed", id: booking.id }]);
    expect((await payRow(booking.id)).status).toBe("failed");
    expect(await status(booking.id)).toBe("pending_payment");
    await processProviderEvent(paidEv(orderId));
    expect(await status(booking.id)).toBe("confirmed");
  });

  it("payment after the hold expired re-confirms when the slot is still free", async () => {
    const { booking, token } = await mkBooking();
    const { orderId } = await startStripeSession(token);
    await db.update(schema.bookings).set({ status: "expired" }).where(eq(schema.bookings.id, booking.id));
    await processProviderEvent(paidEv(orderId));
    expect(await status(booking.id)).toBe("confirmed");
    expect(bookingEvents.some((e) => e.type === "booking.confirmed")).toBe(true);
  });

  it("payment after expiry when someone else took the slot is refunded automatically", async () => {
    const a = await mkBooking();
    const { orderId } = await startStripeSession(a.token);
    await db.update(schema.bookings).set({ status: "expired" }).where(eq(schema.bookings.id, a.booking.id));
    const b = await createBooking({ eventTypeId: paidEvent, startsAt: a.startsAt, invitee: { name: "Other", email: `o-${run}@example.test`, timeZone: "UTC" } });
    expect(b.booking.status).toBe("pending_payment");
    stripe.refunds.create.mockResolvedValueOnce({ id: `re_${evId("x")}` });
    await processProviderEvent(paidEv(orderId));
    expect(await status(a.booking.id)).toBe("expired");
    expect(stripe.refunds.create).toHaveBeenCalled();
    expect((await payRow(a.booking.id)).status).toBe("refunded");
    expect(await status(b.booking.id)).toBe("pending_payment"); // winner untouched
  });
});

describe("refunds", () => {
  async function paidBooking() {
    const { booking, token } = await mkBooking();
    const { orderId } = await startStripeSession(token);
    await processProviderEvent(paidEv(orderId));
    return { booking, token, orderId };
  }

  it("host cancellation refunds in full exactly once (refund row + provider call)", async () => {
    const { booking } = await paidBooking();
    await cancelBooking({ bookingId: booking.id, actor: "host" });
    stripe.refunds.create.mockClear(); stripe.refunds.create.mockResolvedValueOnce({ id: `re_${evId("c")}` });
    const out = await refundForCancelledBooking(booking.id);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(5000);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect((stripe.refunds.create.mock.calls[0][0] as { amount: number }).amount).toBe(5000);
    const p = await payRow(booking.id);
    expect(p.status).toBe("refunded");
    expect(await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, p.id))).toHaveLength(1);
    // second sweep does nothing
    expect(await refundForCancelledBooking(booking.id)).toEqual([]);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("provider refund failure leaves no phantom refund row and keeps the payment paid", async () => {
    const { booking } = await paidBooking();
    await cancelBooking({ bookingId: booking.id, actor: "host" });
    stripe.refunds.create.mockRejectedValueOnce(new Error("provider down"));
    await expect(refundForCancelledBooking(booking.id)).rejects.toBeInstanceOf(AppError);
    const p = await payRow(booking.id);
    expect(p.status).toBe("paid");
    expect(await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, p.id))).toHaveLength(0);
  });

  it("provider-initiated partial refund webhook marks partially_refunded; replays do not double count", async () => {
    const { booking } = await paidBooking();
    const ev: NormalizedEvent = { provider: "stripe", eventId: evId("ref"), rawType: "refund.created", kind: "refund_processed", providerPaymentId: (await payRow(booking.id)).providerPaymentId!, refundId: `re_${evId("p")}`, refundAmount: 1000 };
    await processProviderEvent(ev);
    expect((await payRow(booking.id)).status).toBe("partially_refunded");
    await processProviderEvent(ev);
    await processProviderEvent({ ...ev, eventId: evId("ref2") }); // same refund id, new event id
    const p = await payRow(booking.id);
    expect(await db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, p.id))).toHaveLength(1);
  });

  it("does not refund an active booking", async () => {
    const { booking } = await paidBooking();
    expect(await refundForCancelledBooking(booking.id)).toEqual([]);
  });
});

describe("reconciliation", () => {
  it("heals a missed webhook by asking the provider", async () => {
    const { booking, token } = await mkBooking();
    const { orderId } = await startStripeSession(token);
    await db.update(schema.payments).set({ createdAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.payments.bookingId, booking.id));
    stripe.checkout.sessions.retrieve.mockImplementation(async (id: string) => (id === orderId
      ? { id, payment_status: "paid", payment_intent: "pi_recon", amount_total: 5000, status: "complete" }
      : { id, payment_status: "unpaid", status: "open" }));
    const report = await reconcilePayments();
    expect(report.healed).toBeGreaterThanOrEqual(1);
    expect(await status(booking.id)).toBe("confirmed");
    expect((await payRow(booking.id)).providerPaymentId).toBe("pi_recon");
    expect(paymentEvents.some((e) => e.id === booking.id && e.type === "payment.succeeded")).toBe(true);
    stripe.checkout.sessions.retrieve.mockReset();
  });

  it("reports provider/local amount mismatches instead of confirming", async () => {
    const { booking, token } = await mkBooking();
    const { orderId } = await startStripeSession(token);
    await db.update(schema.payments).set({ createdAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.payments.bookingId, booking.id));
    stripe.checkout.sessions.retrieve.mockImplementation(async (id: string) => (id === orderId
      ? { id, payment_status: "paid", payment_intent: "pi_x", amount_total: 1, status: "complete" } : { id, payment_status: "unpaid", status: "open" }));
    const report = await reconcilePayments();
    expect(report.mismatches.some((m) => m.includes("provider amount 1"))).toBe(true);
    expect(await status(booking.id)).toBe("pending_payment");
    stripe.checkout.sessions.retrieve.mockReset();
  });
});

describe("razorpay flow + webhook endpoint", () => {
  const KEY_SECRET = "rzp_key_secret_test", WH_SECRET = "rzp_wh_secret_test";
  const saved = { ...process.env };
  beforeAll(() => { process.env.RAZORPAY_KEY_ID = "rzp_test_x"; process.env.RAZORPAY_KEY_SECRET = KEY_SECRET; process.env.RAZORPAY_WEBHOOK_SECRET = WH_SECRET; });
  afterAll(() => { process.env = { ...saved }; });
  const hmac = (s: string, d: string) => createHmac("sha256", s).update(d).digest("hex");

  async function rzpBooking() {
    const s = await slots(rzpEvent);
    const r = await createBooking({ eventTypeId: rzpEvent, startsAt: s[slotCursor += 3].startsAt, invitee: { name: "R", email: `r-${run}@example.test`, timeZone: "UTC" } });
    const orderId = `order_${evId("o")}`;
    razorpay.orders.create.mockResolvedValueOnce({ id: orderId });
    const res = await createPaymentSession(r.manageToken!);
    return { booking: r.booking, token: r.manageToken!, orderId, res };
  }

  it("creates an order and a hosted checkout url on our domain", async () => {
    const { res, orderId, booking } = await rzpBooking();
    expect(res).toMatchObject({ checkoutUrl: expect.stringContaining("/pay/razorpay/") });
    expect((razorpay.orders.create.mock.calls.at(-1)![0] as { amount: number; currency: string }).currency).toBe("INR");
    expect((await payRow(booking.id)).providerOrderId).toBe(orderId);
  });

  it("checkout callback: valid signature confirms, tampered signature is rejected", async () => {
    const { token, orderId, booking } = await rzpBooking();
    await expect(verifyRazorpayCheckout({ manageToken: token, orderId, paymentId: "pay_bad", signature: "0".repeat(64) })).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    expect(await status(booking.id)).toBe("pending_payment");
    const paymentId = `pay_${evId("p")}`;
    await verifyRazorpayCheckout({ manageToken: token, orderId, paymentId, signature: hmac(KEY_SECRET, `${orderId}|${paymentId}`) });
    expect(await status(booking.id)).toBe("confirmed");
  });

  it("webhook endpoint: valid signature processes, replay is a duplicate, invalid signature is 400", async () => {
    const { orderId, booking } = await rzpBooking();
    const amount = 5000; // event price in minor units
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_${evId("w")}`, order_id: orderId, amount, currency: "INR" } } } });
    const mkReq = (sig: string) => new Request("http://localhost/api/webhooks/razorpay", { method: "POST", body, headers: { "x-razorpay-signature": sig, "x-razorpay-event-id": `${run}-rzp-evt-${orderId}` } });

    const bad = await handleWebhookRequest("razorpay", mkReq("00".repeat(32)));
    expect(bad.status).toBe(400);
    expect(await status(booking.id)).toBe("pending_payment");

    const ok = await handleWebhookRequest("razorpay", mkReq(hmac(WH_SECRET, body)));
    expect(ok.status).toBe(200);
    expect((await ok.json()).outcome).toBe("processed");
    expect(await status(booking.id)).toBe("confirmed");

    const replay = await handleWebhookRequest("razorpay", mkReq(hmac(WH_SECRET, body)));
    expect(replay.status).toBe(200);
    expect((await replay.json()).outcome).toBe("duplicate");
    expect(paymentEvents.filter((e) => e.id === booking.id)).toHaveLength(1);
  });

  it("a processing failure returns 500 (provider retries) and the same event is retried successfully", async () => {
    const { orderId, booking } = await rzpBooking();
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_${evId("r")}`, order_id: orderId, amount: 5000, currency: "INR" } } } });
    const req = () => new Request("http://localhost/x", { method: "POST", body, headers: { "x-razorpay-signature": hmac(WH_SECRET, body), "x-razorpay-event-id": `${run}-retry-${orderId}` } });
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db blip"));
    const first = await handleWebhookRequest("razorpay", req());
    spy.mockRestore();
    expect(first.status).toBe(500);
    expect(await status(booking.id)).toBe("pending_payment");
    const second = await handleWebhookRequest("razorpay", req());
    expect(second.status).toBe(200);
    expect(await status(booking.id)).toBe("confirmed");
  });
});

describe("subscriptions", () => {
  it("activates a plan from a verified event and supersedes the previous one (cancelling it at the provider)", async () => {
    const plan = (n: string) => `t_${run}_${n}`;
    for (const n of ["basic", "pro"]) {
      planIds.push(plan(n));
      await db.insert(schema.subscriptionPlans).values({ id: plan(n), name: n, priceMonthly: n === "pro" ? 2000 : 500, currency: "USD", limits: { maxEventTypes: 10 } });
    }
    const sub = (id: string, planId: string): NormalizedEvent => ({
      provider: "stripe", eventId: evId("sub"), rawType: "customer.subscription.created", kind: "subscription_upsert",
      subscription: { providerSubscriptionId: id, userId: host, planId, status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000) },
    });
    await processProviderEvent(sub(`sub_${run}_1`, plan("basic")));
    await processProviderEvent(sub(`sub_${run}_2`, plan("pro")));
    const rows = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, host));
    expect(rows.find((r) => r.providerSubscriptionId === `sub_${run}_1`)?.status).toBe("canceled");
    expect(rows.find((r) => r.providerSubscriptionId === `sub_${run}_2`)).toMatchObject({ status: "active", planId: plan("pro") });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(`sub_${run}_1`, { cancel_at_period_end: true });
    // later cancellation event updates status in place
    await processProviderEvent({ ...sub(`sub_${run}_2`, plan("pro")), subscription: { providerSubscriptionId: `sub_${run}_2`, status: "canceled" } });
    expect((await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.providerSubscriptionId, `sub_${run}_2`)))[0].status).toBe("canceled");
  });

  it("subscription events without a resolvable user/plan are ignored", async () => {
    expect(await processProviderEvent({
      provider: "stripe", eventId: evId("sub"), rawType: "customer.subscription.created", kind: "subscription_upsert",
      subscription: { providerSubscriptionId: `sub_${run}_x`, status: "active" },
    })).toBe("ignored");
  });
});

