import { describe, expect, it } from "vitest";
import { WORKFLOW_SAMPLES, samplesForTrigger } from "./workflow-samples";
import { TEMPLATE_VARIABLES } from "@/app/(app)/dashboard/workflows/labels";
import { workflowStepSchema } from "@/server/workflows/service";
import { WORKFLOW_TRIGGERS } from "@/server/webhooks/events";
import { renderNotification } from "@/server/notifications/templates";
import type { BookingContext } from "@/server/notifications/types";

const ctx: BookingContext = {
  booking: { id: "b1", status: "confirmed", startsAt: new Date("2030-01-15T15:00:00Z"), endsAt: new Date("2030-01-15T15:30:00Z"),
    inviteeTimeZone: "Asia/Kolkata", hostTimeZone: "UTC", meetingUrl: "https://meet.example.com/abc", locationType: "google_meet", cancelReason: "Host unavailable", cancelledBy: "host" },
  eventType: { id: "e1", title: "Intro call", description: null, locationValue: null, cancellationPolicy: null, priceAmount: null, priceCurrency: null },
  host: { id: "h", name: "Harper Host", email: "host@example.com" },
  invitee: { name: "Ian Invitee", email: "ian@example.com" },
};

describe("workflow sample messages", () => {
  it("every sample is valid input for a workflow step", () => {
    for (const s of WORKFLOW_SAMPLES) {
      const r = workflowStepSchema.safeParse({ action: "send_email", offsetMinutes: s.offsetMinutes, to: s.to, subject: s.subject, body: s.body, attachIcs: s.attachIcs });
      expect(r.success, s.id).toBe(true);
    }
  });
  it("ids are unique and every trigger has at least one sample", () => {
    expect(new Set(WORKFLOW_SAMPLES.map((s) => s.id)).size).toBe(WORKFLOW_SAMPLES.length);
    for (const t of WORKFLOW_TRIGGERS) expect(samplesForTrigger(t).length, t).toBeGreaterThan(0);
  });
  it("only use variables the email renderer provides", () => {
    for (const s of WORKFLOW_SAMPLES) {
      for (const m of `${s.subject} ${s.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) expect(TEMPLATE_VARIABLES as readonly string[], `${s.id}: ${m[1]}`).toContain(m[1]);
    }
  });
  it("render with real values and no leftover placeholders", () => {
    for (const s of WORKFLOW_SAMPLES) {
      const m = renderNotification("workflow", ctx, "invitee", { subject: s.subject, body: s.body, attachIcs: s.attachIcs });
      expect(m.text, s.id).not.toMatch(/\{\{/);
      expect(m.subject, s.id).not.toMatch(/\{\{/);
      expect(m.text, s.id).toContain("Ian Invitee");
    }
  });
  it("sample timing matches its purpose: reminders are before the meeting, follow-ups after", () => {
    expect(WORKFLOW_SAMPLES.find((s) => s.id === "reminder-24h")!.offsetMinutes).toBe(-1440);
    expect(WORKFLOW_SAMPLES.find((s) => s.id === "reminder-1h")!.offsetMinutes).toBe(-60);
    expect(WORKFLOW_SAMPLES.find((s) => s.id === "follow-up")!.offsetMinutes).toBeGreaterThan(0);
  });
});

describe("workflow email attachment", () => {
  const send = (role: "invitee" | "host", c: BookingContext, attachIcs?: boolean) => renderNotification("workflow", c, role, { subject: "Hi {{invitee_name}}", body: "Body", attachIcs });

  it("attaches the meeting invite for the invitee when enabled", () => {
    const m = send("invitee", ctx, true);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0]!.filename).toBe("invite.ics");
    expect(m.attachments![0]!.content).toContain("METHOD:REQUEST");
    expect(m.attachments![0]!.content).toContain("DTSTART:20300115T150000Z");
  });
  it("attaches a cancellation invite for a cancelled booking (removes the event from their calendar)", () => {
    const m = send("invitee", { ...ctx, booking: { ...ctx.booking, status: "cancelled" } }, true);
    expect(m.attachments![0]!.content).toContain("METHOD:CANCEL");
    expect(m.attachments![0]!.content).toContain("STATUS:CANCELLED");
  });
  it("attaches nothing when disabled, and never to the host", () => {
    expect(send("invitee", ctx, false).attachments).toBeUndefined();
    expect(send("invitee", ctx).attachments).toBeUndefined();
    expect(send("host", ctx, true).attachments).toBeUndefined();
  });
});
