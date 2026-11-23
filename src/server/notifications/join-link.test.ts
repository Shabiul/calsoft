import { describe, expect, it } from "vitest";
import { renderNotification } from "./templates";
import type { BookingContext } from "./types";

const REAL = "https://meet.google.com/abc-defg-hij";
const MASKED = "https://calendly.example.com/j/3f9a1c2b7d";
const ctx: BookingContext = {
  booking: { id: "b1", status: "confirmed", startsAt: new Date("2030-01-15T15:00:00Z"), endsAt: new Date("2030-01-15T15:30:00Z"),
    inviteeTimeZone: "UTC", hostTimeZone: "UTC", meetingUrl: REAL, joinUrl: MASKED, locationType: "google_meet", cancelReason: null, cancelledBy: null },
  eventType: { id: "e", title: "Architecture", description: "Review", locationValue: null, cancellationPolicy: null, priceAmount: null, priceCurrency: null },
  host: { id: "h", name: "Host", email: "h@example.com" }, invitee: { name: "Jane", email: "j@example.com" },
};

describe("masked join link", () => {
  const m = renderNotification("confirmation", ctx, "invitee", { manageToken: "tok" });
  const accept = /href="(https:\/\/calendar\.google\.com[^"]+)"/.exec(m.html)?.[1].replace(/&amp;/g, "&") ?? "";

  it("emails display the masked link, not the real one", () => {
    expect(m.html).toContain(MASKED);
    const visible = m.html.replace(/href="[^"]*"/g, ""); // the real URL may only live inside the calendar links
    expect(visible).not.toContain(REAL);
  });

  it("Accept adds the event to the calendar with the real Meet link", () => {
    const p = new URL(accept).searchParams;
    expect(p.get("location")).toBe(REAL);
    expect(p.get("details")).toContain(`Join the meeting: ${REAL}`);
  });

  it("the attached .ics invite carries the real Meet link", () => {
    const ics = m.attachments?.[0].content ?? "";
    expect(ics.replace(/\r\n /g, "")).toContain(`LOCATION:${REAL}`);
  });
});
