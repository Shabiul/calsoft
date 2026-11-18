/**
 * Payment state machine (pure). Statuses mirror the `payment_status` enum.
 *
 *   requires_payment -> pending (provider session created) | paid | failed
 *   pending          -> pending (new session) | paid | failed
 *   failed           -> pending (retry) | paid (late success)
 *   paid             -> partially_refunded | refunded
 *   partially_refunded -> partially_refunded | refunded
 *   refunded         (terminal)
 *
 * Out-of-order / duplicate provider events are NOT errors: `applyPaymentEvent` returns the same status
 * (`changed: false`) so callers stay idempotent. Genuinely impossible moves (e.g. refund of an unpaid payment) throw.
 */
export type PaymentStatus = "requires_payment" | "pending" | "paid" | "failed" | "refunded" | "partially_refunded";

export type PaymentEvent =
  | { type: "session_created" }
  | { type: "paid" }
  | { type: "failed" }
  | { type: "refund"; refundedTotal: number; amount: number };

export class InvalidPaymentTransition extends Error {
  constructor(readonly from: PaymentStatus, readonly event: string) {
    super(`Invalid payment transition: ${from} --${event}-->`);
    this.name = "InvalidPaymentTransition";
  }
}

export interface Transition { status: PaymentStatus; changed: boolean }

export function applyPaymentEvent(from: PaymentStatus, ev: PaymentEvent): Transition {
  const same: Transition = { status: from, changed: false };
  const to = (status: PaymentStatus): Transition => ({ status, changed: status !== from });
  switch (ev.type) {
    case "session_created":
      if (from === "requires_payment" || from === "pending" || from === "failed") return to("pending");
      return same; // already paid/refunded: a stray session must not regress the state
    case "paid":
      if (from === "paid" || from === "refunded" || from === "partially_refunded") return same; // duplicate / replay
      return to("paid");
    case "failed":
      if (from === "requires_payment" || from === "pending") return to("failed");
      return same; // failure of an older attempt arriving after success / duplicate failure
    case "refund": {
      if (from === "requires_payment" || from === "pending" || from === "failed") throw new InvalidPaymentTransition(from, "refund");
      if (ev.refundedTotal <= 0) return same;
      return to(ev.refundedTotal >= ev.amount ? "refunded" : "partially_refunded");
    }
  }
}

export const isSettled = (s: PaymentStatus) => s === "paid" || s === "partially_refunded" || s === "refunded";
export const isRefundable = (s: PaymentStatus) => s === "paid" || s === "partially_refunded";
