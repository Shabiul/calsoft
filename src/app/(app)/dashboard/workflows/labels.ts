export const TRIGGER_LABELS: Record<string, string> = {
  booking_created: "When a booking is confirmed",
  booking_cancelled: "When a booking is cancelled",
  booking_rescheduled: "When a booking is rescheduled",
  booking_completed: "When a meeting is completed",
};
export const ACTION_LABELS: Record<string, string> = {
  send_email: "Send email",
  send_webhook: "Send webhook",
};
export const TEMPLATE_VARIABLES = [
  "invitee_name", "invitee_email", "host_name", "event_title", "start_time", "end_time",
  "timezone", "location", "meeting_url", "manage_url", "cancel_reason",
] as const;
