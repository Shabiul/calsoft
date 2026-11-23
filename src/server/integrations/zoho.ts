/**
 * Zoho Calendar (REST API v1). Host depends on the account's data center (ZOHO_DC).
 * Quirks: auth header is `Zoho-oauthtoken <t>`; event payload is a JSON string in the `eventdata` query param;
 * timed dates are `yyyyMMdd'T'HHmmss'Z'` (GMT); update/delete need the event's etag; list range is capped at 31 days;
 * no push notifications to arbitrary webhooks (we poll).
 */
import { http, ProviderError } from "./http";
import { zohoHost } from "./config";
import type { CalendarProvider, ChangeSet, EventInput, EventResult, Interval } from "./types";

const MAX_RANGE_MS = 30 * 24 * 3600_000; // API limit is 31 days; stay under it
/** Footer marker so our own booking events are not counted as external busy time. */
const OWN_MARKER = "Booked via MeetFlow";

interface ZEvent {
  uid: string; recurrenceid?: string; etag?: string | number; title?: string; description?: string; isallday?: boolean;
  transparency?: string | number; dateandtime?: { start?: string; end?: string; timezone?: string };
  start?: string; end?: string; conference_data?: { joinurl?: string; url?: string } | null;
}

const base = () => `${zohoHost("calendar")}/api/v1`;
const calUrl = (id: string) => `${base()}/calendars/${encodeURIComponent(id)}`;
const evUrl = (c: string, e: string) => `${calUrl(c)}/events/${encodeURIComponent(e)}`;
const authed = (token: string, extra: Record<string, string> = {}) => ({ headers: { Authorization: `Zoho-oauthtoken ${token}`, ...extra } });

const pad = (n: number) => String(n).padStart(2, "0");
/** Date -> yyyyMMdd'T'HHmmss'Z' (GMT). */
export const zohoDate = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** Parse Zoho date strings: 20170718T205000+0530, 20170718T205000Z, 20170718T205000 (UTC), or all-day 20170718. */
export function parseZohoDate(s?: string): Date | null {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", se = "0", tz] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (tz && tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    ms -= sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60_000;
  }
  return new Date(ms);
}

function toBusy(e: ZEvent): Interval | null {
  const t = String(e.transparency ?? "").toLowerCase();
  if (t === "free" || t === "transparent") return null;
  if (e.description?.includes(OWN_MARKER)) return null;
  const start = parseZohoDate(e.dateandtime?.start ?? e.start);
  const end = parseZohoDate(e.dateandtime?.end ?? e.end);
  if (!start || !end) return null;
  if (e.isallday) {
    // All-day events are dates: resolved to the host's local days by resolveAllDay. Zoho does not document whether the end date is
    // inclusive; assume inclusive (blocking one extra day is safer than leaving an all-day event open and double-booking it).
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const lastDay = end > start ? end : start;
    const endExclusive = new Date(lastDay.getTime() + 24 * 3600_000);
    return { start, end: endExclusive, allDay: { startDate: day(start), endDate: day(endExclusive) } };
  }
  return end > start ? { start, end } : null;
}

function eventData(input: EventInput, etag?: string) {
  const parts = [input.description, input.meetingUrl && `Join: ${input.meetingUrl}`, OWN_MARKER].filter(Boolean);
  const data: Record<string, unknown> = {
    title: input.title,
    description: parts.join("\n\n").slice(0, 10_000),
    dateandtime: { timezone: "UTC", start: zohoDate(input.startsAt), end: zohoDate(input.endsAt) },
    isallday: false,
    attendees: input.attendees.map((a) => ({ email: a.email, permission: 1, attendance: 1 })),
    notify_attendee: 1,
  };
  const loc = input.meetingUrl ?? input.location;
  if (loc) data.location = loc.slice(0, 255);
  if (etag) data.etag = etag;
  return data;
}

const q = (data: unknown) => `?eventdata=${encodeURIComponent(JSON.stringify(data))}`;
const isMissing = (e: unknown) => e instanceof ProviderError && (e.kind === "not_found" || e.kind === "gone");

