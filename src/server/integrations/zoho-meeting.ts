/**
 * Zoho Meeting (video conferencing). REST API v2 on zohoHost("meeting"):
 *   GET    /api/v2/user.json                        -> org id (zsoid) + user id (zuid, the presenter)
 *   POST   /api/v2/{zsoid}/sessions.json            -> create scheduled meeting
 *   PUT    /api/v2/{zsoid}/sessions/{key}.json      -> edit
 *   DELETE /api/v2/{zsoid}/sessions/{key}.json      -> delete
 * Functions take the OAuth access token (callers wrap them in withVideoToken, like the Zoom helpers).
 */
import { zohoHost } from "./config";
import { http, ProviderError } from "./http";

export const ZOHO_MEETING_SCOPES = [
  "ZohoMeeting.manageOrg.READ", // user.json (zsoid / zuid)
  "ZohoMeeting.meeting.CREATE",
  "ZohoMeeting.meeting.READ",
  "ZohoMeeting.meeting.UPDATE",
  "ZohoMeeting.meeting.DELETE",
];

export interface ZohoMeetingInput {
  bookingId: string; topic: string; startsAt: Date; endsAt: Date; agenda?: string;
  /** Invitee/guest emails to add as participants. */
  attendeeEmails?: string[];
}
export interface ZohoMeetingResult { id: string; joinUrl: string }

interface OrgInfo { zsoid: string; zuid: string }
const orgCache = new Map<string, OrgInfo>();
const ORG_CACHE_MAX = 200;

const headers = (token: string) => ({ Authorization: `Zoho-oauthtoken ${token}`, "X-ZSOURCE": "MeetFlow" });
const base = () => `${zohoHost("meeting")}/api/v2`;

/** Test helper. */
export function _clearZohoOrgCache() { orgCache.clear(); }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Zoho wants "Jun 19, 2020 07:00 PM" interpreted in `timezone` (we always send UTC). */
export function zohoStartTime(d: Date): string {
  const h24 = d.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}, ${d.getUTCFullYear()} ${pad(h)}:${pad(d.getUTCMinutes())} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Discover (and cache per token) the organization id and the user id used as presenter. */
export async function getZohoOrg(token: string): Promise<OrgInfo> {
  const hit = orgCache.get(token);
  if (hit) return hit;
  const r = await http<{ userDetails?: Record<string, unknown>; [k: string]: unknown }>(`${base()}/user.json`, { headers: headers(token) });
  const d = (r?.userDetails ?? r ?? {}) as Record<string, unknown>;
  const zsoid = d.zsoid ?? d.zsOid;
  const zuid = d.zuid ?? d.userId ?? d.zUid;
  if (zsoid == null || zuid == null) throw new ProviderError("Zoho Meeting: could not determine organization id", "other", 200, r);
  const info = { zsoid: String(zsoid), zuid: String(zuid) };
  if (orgCache.size >= ORG_CACHE_MAX) orgCache.delete(orgCache.keys().next().value as string);
  orgCache.set(token, info);
  return info;
}

const session = (i: ZohoMeetingInput, presenter: string) => ({
  session: {
    topic: i.topic,
    ...(i.agenda ? { agenda: i.agenda } : {}),
    presenter: /^\d+$/.test(presenter) ? Number(presenter) : presenter,
    startTime: zohoStartTime(i.startsAt),
    duration: Math.max(1, Math.round((i.endsAt.getTime() - i.startsAt.getTime()) / 60_000)) * 60_000,
    timezone: "UTC",
    participants: (i.attendeeEmails ?? []).map((email) => ({ email })),
  },
});

export async function createZohoMeeting(token: string, input: ZohoMeetingInput): Promise<ZohoMeetingResult> {
  const { zsoid, zuid } = await getZohoOrg(token);
  const r = await http<{ session?: { meetingKey?: string | number; joinLink?: string } }>(
    `${base()}/${zsoid}/sessions.json`, { headers: headers(token), json: session(input, zuid) });
  const s = r?.session;
  if (!s?.meetingKey || !s.joinLink) throw new ProviderError("Zoho Meeting: unexpected create response", "other", 200, r);
  return { id: String(s.meetingKey), joinUrl: s.joinLink };
}

/** Throws ProviderError kind "not_found" when the meeting is gone so the caller can recreate (same as Zoom). */
export async function updateZohoMeeting(token: string, meetingKey: string, input: ZohoMeetingInput): Promise<void> {
  const { zsoid, zuid } = await getZohoOrg(token);
  await http(`${base()}/${zsoid}/sessions/${encodeURIComponent(meetingKey)}.json`, { headers: headers(token), method: "PUT", json: session(input, zuid) });
}

export async function deleteZohoMeeting(token: string, meetingKey: string): Promise<void> {
  const { zsoid } = await getZohoOrg(token);
  try {
    await http(`${base()}/${zsoid}/sessions/${encodeURIComponent(meetingKey)}.json`, { headers: headers(token), method: "DELETE" });
  } catch (e) {
    if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "gone")) return;
    throw e;
  }
}
