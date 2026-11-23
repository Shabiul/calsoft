import { describe, expect, it } from "vitest";
import { actionItemsText, buildAttendance, buildChat, formatTranscript, notesToken, resolveOwner, verifyNotesToken, type ParticipantEvent } from "./index";
import { renderNotification } from "@/server/notifications/templates";
import type { BookingContext } from "@/server/notifications/types";

process.env.BETTER_AUTH_SECRET = "test-secret";
const id = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";

describe("notetaker", () => {
  it("notes token round-trips and rejects tampering", () => {
    const t = notesToken(id)!;
    expect(verifyNotesToken(t)).toBe(id);
    expect(verifyNotesToken(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(verifyNotesToken(`${id.replace("3", "4")}.${t.split(".")[1]}`)).toBeNull();
    expect(verifyNotesToken("garbage")).toBeNull();
  });

  it("formats a Recall transcript", () => {
    expect(formatTranscript([
      { participant: { name: "Jane" }, words: [{ text: "Hello there.", start_timestamp: { relative: 65.2 } }] },
      { participant: { name: null }, words: [] },
      { participant: {}, words: [{ text: "Hi", start_timestamp: { relative: 3 } }, { text: "all.", start_timestamp: { relative: 3.5 } }] },
    ])).toBe("[01:05] Jane: Hello there.\n[00:03] Speaker: Hi all.");
  });

  it("notes_ready email shows the escaped summary and the notes link", () => {
    const ctx: BookingContext = {
      booking: { id, status: "confirmed", startsAt: new Date("2030-01-15T15:00:00Z"), endsAt: new Date("2030-01-15T15:30:00Z"),
        inviteeTimeZone: "UTC", hostTimeZone: "UTC", meetingUrl: null, locationType: "google_meet", cancelReason: null, cancelledBy: null },
      eventType: { id: "e", title: "Architecture", description: null, locationValue: null, cancellationPolicy: null, priceAmount: null, priceCurrency: null },
      host: { id: "h", name: "Host", email: "h@example.com" }, invitee: { name: "Jane", email: "j@example.com" },
    };
    const m = renderNotification("notes_ready", ctx, "invitee", { summary: "Summary\n<b>x</b>" });
    expect(m.subject).toBe("Meeting notes: Architecture with Host");
    expect(m.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(m.html).toContain(`/notes/${notesToken(id)}`);
    expect(m.text).toContain("Open meeting notes:");
  });
});


describe("notetaker results", () => {
  const ev = (action: string, id: number, name: string, at: string, text?: string): ParticipantEvent =>
    ({ action, participant: { id, name, email: null }, timestamp: { absolute: `2030-01-15T15:${at}Z` }, data: text ? { text, to: "everyone" } : null });
  const events = [
    ev("join", 1, "Jane Doe", "00:00"), ev("join", 2, "Bob", "02:00"), ev("join", 9, "MeetFlow Notetaker", "00:00"),
    ev("chat_message", 2, "Bob", "03:00", "Link: https://x.dev"), ev("leave", 2, "Bob", "10:00"), ev("join", 2, "Bob", "20:00"),
    ev("speech_on", 1, "Jane Doe", "25:00"), ev("leave", 1, "Jane Doe", "30:00"),
  ];

  it("builds attendance: first join, last leave, total time; bot excluded; still present = until the end", () => {
    expect(buildAttendance(events)).toEqual([
      { name: "Jane Doe", email: null, joinedAt: "2030-01-15T15:00:00Z", leftAt: "2030-01-15T15:30:00Z", seconds: 1800 },
      { name: "Bob", email: null, joinedAt: "2030-01-15T15:02:00Z", leftAt: null, seconds: 8 * 60 + 10 * 60 },
    ]);
  });

  it("extracts chat messages", () => {
    expect(buildChat(events)).toEqual([{ name: "Bob", at: "2030-01-15T15:03:00Z", text: "Link: https://x.dev" }]);
  });

  it("matches action item owners to attendee emails", () => {
    const people = [{ name: "Jane Doe", email: "Jane@x.com" }, { name: "Bob Smith", email: "bob@x.com" }, { name: "Bob Lee", email: "lee@x.com" }];
    expect(resolveOwner("anyone", "jane@x.com", people)).toBe("jane@x.com"); // model's email kept when it is an attendee
    expect(resolveOwner("Jane", "evil@y.com", people)).toBe("jane@x.com"); // unknown email ignored; unique first name
    expect(resolveOwner("Bob", "", people)).toBeNull(); // ambiguous first name
    expect(resolveOwner("bob smith", "", people)).toBe("bob@x.com");
  });

  it("renders the action items section and the per-person email", () => {
    expect(actionItemsText([{ owner: "Jane", ownerEmail: null, task: "Draft plan", due: "Friday" }])).toBe("Action items\n- Jane: Draft plan (Friday)");
    expect(actionItemsText([])).toBe("Action items\n- None recorded");
    const ctx = {
      booking: { id, status: "confirmed", startsAt: new Date("2030-01-15T15:00:00Z"), endsAt: new Date("2030-01-15T15:30:00Z"),
        inviteeTimeZone: "UTC", hostTimeZone: "UTC", meetingUrl: null, locationType: "google_meet", cancelReason: null, cancelledBy: null },
      eventType: { id: "e", title: "Architecture", description: null, locationValue: null, cancellationPolicy: null, priceAmount: null, priceCurrency: null },
      host: { id: "h", name: "Host", email: "h@example.com" }, invitee: { name: "Jane", email: "j@example.com" },
    };
    const m = renderNotification("action_items", ctx, "invitee", { actionItems: [{ task: "Ship <it>", due: "Friday" }] });
    expect(m.subject).toBe("Your action items: Architecture");
    expect(m.html).toContain("Ship &lt;it&gt;");
    expect(m.text).toContain("- Ship <it> (Friday)");
  });
});
