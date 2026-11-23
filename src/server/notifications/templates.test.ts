import { describe, expect, it } from "vitest";
import { escapeHtml, renderString, safeUrl } from "./escape";
import { fold, generateIcs } from "./ics";
import { renderNotification } from "./templates";
import { planReminders } from "./reminders";
import type { BookingContext } from "./types";

const ctx: BookingContext = {
  booking: { id: "b1", status: "confirmed", startsAt: new Date("2030-01-15T15:00:00Z"), endsAt: new Date("2030-01-15T15:30:00Z"),
    inviteeTimeZone: "America/New_York", hostTimeZone: "Asia/Kolkata", meetingUrl: "https://meet.example.com/x", locationType: "google_meet", cancelReason: "<b>sick</b>", cancelledBy: "host" },
  eventType: { id: "e1", title: "Intro <script>alert(1)</script>", description: "d", locationValue: null, cancellationPolicy: null, priceAmount: 5000, priceCurrency: "USD" },
  host: { id: "h", name: "Host \"H\"", email: "host@example.com" },
  invitee: { name: "Eve <img src=x onerror=alert(1)>", email: "eve@example.com" },
  payment: { amount: 5000, currency: "USD", status: "paid" },
};

describe("escaping", () => {
  it("escapes html", () => expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;"));
  it("safeUrl only allows http(s)", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("https://a.com/x")).toBe("https://a.com/x");
  });
  it("renderString escapes values and template in html mode", () => {
    expect(renderString("Hi {{name}} <i>", { name: "<b>x</b>" }, true)).toBe("Hi &lt;b&gt;x&lt;/b&gt; &lt;i&gt;");
    expect(renderString("Hi {{name}}\n{{missing}}!", { name: "A" })).toBe("Hi A\n!");
  });
});
describe("templates", () => {
  const kinds = ["confirmation", "host_notification", "cancellation", "reschedule", "reminder", "follow_up", "payment_confirmation", "payment_failed", "request_received", "approval_request", "approved", "declined"] as const;
  it.each(kinds)("%s renders with no unescaped user markup", (k) => {
    const out = renderNotification(k, ctx, k === "host_notification" || k === "approval_request" ? "host" : "invitee", { manageToken: "tok123", minutesBefore: 60, previousStartsAt: "2030-01-14T15:00:00Z" });
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).not.toContain("<b>sick</b>");
    expect(out.subject.length).toBeGreaterThan(3);
    expect(out.text.length).toBeGreaterThan(10);
  });
  it("approval emails: request, approval request (dashboard link for host), approved (ICS), declined (reason, no ICS)", () => {
    const pend = { ...ctx, booking: { ...ctx.booking, status: "pending_confirmation" } };
    expect(renderNotification("request_received", pend, "invitee", { manageToken: "tok123" }).subject).toMatch(/^Request sent:/);
    const ar = renderNotification("approval_request", pend, "host");
    expect(ar.subject).toMatch(/^Approval needed:/);
    expect(ar.text).toContain("/dashboard/scheduled?b=b1");
    expect(renderNotification("approved", ctx, "invitee").attachments?.[0].content).toContain("METHOD:REQUEST");
    const dec = renderNotification("declined", ctx, "invitee");
    expect(dec.attachments).toBeUndefined();
    expect(dec.text).toContain("Reason:");
  });
  it("lists every session of a recurring series in the recipient's time zone", () => {
    const series = [0, 1, 2].map((i) => ({ startsAt: new Date(Date.UTC(2030, 0, 15 + 7 * i, 15)), endsAt: new Date(Date.UTC(2030, 0, 15 + 7 * i, 15, 30)), status: "confirmed" }));
    const out = renderNotification("confirmation", { ...ctx, series }, "invitee");
    expect(out.text).toContain("recurring series of 3 sessions");
    expect(out.text).toContain("1. Tuesday, January 15, 2030 at 10:00 AM");
    expect(out.text).toContain("3. Tuesday, January 29, 2030 at 10:00 AM");
    expect(renderNotification("reminder", { ...ctx, series }, "invitee").text).not.toContain("recurring series");
  });
  it("attaches ICS to invitee confirmation/reschedule and CANCEL to cancellation, but not to the host (they already have the event; avoids Gmail \"Unable to load event\")", () => {
    expect(renderNotification("confirmation", ctx, "invitee").attachments?.[0].content).toContain("METHOD:REQUEST");
    expect(renderNotification("host_notification", ctx, "host").attachments).toBeUndefined();
    expect(renderNotification("reschedule", ctx, "invitee").attachments).toHaveLength(1);
    const c = renderNotification("cancellation", ctx, "invitee").attachments?.[0].content;
    expect(c).toContain("METHOD:CANCEL");
    expect(c).toContain("STATUS:CANCELLED");
    expect(renderNotification("reminder", ctx, "invitee").attachments).toBeUndefined();
  });
  it("renders time in the recipient's zone", () => {
    expect(renderNotification("confirmation", ctx, "invitee").text).toContain("10:00 AM");
    expect(renderNotification("host_notification", ctx, "host").text).toContain("8:30 PM");
  });
  it("manage link is included only with a token", () => {
    expect(renderNotification("confirmation", ctx, "invitee", { manageToken: "abc" }).html).toContain("/booking/abc");
    expect(renderNotification("confirmation", ctx, "invitee").html).not.toContain("/booking/");
  });
  it("workflow template escapes body and strips header injection from subject", () => {
    const o = renderNotification("workflow", ctx, "invitee", { subject: "Hi {{invitee_name}}\r\nBcc: x@y.z", body: "<script>1</script> {{event_title}}" });
    expect(o.subject).not.toMatch(/[\r\n]/);
    expect(o.html).not.toContain("<script>1");
  });
});
describe("ics", () => {
  it("folds long lines at 75 octets and escapes text", () => {
    const f = fold("DESCRIPTION:" + "x".repeat(200));
    for (const l of f.split("\r\n")) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    const ics = generateIcs({ uid: "u", startsAt: new Date("2030-01-01T00:00:00Z"), endsAt: new Date("2030-01-01T01:00:00Z"), summary: "a,b;c\nd" });
    expect(ics).toContain("SUMMARY:a\\,b\\;c\\nd");
    expect(ics).toContain("DTSTART:20300101T000000Z");
  });
});
describe("planReminders", () => {
  const now = new Date("2030-01-01T00:00:00Z");
  it("computes send times, skips past ones, dedupes and sorts", () => {
    const start = new Date("2030-01-01T02:00:00Z");
    const p = planReminders(start, [60, 1440, 60, 10, -5, 0, 1.5], now);
    expect(p.map((r) => r.minutesBefore)).toEqual([60, 10]);
    expect(p[0].sendAt.toISOString()).toBe("2030-01-01T01:00:00.000Z");
  });
  it("returns nothing for a booking starting immediately", () => expect(planReminders(now, [60], now)).toEqual([]));
});