async function listWindow(token: string, calendarId: string, from: Date, to: Date): Promise<ZEvent[]> {
  const out: ZEvent[] = [];
  for (let s = from.getTime(); s < to.getTime(); s += MAX_RANGE_MS) {
    const e = Math.min(s + MAX_RANGE_MS, to.getTime());
    const range = encodeURIComponent(JSON.stringify({ start: zohoDate(new Date(s)), end: zohoDate(new Date(e)) }));
    // byinstance=true expands recurring series into occurrences (otherwise only the series' first slot is returned).
    const r = await http<{ events?: ZEvent[] }>(`${calUrl(calendarId)}/events?range=${range}&byinstance=true`, authed(token, { Accept: "application/json+large" }));
    out.push(...(r?.events ?? []));
  }
  return out;
}

async function currentEtag(token: string, calendarId: string, eventId: string): Promise<string> {
  const r = await http<{ events?: ZEvent[] }>(evUrl(calendarId, eventId), authed(token));
  const etag = r?.events?.[0]?.etag;
  if (etag === undefined || etag === null) throw new ProviderError("Zoho event has no etag", "not_found", 404);
  return String(etag);
}

const result = (r: { events?: ZEvent[] }): EventResult => {
  const e = r?.events?.[0];
  if (!e?.uid) throw new ProviderError("Zoho returned no event", "other");
  return { id: e.uid };
};

export const zohoCalendar: CalendarProvider = {
  name: "zoho",

  async getCalendars(token) {
    const r = await http<{ calendars?: { uid: string; name: string; isdefault?: boolean; privilege?: string }[] }>(`${base()}/calendars`, authed(token));
    return (r?.calendars ?? []).map((c) => ({
      externalId: c.uid, name: c.name, primary: !!c.isdefault,
      writable: !/^(view|read|freebusy|free_busy|none)/i.test(c.privilege ?? ""),
    }));
  },

  async getBusyIntervals(token, calendarId, from, to) {
    const out: Interval[] = [];
    for (const e of await listWindow(token, calendarId, from, to)) { const b = toBusy(e); if (b) out.push(b); }
    return out;
  },

  async createEvent(token, calendarId, input) {
    // nativeMeeting is ignored: Zoho cannot generate a join link via this API; meetingUrl goes in location/description.
    const r = await http<{ events?: ZEvent[] }>(`${calUrl(calendarId)}/events${q(eventData(input))}`, { ...authed(token), method: "POST" });
    return result(r);
  },

  async updateEvent(token, calendarId, eventId, input): Promise<EventResult> {
    const etag = await currentEtag(token, calendarId, eventId);
    const r = await http<{ events?: ZEvent[] }>(`${evUrl(calendarId, eventId)}${q(eventData(input, etag))}`, { ...authed(token, { etag }), method: "PUT" });
    return result(r);
  },

  async deleteEvent(token, calendarId, eventId) {
    try {
      const etag = await currentEtag(token, calendarId, eventId);
      await http(evUrl(calendarId, eventId), { ...authed(token, { etag }), method: "DELETE" });
    } catch (e) {
      if (isMissing(e)) return;
      throw e;
    }
  },

  // Zoho Calendar cannot push to an arbitrary webhook URL; the app polls (syncAllDue).
  async refreshSubscription() { return null; },
  async stopSubscription() { /* nothing to stop */ },

  async listChanges(token, calendarId, { from, to }): Promise<ChangeSet> {
    const changes: ChangeSet["changes"] = [];
    // Occurrences of a recurring event share one uid; key them by recurrenceid so the calendar_busy upsert sees unique ids.
    // Chunks are contiguous, so an event spanning a chunk boundary can appear twice: dedupe by id.
    const seen = new Set<string>();
    for (const e of await listWindow(token, calendarId, from, to)) {
      const id = e.recurrenceid ? `${e.uid}:${e.recurrenceid}` : e.uid;
      if (!seen.has(id)) { seen.add(id); changes.push({ id, busy: toBusy(e) }); }
    }
    return { changes, nextSyncToken: null, reset: true };
  },
};
