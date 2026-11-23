/**
 * Ready-made workflow email messages. Picking one fills the step's subject, message, timing and attachment option;
 * everything stays editable. Variables ({{...}}) are the ones the email renderer provides (see TEMPLATE_VARIABLES).
 * `trigger` is the workflow trigger the sample belongs to; reminders use "booking_created" with a negative offset (before the meeting).
 */
export interface WorkflowSample {
  id: string; label: string; trigger: "booking_created" | "booking_cancelled" | "booking_rescheduled" | "booking_completed";
  offsetMinutes: number; to: "invitee" | "host" | "both"; subject: string; body: string;
  /** Attach the calendar invite (.ics): the meeting for confirmations/reminders/reschedules, a cancellation for cancelled bookings. */
  attachIcs: boolean;
}

export const WORKFLOW_SAMPLES: WorkflowSample[] = [
  {
    id: "confirmation", label: "Booking confirmation (with calendar invite)", trigger: "booking_created", offsetMinutes: 0, to: "invitee", attachIcs: true,
    subject: "You're booked: {{event_title}} with {{host_name}}",
    body: "Hi {{invitee_name}},\n\nYour meeting is confirmed.\n\nWhat: {{event_title}}\nWhen: {{start_time}} ({{timezone}})\nWhere: {{location}}\n\nJoin here: {{meeting_url}}\n\nThe calendar invite is attached to this email. Open it to add the meeting to your calendar.\n\nNeed to change something? {{manage_url}}\n\nSee you there,\n{{host_name}}",
  },
  {
    id: "reminder-24h", label: "Reminder: 24 hours before", trigger: "booking_created", offsetMinutes: -1440, to: "invitee", attachIcs: true,
    subject: "Tomorrow: {{event_title}} with {{host_name}}",
    body: "Hi {{invitee_name}},\n\nA quick reminder about our meeting tomorrow.\n\nWhen: {{start_time}} ({{timezone}})\nJoin here: {{meeting_url}}\n\nThe calendar invite is attached in case you need it again.\n\nSee you soon,\n{{host_name}}",
  },
  {
    id: "reminder-1h", label: "Reminder: 1 hour before", trigger: "booking_created", offsetMinutes: -60, to: "both", attachIcs: false,
    subject: "Starting soon: {{event_title}}",
    body: "Hi {{invitee_name}},\n\nOur meeting starts in about an hour.\n\nWhen: {{start_time}} ({{timezone}})\nJoin here: {{meeting_url}}\n\n{{host_name}}",
  },
  {
    id: "follow-up", label: "Thank-you after the meeting", trigger: "booking_completed", offsetMinutes: 30, to: "invitee", attachIcs: false,
    subject: "Thanks for meeting, {{invitee_name}}",
    body: "Hi {{invitee_name}},\n\nThank you for taking the time to meet today. If you have questions or want to continue the conversation, just reply to this email.\n\nBest,\n{{host_name}}",
  },
  {
    id: "cancellation", label: "Cancellation notice (with cancellation invite)", trigger: "booking_cancelled", offsetMinutes: 0, to: "invitee", attachIcs: true,
    subject: "Cancelled: {{event_title}} on {{start_time}}",
    body: "Hi {{invitee_name}},\n\nYour meeting {{event_title}} on {{start_time}} ({{timezone}}) has been cancelled.\n\nReason: {{cancel_reason}}\n\nThe attached file removes it from your calendar. You are welcome to book another time whenever it suits you.\n\n{{host_name}}",
  },
  {
    id: "reschedule", label: "Reschedule notice (with updated invite)", trigger: "booking_rescheduled", offsetMinutes: 0, to: "invitee", attachIcs: true,
    subject: "New time: {{event_title}} with {{host_name}}",
    body: "Hi {{invitee_name}},\n\nYour meeting has been moved.\n\nNew time: {{start_time}} ({{timezone}})\nJoin here: {{meeting_url}}\n\nThe updated calendar invite is attached.\n\nSee you then,\n{{host_name}}",
  },
];

export const samplesForTrigger = (trigger: string) => WORKFLOW_SAMPLES.filter((s) => s.trigger === trigger);