describe("booking page branding", () => {
  const branded: BookingContext = { ...ctx, branding: { brandColor: "#6366f1", logoUrl: "https://cdn.example.com/logo.png", headline: null, successMessage: "See you <soon>!" } };
  it("applies brand colour, logo and the confirmation message to the invitee confirmation", () => {
    const m = renderNotification("confirmation", branded, "invitee");
    expect(m.html).toContain("#6366f1");
    expect(m.html).toContain('src="https://cdn.example.com/logo.png"');
    expect(m.html).toContain("See you &lt;soon&gt;!");
    expect(m.text).toContain("See you <soon>!");
  });
  it("does not show the confirmation message to the host or in other emails", () => {
    expect(renderNotification("host_notification", branded, "host").html).not.toContain("See you");
    expect(renderNotification("reminder", branded, "invitee", { minutesBefore: 60 }).html).not.toContain("See you");
  });
  it("ignores invalid colours and non-https logos", () => {
    const bad = { ...ctx, branding: { brandColor: "red;x", logoUrl: "javascript:alert(1)", headline: null, successMessage: null } };
    const m = renderNotification("confirmation", bad, "invitee");
    expect(m.html).toContain("#4f46e5");
    expect(m.html).not.toContain("javascript:");
    expect(m.html).toContain("/email-logo.png"); // falls back to the app mark
  });
});

