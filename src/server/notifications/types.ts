export const NOTIFICATION_KINDS = [
  "confirmation", "host_notification", "cancellation", "reschedule", "reminder", "follow_up",
  "payment_confirmation", "payment_failed", "workflow",
  "request_received", "approval_request", "approved", "declined", "notes_ready", "action_items",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface BookingContext {
  booking: {
    id: string; status: string; startsAt: Date; endsAt: Date; inviteeTimeZone: string; hostTimeZone: string;
    meetingUrl: string | null; locationType: string | null;
    /** Masked join link shown to people (/j/<code>); meetingUrl stays the raw provider URL. */
    joinUrl?: string | null; cancelReason: string | null; cancelledBy: string | null;
    /** Recurring series membership (null for single bookings). */
    seriesId?: string | null;
  };
  eventType: { id: string; durationMinutes?: number; title: string; description: string | null; locationValue: string | null; cancellationPolicy: string | null; priceAmount: number | null; priceCurrency: string | null };
  host: { id: string; name: string; email: string };
  invitee: { name: string; email: string };
  /** Everyone invited to this booking (primary invitee first, then extra attendees). */
  attendees?: { name: string; email: string }[];
  /** The primary invitee's answers to the booking questions. */
  answers?: { question: string; answer: string }[];
  /** Per-event booking page branding (brand colour, logo, messages). Null/absent = defaults. */
  branding?: { brandColor: string | null; logoUrl: string | null; headline: string | null; successMessage: string | null } | null;
  payment?: { amount: number; currency: string; status: string } | null;
  /** Recurring series: all live occurrences in time order (host-side rows, shadow rows excluded). */
  series?: { startsAt: Date; endsAt: Date; status: string }[] | null;
}
export interface RenderExtra {
  manageToken?: string;
  minutesBefore?: number;
  previousStartsAt?: string; // ISO
  /** notes_ready: AI summary of the meeting (escaped). */
  summary?: string;
  /** action_items: this recipient's tasks from the meeting. */
  actionItems?: { task: string; due: string | null }[];
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
