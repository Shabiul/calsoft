/** Client-safe constants (no server imports). */
export const WEBHOOK_EVENTS = [
  "booking.created", "booking.confirmed", "booking.declined", "booking.cancelled", "booking.rescheduled",
  "booking.completed", "booking.no_show", "booking.expired", "payment.succeeded", "payment.failed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const API_KEY_SCOPES = [
  "bookings:read", "bookings:write", "event_types:read", "event_types:write", "availability:read", "contacts:read", "webhooks:manage",
  "availability:write", "contacts:write", "calendars:read", "organizations:read",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const WORKFLOW_TRIGGERS = ["booking_created", "booking_cancelled", "booking_rescheduled", "booking_completed"] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];
export const WORKFLOW_ACTIONS = ["send_email", "send_webhook"] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];
