import { describe, expect, it } from "vitest";
import { buildChatBody, detectChatTarget } from "./chat";

const payload = { type: "booking.created", data: { booking: {
  start_time: "2030-03-05T14:00:00.000Z", meeting_url: "https://meet.google.com/abc", event_type: { title: "Intro <b>call</b>" },
  host: { name: "Hana" }, invitee: { name: "Ivo & Co", email: "ivo@example.com" },
} } };

describe("chat webhooks", () => {
  it("recognises Slack and Teams webhook URLs only", () => {
    expect(detectChatTarget("https://hooks.slack.com/services/T0/B0/xyz")).toBe("slack");
    expect(detectChatTarget("https://contoso.webhook.office.com/webhookb2/abc")).toBe("teams");
    expect(detectChatTarget("https://prod-12.westus.logic.azure.com:443/workflows/abc")).toBe("teams");
    expect(detectChatTarget("http://hooks.slack.com/services/x")).toBeNull();
    expect(detectChatTarget("https://hooks.slack.com.evil.io/services/x")).toBeNull();
    expect(detectChatTarget("https://example.com/hook")).toBeNull();
    expect(detectChatTarget("not a url")).toBeNull();
  });
  it("builds a Slack message with escaped text", () => {
    const t = (JSON.parse(buildChatBody("slack", "booking.created", payload)) as { text: string }).text;
    expect(t).toContain("*New booking: Intro &lt;b&gt;call&lt;/b&gt;*");
    expect(t).toContain("With: Ivo &amp; Co (ivo@example.com)");
    expect(t).toContain("When: Tue, 05 Mar 2030 14:00:00 UTC");
    expect(t).toContain("Link: https://meet.google.com/abc");
  });
  it("builds a Teams adaptive card", () => {
    const m = JSON.parse(buildChatBody("teams", "booking.cancelled", { data: { booking: { event_type: { title: "X" }, cancel_reason: "Sick" } } }));
    expect(m.type).toBe("message");
    expect(m.attachments[0].content.type).toBe("AdaptiveCard");
    expect(m.attachments[0].content.body[0].text).toBe("Booking cancelled: X");
    expect(m.attachments[0].content.body[1].text).toBe("Reason: Sick");
  });
});
