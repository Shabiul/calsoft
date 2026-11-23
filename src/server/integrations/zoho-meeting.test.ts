import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createZohoMeeting, updateZohoMeeting, deleteZohoMeeting, zohoStartTime, ZOHO_MEETING_SCOPES, _clearZohoOrgCache } from "./zoho-meeting";

type Call = { url: string; method: string; body: any; headers: Record<string, string> };
let calls: Call[] = [];
let responder: (c: Call) => { status?: number; body?: unknown };

beforeEach(() => {
  calls = []; _clearZohoOrgCache(); delete process.env.ZOHO_DC;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const raw = init?.body as string | undefined;
    const c: Call = { url: String(url), method: init?.method ?? "GET", body: raw ? JSON.parse(raw) : undefined, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(c);
    const r = responder(c);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const input = {
  bookingId: "b1", topic: "Intro", startsAt: new Date("2030-01-01T15:05:00Z"), endsAt: new Date("2030-01-01T15:35:00Z"),
  attendeeEmails: ["ann@example.com"],
};
const ok = (c: Call) => c.url.endsWith("/user.json")
  ? { body: { userDetails: { zsoid: 111, zuid: 222 } } }
  : c.method === "POST" ? { status: 201, body: { session: { meetingKey: 999, joinLink: "https://meeting.zoho.com/join?k=1" } } } : { status: 204 };

describe("zoho meeting", () => {
  it("formats start time", () => {
    expect(zohoStartTime(new Date("2030-01-01T15:05:00Z"))).toBe("Jan 01, 2030 03:05 PM");
    expect(zohoStartTime(new Date("2030-06-09T00:00:00Z"))).toBe("Jun 09, 2030 12:00 AM");
    expect(zohoStartTime(new Date("2030-06-09T12:30:00Z"))).toBe("Jun 09, 2030 12:30 PM");
  });

  it("declares scopes", () => {
    expect(ZOHO_MEETING_SCOPES).toContain("ZohoMeeting.meeting.CREATE");
    expect(ZOHO_MEETING_SCOPES).toContain("ZohoMeeting.manageOrg.READ");
  });

  it("discovers zsoid once and creates a meeting", async () => {
    responder = ok;
    const m = await createZohoMeeting("tok", input);
    expect(m).toEqual({ id: "999", joinUrl: "https://meeting.zoho.com/join?k=1" });
    expect(calls[0].url).toBe("https://meeting.zoho.com/api/v2/user.json");
    expect(calls[0].headers.Authorization).toBe("Zoho-oauthtoken tok");
    expect(calls[1].url).toBe("https://meeting.zoho.com/api/v2/111/sessions.json");
    expect(calls[1].body.session).toMatchObject({
      topic: "Intro", presenter: 222, startTime: "Jan 01, 2030 03:05 PM", duration: 1_800_000, timezone: "UTC",
      participants: [{ email: "ann@example.com" }],
    });
    await createZohoMeeting("tok", input);
    expect(calls.filter((c) => c.url.endsWith("/user.json"))).toHaveLength(1);
  });

  it("honours ZOHO_DC", async () => {
    process.env.ZOHO_DC = "in";
    responder = ok;
    await createZohoMeeting("tok-in", input);
    expect(calls[0].url).toBe("https://meeting.zoho.in/api/v2/user.json");
  });

  it("updates with PUT", async () => {
    responder = ok;
    await updateZohoMeeting("tok", "999", input);
    const c = calls[1];
    expect(c.method).toBe("PUT");
    expect(c.url).toBe("https://meeting.zoho.com/api/v2/111/sessions/999.json");
  });

  it("update surfaces not_found", async () => {
    responder = (c) => c.url.endsWith("user.json") ? ok(c) : { status: 404, body: { message: "gone" } };
    await expect(updateZohoMeeting("tok", "1", input)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("deletes, treating 404 as success", async () => {
    responder = ok;
    await deleteZohoMeeting("tok", "999");
    expect(calls[1].method).toBe("DELETE");
    responder = (c) => c.url.endsWith("user.json") ? ok(c) : { status: 404 };
    await expect(deleteZohoMeeting("tok", "999")).resolves.toBeUndefined();
  });

  it("classifies errors", async () => {
    responder = () => ({ status: 401, body: { message: "INVALID_OAUTHTOKEN" } });
    await expect(createZohoMeeting("bad", input)).rejects.toMatchObject({ kind: "auth" });
    responder = () => ({ status: 429 });
    await expect(createZohoMeeting("rl", input)).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
    responder = () => ({ status: 503 });
    await expect(createZohoMeeting("tr", input)).rejects.toMatchObject({ kind: "transient" });
  });

  it("fails clearly on missing org id or malformed create response", async () => {
    responder = () => ({ body: { userDetails: {} } });
    await expect(createZohoMeeting("x", input)).rejects.toBeInstanceOf(Error);
    responder = (c) => c.url.endsWith("user.json") ? ok(c) : { status: 201, body: {} };
    await expect(createZohoMeeting("y", input)).rejects.toThrow(/unexpected create response/);
  });
});
