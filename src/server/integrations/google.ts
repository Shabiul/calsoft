import { createHash, randomUUID } from "node:crypto";
import { http, ProviderError } from "./http";
import { canReceiveWebhooks } from "./config";
import type { CalendarProvider, ChangeSet, EventInput, EventResult, Interval } from "./types";

const API = "https://www.googleapis.com/calendar/v3";
const cal = (id: string) => `${API}/calendars/${encodeURIComponent(id)}`;

/** Deterministic id => retried creates are idempotent (Google returns 409 on duplicates). a-v0-9 charset. */
export const googleEventId = (bookingId: string, calendarId: string) =>
  createHash("sha256").update(`${bookingId}:${calendarId}`).digest("hex").slice(0, 40);

interface GEvent {
  id: string; status?: string; transparency?: string; hangoutLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

function eventBody(input: EventInput, forCreate: boolean, id?: string) {
  const body: Record<string, unknown> = {
    summary: input.title,
    description: [input.description, input.meetingUrl && `Join: ${input.meetingUrl}`].filter(Boolean).join("\n\n") || undefined,
    location: input.meetingUrl ?? input.location,
    start: { dateTime: input.startsAt.toISOString(), timeZone: "UTC" },
    end: { dateTime: input.endsAt.toISOString(), timeZone: "UTC" },
    attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.name })),
    extendedProperties: { private: { meetflowBookingId: input.bookingId } },
    reminders: { useDefault: true },
  };
  if (id) body.id = id;
  if (forCreate && input.nativeMeeting) {
    body.conferenceData = { createRequest: { requestId: input.bookingId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  }
  return body;
}

const meetUrl = (e: GEvent) => e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
const parseDate = (p?: { dateTime?: string; date?: string }) => p?.dateTime ? new Date(p.dateTime) : p?.date ? new Date(`${p.date}T00:00:00Z`) : null;

function toBusy(e: GEvent): Interval | null {
  if (e.status === "cancelled" || e.transparency === "transparent") return null;
  if (e.extendedProperties?.private?.meetflowBookingId) return null; // our own bookings are blocked via the booking table
  const start = parseDate(e.start), end = parseDate(e.end);
  return start && end && end > start ? { start, end } : null;
}

export const googleProvider: CalendarProvider = {
  name: "google",

  async getCalendars(token) {
    const out: { externalId: string; name: string; primary: boolean; writable: boolean }[] = [];
    let pageToken: string | undefined;
    do {
      const r = await http<{ items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string }[]; nextPageToken?: string }>(
        `${API}/users/me/calendarList?minAccessRole=reader&maxResults=250${pageToken ? `&pageToken=${pageToken}` : ""}`, { token });
      for (const c of r.items ?? []) {
        out.push({ externalId: c.id, name: c.summaryOverride ?? c.summary ?? c.id, primary: !!c.primary, writable: c.accessRole === "owner" || c.accessRole === "writer" });
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  },

  async getBusyIntervals(token, calendarId, from, to) {
    const r = await http<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>(
      `${API}/freeBusy`, { token, json: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] } });
    const c = r.calendars?.[calendarId];
    if (c?.errors?.length) throw new ProviderError(`freeBusy error: ${c.errors[0].reason}`, c.errors[0].reason === "notFound" ? "not_found" : "other");
    return (c?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  },

  async createEvent(token, calendarId, input) {
    const id = googleEventId(input.bookingId, calendarId);
    const qs = "conferenceDataVersion=1&sendUpdates=none";
    try {
      const e = await http<GEvent>(`${cal(calendarId)}/events?${qs}`, { token, json: eventBody(input, true, id) });
      return { id: e.id, meetingUrl: meetUrl(e) };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "conflict") {
        // Already created by a previous attempt: converge by patching it.
        return googleProvider.updateEvent(token, calendarId, id, input);
      }
      throw err;
    }
  },

  async updateEvent(token, calendarId, eventId, input): Promise<EventResult> {
    const e = await http<GEvent>(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`,
      { token, method: "PATCH", json: eventBody(input, false) });
    return { id: e.id, meetingUrl: meetUrl(e) };
  },

  async deleteEvent(token, calendarId, eventId) {
    try {
      await http(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { token, method: "DELETE" });
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "gone")) return;
      throw e;
    }
  },

  async refreshSubscription(token, { calendarId, existing, notificationUrl, secret }) {
    if (!canReceiveWebhooks()) return null;
    // Channels cannot be renewed: create a new one, then stop the old one.
    const channelId = randomUUID();
    const r = await http<{ id: string; resourceId: string; expiration?: string }>(`${cal(calendarId)}/events/watch`, {
      token, json: { id: channelId, type: "web_hook", address: notificationUrl, token: secret, params: { ttl: String(7 * 24 * 3600) } } });
    if (existing) await googleProvider.stopSubscription(token, existing).catch(() => undefined);
    return { id: r.id, resourceId: r.resourceId, expiresAt: r.expiration ? new Date(Number(r.expiration)) : new Date(Date.now() + 6 * 24 * 3600_000) };
  },

  async stopSubscription(token, sub) {
    if (!sub.resourceId) return;
    try {
      await http("https://www.googleapis.com/calendar/v3/channels/stop", { token, json: { id: sub.id, resourceId: sub.resourceId } });
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "gone")) return;
      throw e;
    }
  },

  async listChanges(token, calendarId, { syncToken, from, to }): Promise<ChangeSet> {
    const changes: ChangeSet["changes"] = [];
    let pageToken: string | undefined;
    let next: string | null = null;
    do {
      const p = new URLSearchParams({ maxResults: "250", showDeleted: "true" });
      if (syncToken) p.set("syncToken", syncToken);
      else { p.set("timeMin", from.toISOString()); p.set("timeMax", to.toISOString()); p.set("singleEvents", "true"); }
      if (pageToken) p.set("pageToken", pageToken);
      // A stale syncToken yields 410 Gone: ProviderError(kind gone) propagates; caller resets.
      const r = await http<{ items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }>(`${cal(calendarId)}/events?${p}`, { token });
      for (const e of r.items ?? []) changes.push({ id: e.id, busy: toBusy(e) });
      pageToken = r.nextPageToken;
      if (r.nextSyncToken) next = r.nextSyncToken;
    } while (pageToken);
    return { changes, nextSyncToken: next, reset: !syncToken };
  },
};
