import { DateTime } from "luxon";

export function fmtDateTime(iso: string | null, tz: string): string {
  if (!iso) return "—";
  const d = DateTime.fromISO(iso, { zone: tz });
  return d.isValid ? d.toFormat("LLL d, yyyy, h:mm a") : "—";
}
export function fmtDate(iso: string | null, tz: string): string {
  if (!iso) return "—";
  const d = DateTime.fromISO(iso, { zone: tz });
  return d.isValid ? d.toFormat("LLL d, yyyy") : "—";
}
export const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed", pending_payment: "Awaiting payment", pending_confirmation: "Awaiting approval", completed: "Completed", cancelled: "Cancelled",
  rescheduled: "Rescheduled", no_show: "No-show", expired: "Expired",
};
export const STATUS_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "destructive"> = {
  confirmed: "default", pending_payment: "warning", pending_confirmation: "warning", completed: "success", cancelled: "destructive", rescheduled: "secondary", no_show: "warning", expired: "secondary",
};
export const EVENT_LABEL: Record<string, string> = {
  created: "Booked", rescheduled_to: "Rescheduled booking created", rescheduled: "Rescheduled", cancelled: "Cancelled", completed: "Marked completed",
  no_show: "Marked no-show", guests_added: "Guests added", payment_succeeded: "Payment received", reminder_sent: "Reminder sent",
};