describe("host notification layout", () => {
  it("shows a clickable meeting link and Join button but no manage link", () => {
    const m = renderNotification("host_notification", ctx, "host");
    expect(m.html).toContain('href="https://meet.example.com/x"');
    expect(m.html).toContain("Join meeting");
    expect(m.html).not.toContain("Manage booking");
    expect(m.text).toContain("https://meet.example.com/x");
  });
});

describe("event details", () => {
  const full: BookingContext = {
    ...ctx,
    eventType: { ...ctx.eventType, durationMinutes: 90, description: "Agenda line" },
    attendees: [{ name: "Eve", email: "eve@example.com" }, { name: "Guest", email: "guest@example.com" }],
    answers: [{ question: "Topic", answer: "Roadmap" }],
  };
  it("shows duration, host, every attendee and the description to the invitee", () => {
    const m = renderNotification("confirmation", full, "invitee");
    expect(m.text).toContain("Duration: 1 hour 30 minutes");
    expect(m.text).toContain("Host:");
    expect(m.text).toContain("guest@example.com");
    expect(m.text).toContain("Agenda line");
    expect(m.text).not.toContain("Roadmap");
  });
  it("also shows the invitee's answers to the host", () => {
    const m = renderNotification("host_notification", full, "host");
    expect(m.text).toContain("Topic: Roadmap");
    expect(m.text).toContain("eve@example.com");
  });
});

describe("email format", () => {
  const withPeople: BookingContext = { ...ctx, attendees: [{ name: "Eve", email: "eve@example.com" }, { name: "Guest", email: "guest@example.com" }] };
  it("labels the event row Agenda and shows people without angle brackets", () => {
    const m = renderNotification("confirmation", withPeople, "invitee");
    expect(m.text).toContain("Agenda:");
    expect(m.text).not.toContain("What:");
    expect(m.text).not.toMatch(/<[^>\s]+@/);
    expect(m.html).not.toContain("&lt;eve@example.com&gt;");
    expect(m.html).toContain('href="mailto:eve@example.com"');
  });
  it("gives invitees and attendees an Accept button that opens Google Calendar with the Meet link", () => {
    for (const kind of ["confirmation", "approved", "reschedule"] as const) {
      const m = renderNotification(kind, ctx, "invitee");
      expect(m.html).toContain("Accept &amp; add to calendar");
      expect(m.html).toContain("https://calendar.google.com/calendar/render?action=TEMPLATE");
      const href = /href="(https:\/\/calendar\.google\.com[^"]+)"/.exec(m.html)![1].replace(/&amp;/g, "&");
      expect(new URL(href).searchParams.get("location")).toBe("https://meet.example.com/x");
      expect(m.html).toContain("outlook.live.com");
    }
  });
  it("does not show Accept to the host, or in cancellation/reminder emails", () => {
    expect(renderNotification("host_notification", ctx, "host").html).not.toContain("Accept");
    expect(renderNotification("cancellation", ctx, "invitee").html).not.toContain("Accept");
    expect(renderNotification("reminder", ctx, "invitee", { minutesBefore: 60 }).html).not.toContain("Accept");
  });
  it("falls back to a text wordmark when the logo URL is not a direct image", () => {
    const page = { ...ctx, branding: { brandColor: null, logoUrl: "https://in.pinterest.com/pin/123/", headline: null, successMessage: null } };
    const m = renderNotification("confirmation", page, "invitee");
    expect(m.html).not.toContain("pinterest");
    expect(m.html).toContain("/email-logo.png");
    expect(m.html).toContain("MeetFlow");
  });
});
