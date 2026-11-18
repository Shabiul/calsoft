import { describe, it, expect } from "vitest";
import { generateIcs, icsEscape, foldLine, googleCalendarUrl, outlookCalendarUrl } from "./ics";
import { bookBodySchema, slotsQuerySchema, validateAnswers, rescheduleBodySchema } from "./schemas";

describe("ics", () => {
  const base = { uid: "abc@meetflow", title: "Intro; call, ok", startsAt: "2030-01-02T10:00:00.000Z", endsAt: "2030-01-02T10:30:00Z", now: new Date("2030-01-01T00:00:00Z") };
  it("generates a valid CRLF calendar with UTC times", () => {
    const s = generateIcs({ ...base, description: "Line1\nLine2", location: "Room, 5" });
    expect(s.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(s.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(s).toContain("DTSTART:20300102T100000Z");
    expect(s).toContain("DTEND:20300102T103000Z");
    expect(s).toContain("SUMMARY:Intro\\; call\\, ok");
    expect(s).toContain("DESCRIPTION:Line1\\nLine2");
    expect(s).toContain("LOCATION:Room\\, 5");
    expect(s).not.toMatch(/[^\r]\n/);
  });
  it("marks cancellations", () => {
    const s = generateIcs({ ...base, cancelled: true });
    expect(s).toContain("METHOD:CANCEL");
    expect(s).toContain("STATUS:CANCELLED");
  });
  it("cannot be header-injected via names", () => {
    const s = generateIcs({ ...base, organizerName: 'Evil"\r\nATTENDEE:x', title: "t\r\nX-INJECT:1" });
    expect(s.split("\r\n").some((l) => l.startsWith("X-INJECT"))).toBe(false);
    expect(s.split("\r\n").some((l) => l.startsWith("ATTENDEE:x"))).toBe(false);
  });
  it("folds long lines at 75 octets", () => {
    const folded = foldLine("DESCRIPTION:" + "é".repeat(100));
    for (const l of folded.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe("DESCRIPTION:" + "é".repeat(100));
  });
  it("escapes", () => expect(icsEscape("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne"));
  it("builds calendar links", () => {
    expect(googleCalendarUrl(base)).toContain("dates=20300102T100000Z%2F20300102T103000Z");
    expect(outlookCalendarUrl(base)).toContain("startdt=2030-01-02T10%3A00%3A00.000Z");
  });
});

describe("validation", () => {
  const good = {
    eventTypeId: "3f2b8c1e-0b1a-4c3d-8e9f-1a2b3c4d5e6f", startsAt: "2030-01-02T10:00:00Z",
    invitee: { name: " Ann ", email: "ANN@Example.com", timeZone: "Asia/Kolkata" },
    idempotencyKey: "abcdefgh-1234", consent: true as const,
  };
  it("accepts and normalizes a valid booking", () => {
    const r = bookBodySchema.parse(good);
    expect(r.invitee.name).toBe("Ann");
    expect(r.invitee.email).toBe("ann@example.com");
    expect(r.guests).toEqual([]);
  });
  it("rejects bad input", () => {
    expect(bookBodySchema.safeParse({ ...good, invitee: { ...good.invitee, timeZone: "Nope/Zone" } }).success).toBe(false);
    expect(bookBodySchema.safeParse({ ...good, invitee: { ...good.invitee, email: "x" } }).success).toBe(false);
    expect(bookBodySchema.safeParse({ ...good, consent: false }).success).toBe(false);
    expect(bookBodySchema.safeParse({ ...good, startsAt: "tomorrow" }).success).toBe(false);
    expect(bookBodySchema.safeParse({ ...good, guests: Array(11).fill("a@b.co") }).success).toBe(false);
    expect(bookBodySchema.safeParse({ ...good, eventTypeId: "nope" }).success).toBe(false);
  });
  it("validates slot query range", () => {
    const q = { eventTypeId: good.eventTypeId, from: "2030-01-01T00:00:00Z", to: "2030-02-01T00:00:00Z", tz: "UTC" };
    expect(slotsQuerySchema.safeParse(q).success).toBe(true);
    expect(slotsQuerySchema.safeParse({ ...q, to: "2030-06-01T00:00:00Z" }).success).toBe(false);
    expect(slotsQuerySchema.safeParse({ ...q, to: q.from }).success).toBe(false);
  });
  it("validates reschedule body", () => {
    expect(rescheduleBodySchema.safeParse({ startsAt: "2030-01-02T10:00:00Z", timeZone: "UTC" }).success).toBe(true);
    expect(rescheduleBodySchema.safeParse({ startsAt: "x", timeZone: "UTC" }).success).toBe(false);
  });
  const qs = [
    { id: "1", label: "Why", type: "long_text", options: null, required: true },
    { id: "2", label: "Plan", type: "dropdown", options: ["A", "B"], required: false },
    { id: "3", label: "Topics", type: "checkbox", options: ["x", "y"], required: false },
  ];
  it("validates answers", () => {
    expect(validateAnswers(qs, {}).ok).toBe(false);
    expect(validateAnswers(qs, { "1": "hi", "2": "C" }).ok).toBe(false);
    const r = validateAnswers(qs, { "1": "hi", "3": ["x", "y"] });
    expect(r.ok && r.value).toEqual([{ questionId: "1", question: "Why", answer: "hi" }, { questionId: "3", question: "Topics", answer: "x, y" }]);
  });
});
