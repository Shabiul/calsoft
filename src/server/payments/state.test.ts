import { describe, expect, it } from "vitest";
import { applyPaymentEvent, InvalidPaymentTransition, isRefundable, type PaymentStatus } from "./state";
import { computeRefundAmount } from "./policy";

const all: PaymentStatus[] = ["requires_payment", "pending", "paid", "failed", "refunded", "partially_refunded"];

describe("payment state machine", () => {
  it("happy path: requires_payment -> pending -> paid -> partially_refunded -> refunded", () => {
    let s: PaymentStatus = "requires_payment";
    s = applyPaymentEvent(s, { type: "session_created" }).status; expect(s).toBe("pending");
    s = applyPaymentEvent(s, { type: "paid" }).status; expect(s).toBe("paid");
    s = applyPaymentEvent(s, { type: "refund", refundedTotal: 100, amount: 500 }).status; expect(s).toBe("partially_refunded");
    s = applyPaymentEvent(s, { type: "refund", refundedTotal: 500, amount: 500 }).status; expect(s).toBe("refunded");
  });

  it("failed can be retried and can still be paid late", () => {
    expect(applyPaymentEvent("pending", { type: "failed" })).toEqual({ status: "failed", changed: true });
    expect(applyPaymentEvent("failed", { type: "session_created" }).status).toBe("pending");
    expect(applyPaymentEvent("failed", { type: "paid" })).toEqual({ status: "paid", changed: true });
  });

  it("duplicate / out-of-order events are no-ops, never regressions", () => {
    expect(applyPaymentEvent("paid", { type: "paid" })).toEqual({ status: "paid", changed: false });
    expect(applyPaymentEvent("paid", { type: "failed" })).toEqual({ status: "paid", changed: false });
    expect(applyPaymentEvent("failed", { type: "failed" }).changed).toBe(false);
    expect(applyPaymentEvent("refunded", { type: "paid" }).status).toBe("refunded");
    expect(applyPaymentEvent("paid", { type: "session_created" }).status).toBe("paid");
    expect(applyPaymentEvent("refunded", { type: "refund", refundedTotal: 500, amount: 500 }).changed).toBe(false);
  });

  it("refund of an unpaid payment is invalid", () => {
    for (const s of ["requires_payment", "pending", "failed"] as const) {
      expect(() => applyPaymentEvent(s, { type: "refund", refundedTotal: 1, amount: 5 })).toThrow(InvalidPaymentTransition);
    }
  });

  it("never leaves the status set", () => {
    for (const s of all) for (const ev of [{ type: "session_created" }, { type: "paid" }, { type: "failed" }] as const) {
      expect(all).toContain(applyPaymentEvent(s, ev).status);
    }
    expect(all.filter(isRefundable)).toEqual(["paid", "partially_refunded"]);
  });
});

describe("refund policy", () => {
  const base = { amount: 5000, refunded: 0, startsAt: new Date("2030-01-02T10:00:00Z"), cancelledAt: new Date("2030-01-01T10:00:00Z"), minCancelNoticeMinutes: 60 };
  it("host/system cancellation refunds everything remaining", () => {
    expect(computeRefundAmount({ ...base, cancelledBy: "host" })).toBe(5000);
    expect(computeRefundAmount({ ...base, cancelledBy: "system", refunded: 2000, cancelledAt: new Date("2030-01-02T09:59:00Z") })).toBe(3000);
  });
  it("invitee gets a full refund only when cancelling within the allowed notice", () => {
    expect(computeRefundAmount({ ...base, cancelledBy: "invitee" })).toBe(5000);
    expect(computeRefundAmount({ ...base, cancelledBy: "invitee", cancelledAt: new Date("2030-01-02T09:30:00Z") })).toBe(0);
  });
  it("nothing left to refund -> 0", () => {
    expect(computeRefundAmount({ ...base, cancelledBy: "host", refunded: 5000 })).toBe(0);
  });
});
