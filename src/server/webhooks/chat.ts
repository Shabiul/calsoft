/**
 * Slack and Microsoft Teams incoming webhooks. Add one as an ordinary webhook endpoint: when its URL is a Slack or Teams
 * webhook, deliveries are sent as a chat message instead of signed JSON (those services reject unknown JSON shapes).
 */
export type ChatTarget = "slack" | "teams";

export function detectChatTarget(rawUrl: string): ChatTarget | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "hooks.slack.com") return "slack";
  if (h.endsWith(".webhook.office.com") || h === "outlook.office.com" || h.endsWith(".logic.azure.com") || h.endsWith(".powerplatform.com") || h.endsWith(".api.powerplatform.com")) return "teams";
  return null;
}

interface Payload { type?: string; data?: { booking?: {
  status?: string; start_time?: string; end_time?: string; meeting_url?: string | null; cancel_reason?: string | null;
  event_type?: { title?: string }; host?: { name?: string }; invitee?: { name?: string; email?: string };
} } }

const TITLES: Record<string, string> = {
  "booking.created": "New booking", "booking.cancelled": "Booking cancelled", "booking.rescheduled": "Booking rescheduled",
  "booking.confirmed": "Booking confirmed", "booking.declined": "Booking declined", "booking.completed": "Meeting completed", "booking.no_show": "No-show",
};

/** Plain-text summary lines for a booking event (names are untrusted text; the chat services render them as text). */
export function describeBookingEvent(event: string, payload: unknown): { title: string; lines: string[] } {
  const p = (payload ?? {}) as Payload;
  const b = p.data?.booking ?? {};
  const title = `${TITLES[event] ?? event}: ${b.event_type?.title ?? "meeting"}`;
  const when = b.start_time ? new Date(b.start_time).toUTCString().replace(" GMT", " UTC") : null;
  const lines = [
    b.invitee?.name ? `With: ${b.invitee.name}${b.invitee.email ? ` (${b.invitee.email})` : ""}` : "",
    b.host?.name ? `Host: ${b.host.name}` : "",
    when ? `When: ${when}` : "",
    b.cancel_reason ? `Reason: ${b.cancel_reason}` : "",
    b.meeting_url ? `Link: ${b.meeting_url}` : "",
  ].filter(Boolean);
  return { title, lines };
}

const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildChatBody(target: ChatTarget, event: string, payload: unknown): string {
  const { title, lines } = describeBookingEvent(event, payload);
  if (target === "slack") return JSON.stringify({ text: [`*${slackEscape(title)}*`, ...lines.map(slackEscape)].join("\n") });
  return JSON.stringify({
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
        body: [{ type: "TextBlock", weight: "Bolder", size: "Medium", wrap: true, text: title }, ...lines.map((text) => ({ type: "TextBlock", wrap: true, spacing: "None", text }))],
      },
    }],
  });
}
