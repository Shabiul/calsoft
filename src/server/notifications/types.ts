export const NOTIFICATION_KINDS = [
  "confirmation", "host_notification", "cancellation", "reschedule", "reminder", "follow_up",
  "payment_confirmation", "payment_failed", "workflow",
  "request_received", "approval_request", "approved", "declined",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface BookingContext {
  booking: {
    id: string; status: string; startsAt: Date; endsAt: Date; inviteeTimeZone: string; hostTimeZone: string;
    meetingUrl: string | null; locationType: string | null; cancelReason: string | null; cancelledBy: string | null;
    /** Recurring series membership (null for single bookings). */
    seriesId?: string | null;
  };
  eventType: { id: string; title: string; description: string | null; locationValue: string | null; cancellationPolicy: string | null; priceAmount: number | null; priceCurrency: string | null };
  host: { id: string; name: string; email: string };
  invitee: { name: string; email: string };
  payment?: { amount: number; currency: string; status: string } | null;
  /** Recurring series: all live occurrences in time order (host-side rows, shadow rows excluded). */
  series?: { startsAt: Date; endsAt: Date; status: string }[] | null;
}
export interface RenderExtra {
  manageToken?: string;
  minutesBefore?: number;
  previousStartsAt?: string; // ISO
  /** Recurring series: number of occurrences affected (cancellation of a whole series). */
  seriesCount?: number;
  /** Decline reason (host-provided, untrusted; escaped). */
  reason?: string;
  /** workflow-provided content (untrusted; escaped) */
  subject?: string; body?: string;
}
export type Role = "invitee" | "host";
export interface RenderedEmail {
  subject: string; html: string; text: string;
  attachments?: { filename: string; content: string; contentType: string }[];
}
