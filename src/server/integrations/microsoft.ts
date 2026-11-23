import { http, ProviderError } from "./http";
import { canReceiveWebhooks } from "./config";
import type { CalendarProvider, ChangeSet, EventInput, EventResult, Interval } from "./types";

const G = "https://graph.microsoft.com/v1.0";
const UTC = { Prefer: 'outlook.timezone="UTC"' };
const cal = (id: string) => `${G}/me/calendars/${encodeURIComponent(id)}`;
/** Outlook event subscriptions live at most ~4230 minutes; renew well before. */
const SUB_MINUTES = 4200;

interface GEvent {
  id: string; showAs?: string; isCancelled?: boolean; isAllDay?: boolean; categories?: string[];
  responseStatus?: { response?: string };
  start?: { dateTime: string }; end?: { dateTime: string };
  onlineMeeting?: { joinUrl?: string } | null; onlineMeetingUrl?: string | null;
  "@removed"?: unknown;
}
interface Page<T> { value?: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }

const parseUtc = (s?: string) => (s ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) : null);
const graphDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "").replace("Z", "");
const OWN_CATEGORY = "MeetFlow";

function toBusy(e: GEvent): Interval | null {
  if (e["@removed"] || e.isCancelled) return null;
  if (e.showAs === "free" || e.showAs === "workingElsewhere") return null; // tentative / busy / oof block; free and "working elsewhere" do not
  if (e.responseStatus?.response === "declined") return null; // an invite the host declined does not block time
  if (e.categories?.includes(OWN_CATEGORY)) return null;
  const start = parseUtc(e.start?.dateTime), end = parseUtc(e.end?.dateTime);
  if (!start || !end || end <= start) return null;
  // All-day events are dates (Graph returns them as midnight-to-midnight in the requested zone): resolved to the host's local days later.
  if (e.isAllDay) {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return { start, end, allDay: { startDate: day(start), endDate: day(end) } };
  }
  return { start, end };
}

function eventBody(input: EventInput) {
  const lines = [input.description, input.meetingUrl && `Join: ${input.meetingUrl}`].filter(Boolean).join("\n\n");
  const body: Record<string, unknown> = {
    subject: input.title,
    body: { contentType: "text", content: lines },
    start: { dateTime: graphDate(input.startsAt), timeZone: "UTC" },
    end: { dateTime: graphDate(input.endsAt), timeZone: "UTC" },
    attendees: input.attendees.map((a) => ({ type: "required", emailAddress: { address: a.email, name: a.name } })),
    categories: [OWN_CATEGORY],
    transactionId: input.bookingId,
  };
  const loc = input.meetingUrl ?? input.location;
  if (loc) body.location = { displayName: loc };
  if (input.nativeMeeting) { body.isOnlineMeeting = true; body.onlineMeetingProvider = "teamsForBusiness"; }
  return body;
}

const joinUrl = (e: GEvent) => e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? undefined;

export const microsoftProvider: CalendarProvider = {
  name: "microsoft",

  async getCalendars(token) {
    const out: { externalId: string; name: string; primary: boolean; writable: boolean }[] = [];
    let url: string | undefined = `${G}/me/calendars?$top=100`;
    while (url) {
      const r: Page<{ id: string; name: string; isDefaultCalendar?: boolean; canEdit?: boolean }> = await http(url, { token });
      for (const c of r.value ?? []) out.push({ externalId: c.id, name: c.name, primary: !!c.isDefaultCalendar, writable: c.canEdit !== false });
      url = r["@odata.nextLink"];
    }
    return out;
  },

  async getBusyIntervals(token, calendarId, from, to) {
    const out: Interval[] = [];
    let url: string | undefined = `${cal(calendarId)}/calendarView?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}&$select=id,showAs,isCancelled,isAllDay,responseStatus,start,end,categories&$top=200`;
    while (url) {
      const r: Page<GEvent> = await http(url, { token, headers: UTC });
      for (const e of r.value ?? []) { const b = toBusy(e); if (b) out.push(b); }
      url = r["@odata.nextLink"];
    }
    return out;
  },

  async createEvent(token, calendarId, input) {
    // transactionId makes a retried POST idempotent (Graph returns the original or 409 on a duplicate).
    try {
      const e = await http<GEvent>(`${cal(calendarId)}/events`, { token, json: eventBody(input), headers: UTC });
      return { id: e.id, meetingUrl: joinUrl(e) };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "conflict") {
        const found = await http<Page<GEvent>>(`${cal(calendarId)}/events?$filter=${encodeURIComponent(`transactionId eq '${input.bookingId}'`)}&$top=1`, { token, headers: UTC });
        const existing = found.value?.[0];
        if (existing) return microsoftProvider.updateEvent(token, calendarId, existing.id, input);
      }
      throw err;
    }
  },

  async updateEvent(token, calendarId, eventId, input): Promise<EventResult> {
    const body = eventBody(input);
    delete body.transactionId; delete body.isOnlineMeeting; delete body.onlineMeetingProvider; // immutable after creation
    const e = await http<GEvent>(`${G}/me/events/${encodeURIComponent(eventId)}`, { token, method: "PATCH", json: body, headers: UTC });
    return { id: e.id, meetingUrl: joinUrl(e) };
  },

  async deleteEvent(token, _calendarId, eventId) {
    try {
      await http(`${G}/me/events/${encodeURIComponent(eventId)}`, { token, method: "DELETE" });
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "gone")) return;
      throw e;
    }
  },

  async refreshSubscription(token, { calendarId, existing, notificationUrl, secret }) {
    if (!canReceiveWebhooks()) return null;
    const expiresAt = new Date(Date.now() + SUB_MINUTES * 60_000);
    if (existing) {
      try {
        const r = await http<{ id: string; expirationDateTime: string }>(`${G}/subscriptions/${existing.id}`, { token, method: "PATCH", json: { expirationDateTime: expiresAt.toISOString() } });
        return { id: r.id, expiresAt: new Date(r.expirationDateTime) };
      } catch (e) {
        if (!(e instanceof ProviderError && (e.kind === "not_found" || e.kind === "gone"))) throw e; // else recreate below
      }
    }
    const r = await http<{ id: string; expirationDateTime: string }>(`${G}/subscriptions`, { token, json: {
      changeType: "created,updated,deleted", notificationUrl, resource: `/me/calendars/${calendarId}/events`,
      expirationDateTime: expiresAt.toISOString(), clientState: secret,
    } });
    return { id: r.id, expiresAt: new Date(r.expirationDateTime) };
  },

  async stopSubscription(token, sub) {
    try {
      await http(`${G}/subscriptions/${sub.id}`, { token, method: "DELETE" });
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "gone")) return;
      throw e;
    }
  },

  async listChanges(token, calendarId, { syncToken, from, to }): Promise<ChangeSet> {
    const changes: ChangeSet["changes"] = [];
    let url: string | undefined = syncToken ??
      `${cal(calendarId)}/calendarView/delta?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}`;
    let delta: string | null = null;
    while (url) {
      // An expired deltaLink returns 410 (syncStateNotFound): propagates as kind "gone"; caller resets.
      const r: Page<GEvent> = await http(url, { token, headers: { ...UTC, Prefer: 'outlook.timezone="UTC", odata.maxpagesize=200' } });
      for (const e of r.value ?? []) changes.push({ id: e.id, busy: toBusy(e) });
      url = r["@odata.nextLink"];
      if (r["@odata.deltaLink"]) delta = r["@odata.deltaLink"];
    }
    return { changes, nextSyncToken: delta, reset: !syncToken };
  },
};
