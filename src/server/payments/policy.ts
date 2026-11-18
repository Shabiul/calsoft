/**
 * Refund policy on cancellation (pure).
 * The event's `cancellationPolicy` is free text for humans; the machine-readable inputs are `minCancelNoticeMinutes`
 * (the booking service already forbids invitee cancellations inside that window) and who cancelled:
 *  - host / system cancellations always refund everything still refundable,
 *  - invitee cancellations refund in full when made at least `minCancelNoticeMinutes` before the start, otherwise nothing.
 */
export interface RefundPolicyInput {
  /** Original payment amount (minor units). */
  amount: number;
  /** Already refunded (incl. in-flight) amount. */
  refunded: number;
  startsAt: Date;
  cancelledAt: Date;
  cancelledBy: string | null;
  minCancelNoticeMinutes: number;
}

export function computeRefundAmount(i: RefundPolicyInput): number {
  const remaining = Math.max(0, i.amount - i.refunded);
  if (remaining === 0) return 0;
  if (i.cancelledBy !== "invitee") return remaining;
  const noticeMin = (i.startsAt.getTime() - i.cancelledAt.getTime()) / 60_000;
  return noticeMin >= i.minCancelNoticeMinutes ? remaining : 0;
}
