/**
 * Read-side loaders for the public booking pages. Everything returned here is safe to expose publicly:
 * no emails of hosts, no internal ids other than event/booking ids needed by the client.
 */
import { maskedMeetingUrl } from "@/server/public/join";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import {
  users, eventTypes, eventQuestions, bookingPageSettings, bookings, invitees, pageViews, organizations,
} from "@/server/db/schema";
import { sha256 } from "@/lib/crypto";

export type PublicHost = { name: string; image: string | null; username: string; bio: string | null; timeZone: string };
export type PublicQuestion = { id: string; label: string; type: string; options: string[] | null; required: boolean };
export type PublicEvent = {
  id: string;
  slug: string;
  /** Locked share code (/m/<code>); null for events created before short codes. */
  shortCode: string | null;
  title: string;
  description: string | null;
  kind: string;
  durationMinutes: number;
  locationType: string;
  /** Only populated for in_person (an address); never leaks meeting URLs/phone numbers. */
  locationAddress: string | null;
  priceAmount: number | null;
  priceCurrency: string | null;
  requiresConfirmation: boolean;
  /** A notetaker bot will join and transcribe the meeting (disclosed to the invitee). */
  notetaker: boolean;
  /** Recurring event: invitees book `count` sessions at once (group events never recur). */
  recurrence: { count: number; interval: "week" | "month" } | null;
  cancellationPolicy: string | null;
  allowReschedule: boolean;
  minCancelNoticeMinutes: number;
  maxHorizonDays: number;
  minNoticeMinutes: number;
  redirectUrl: string | null;
  capacity: number;
  brandColor: string | null;
  logoUrl: string | null;
  headline: string | null;
  successMessage: string | null;
  host: PublicHost;
  questions: PublicQuestion[];
};

const HEX = /^#[0-9a-fA-F]{6}$/;
export const safeColor = (c: string | null | undefined): string | null => (c && HEX.test(c) ? c : null);
export const safeUrl = (u: string | null | undefined): string | null => {
  if (!u) return null;
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null; } catch { return null; }
};
const safeHttpUrl = (u: string | null | undefined) => (u && !u.startsWith("/") ? safeUrl(u) : null);

export const LOCATION_LABELS: Record<string, string> = {
  google_meet: "Google Meet", zoom: "Zoom", teams: "Microsoft Teams", zoho_meeting: "Zoho Meeting", custom_url: "Online meeting",
  in_person: "In person", phone: "Phone call", invitee_phone: "Phone call (host calls you)",
};

const activeUser = (username: string) =>
  db.query.users.findFirst({ where: and(eq(users.username, username.toLowerCase()), isNull(users.deletedAt), eq(users.status, "active")) });

type EventRow = typeof eventTypes.$inferSelect;
type OrgRow = typeof organizations.$inferSelect;
/** The public-facing "host" of a page: a user, or an organization presented as one (slug as username). */
type HostLike = Pick<typeof users.$inferSelect, "name" | "image" | "username" | "bio" | "timeZone" | "brandColor" | "logoUrl">;

const orgAsHost = (o: OrgRow): HostLike => ({ name: o.name, image: null, username: o.slug, bio: null, timeZone: "UTC", brandColor: o.brandColor, logoUrl: o.logoUrl });
const activeOrg = (slug: string) =>
  db.query.organizations.findFirst({ where: and(eq(organizations.slug, slug.toLowerCase()), isNull(organizations.deletedAt)) });

const isLive = (e: EventRow) => e.isActive && !e.archivedAt && !e.deletedAt;

async function toPublic(e: EventRow, owner: HostLike): Promise<PublicEvent> {
  const [questions, settings] = await Promise.all([
    db.select().from(eventQuestions).where(eq(eventQuestions.eventTypeId, e.id)).orderBy(asc(eventQuestions.position)),
    db.query.bookingPageSettings.findFirst({ where: eq(bookingPageSettings.eventTypeId, e.id) }),
  ]);
  return {
    id: e.id, slug: e.slug, shortCode: e.shortCode, title: e.title, description: e.description, kind: e.kind,
    durationMinutes: e.durationMinutes, locationType: e.locationType,
    locationAddress: e.locationType === "in_person" ? e.locationValue : null,
    priceAmount: e.priceAmount, priceCurrency: e.priceCurrency,
    requiresConfirmation: e.requiresConfirmation,
    notetaker: e.notetakerEnabled,
    recurrence: e.kind !== "group" && e.recurrence && e.recurrence.count >= 2 ? e.recurrence : null,
    cancellationPolicy: e.cancellationPolicy,
    allowReschedule: e.allowReschedule, minCancelNoticeMinutes: e.minCancelNoticeMinutes,
    maxHorizonDays: e.maxHorizonDays, minNoticeMinutes: e.minNoticeMinutes,
    redirectUrl: safeHttpUrl(e.redirectUrl), capacity: e.capacity,
    brandColor: safeColor(settings?.brandColor) ?? safeColor(e.color) ?? safeColor(owner.brandColor),
    logoUrl: safeUrl(settings?.logoUrl) ?? safeUrl(owner.logoUrl),
    headline: settings?.headline ?? null, successMessage: settings?.successMessage ?? null,
    host: { name: owner.name, image: safeUrl(owner.image), username: owner.username ?? "", bio: owner.bio, timeZone: owner.timeZone },
    questions: questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options, required: q.required })),
  };
}

export type PublicProfile = {
  host: PublicHost & { brandColor: string | null; logoUrl: string | null };
  events: { slug: string; title: string; description: string | null; durationMinutes: number; locationType: string; color: string | null; priceAmount: number | null; priceCurrency: string | null; kind: string }[];
};

export async function loadProfile(username: string): Promise<PublicProfile | null> {
  const u = await activeUser(username);
  // Usernames and organization slugs share one namespace: fall back to an organization page.
  const org = u ? null : await activeOrg(username);
  const h: HostLike | null = u ?? (org ? orgAsHost(org) : null);
  if (!h || !h.username) return null;
  const rows = await db.select().from(eventTypes).where(and(
    u ? eq(eventTypes.ownerUserId, u.id) : eq(eventTypes.organizationId, org!.id),
    eq(eventTypes.isActive, true), eq(eventTypes.isOneOff, false),
    isNull(eventTypes.archivedAt), isNull(eventTypes.deletedAt),
  )).orderBy(asc(eventTypes.createdAt));
  return {
    host: { name: h.name, image: safeUrl(h.image), username: h.username, bio: h.bio, timeZone: h.timeZone, brandColor: safeColor(h.brandColor), logoUrl: safeUrl(h.logoUrl) },
    events: rows.map((e) => ({
      slug: e.slug, title: e.title, description: e.description, durationMinutes: e.durationMinutes,
      locationType: e.locationType, color: safeColor(e.color), priceAmount: e.priceAmount, priceCurrency: e.priceCurrency, kind: e.kind,
    })),
  };
}

export async function loadEvent(username: string, slug: string): Promise<PublicEvent | null> {
  const u = await activeUser(username);
  const org = u ? null : await activeOrg(username);
  if (!u && !org) return null;
  const e = await db.query.eventTypes.findFirst({ where: and(u ? eq(eventTypes.ownerUserId, u.id) : eq(eventTypes.organizationId, org!.id), eq(eventTypes.slug, slug), isNull(eventTypes.deletedAt)) });
  if (!e || !isLive(e)) return null;
  return toPublic(e, u ?? orgAsHost(org!));
}

/** Resolves a bookable event from its short share code (/m/<code>). */
export async function loadEventByShortCode(code: string): Promise<PublicEvent | null> {
  if (!/^[A-Za-z0-9]{6,16}$/.test(code)) return null;
  const e = await db.query.eventTypes.findFirst({ where: and(eq(eventTypes.shortCode, code), isNull(eventTypes.deletedAt)), columns: { id: true } });
  return e ? loadEventById(e.id) : null;
}

/** Used by the JSON API: resolves a bookable event by id (owner must be active). */
export async function loadEventById(id: string): Promise<PublicEvent | null> {
  const e = await db.query.eventTypes.findFirst({ where: and(eq(eventTypes.id, id), isNull(eventTypes.deletedAt)) });
  if (!e || !isLive(e)) return null;
  if (!e.ownerUserId) {
    if (!e.organizationId) return null;
    const org = await db.query.organizations.findFirst({ where: and(eq(organizations.id, e.organizationId), isNull(organizations.deletedAt)) });
    return org ? toPublic(e, orgAsHost(org)) : null;
  }
  const u = await db.query.users.findFirst({ where: and(eq(users.id, e.ownerUserId), isNull(users.deletedAt), eq(users.status, "active")) });
  if (!u) return null;
  return toPublic(e, u);
}

export async function trackPageView(eventTypeId: string | null, userId: string | null): Promise<void> {
  try { await db.insert(pageViews).values({ eventTypeId, userId }); } catch { /* analytics must never break the page */ }
}

export async function loadUserIdByUsername(username: string): Promise<string | null> {
  const u = await activeUser(username);
  return u?.id ?? null;
}

// ───────── manage page

export type BookingView = {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  inviteeTimeZone: string;
  invitee: { name: string; email: string; phone: string | null } | null;
  meetingUrl: string | null;
  calendarMeetingUrl: string | null;
  locationType: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  event: PublicEvent;
  history: { id: string; status: string; startsAt: string; endsAt: string }[];
  canCancel: boolean;
  canReschedule: boolean;
  /** Reason shown when cancel/reschedule is blocked. */
  blockedReason: string | null;
  /** Recurring series this booking belongs to (all live occurrences, time order). */
  series: { occurrences: { startsAt: string; endsAt: string; status: string; current: boolean }[] } | null;
  canCancelSeries: boolean;
};

export const hashToken = (t: string) => sha256(t);

export type RawBooking = typeof bookings.$inferSelect;

export async function findBookingByToken(token: string): Promise<RawBooking | null> {
  if (!token || token.length < 16 || token.length > 200) return null;
  const b = await db.query.bookings.findFirst({ where: eq(bookings.manageTokenHash, hashToken(token)) });
  return b ?? null;
}

export function computeManageState(
  b: Pick<RawBooking, "status" | "startsAt">,
  e: Pick<PublicEvent, "allowReschedule" | "minCancelNoticeMinutes">,
  now = new Date(),
): { canCancel: boolean; canReschedule: boolean; blockedReason: string | null } {
  const active = b.status === "confirmed" || b.status === "pending_payment" || b.status === "pending_confirmation";
  if (!active) return { canCancel: false, canReschedule: false, blockedReason: null };
  const msLeft = b.startsAt.getTime() - now.getTime();
  if (msLeft <= 0) return { canCancel: false, canReschedule: false, blockedReason: "This meeting has already started or passed." };
  if (msLeft < e.minCancelNoticeMinutes * 60_000) {
    const h = e.minCancelNoticeMinutes >= 60 ? `${Math.round((e.minCancelNoticeMinutes / 60) * 10) / 10} hour(s)` : `${e.minCancelNoticeMinutes} minute(s)`;
    return { canCancel: false, canReschedule: false, blockedReason: `Changes are not allowed within ${h} of the start time. Please contact the host directly.` };
  }
  return { canCancel: true, canReschedule: e.allowReschedule, blockedReason: null };
}

export async function loadBookingView(token: string): Promise<BookingView | null> {
  const b = await findBookingByToken(token);
  if (!b) return null;
  const ev = await db.query.eventTypes.findFirst({ where: eq(eventTypes.id, b.eventTypeId) });
  if (!ev) return null;
  let host: HostLike | undefined;
  if (ev.organizationId && !ev.ownerUserId) {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ev.organizationId) });
    host = org ? orgAsHost(org) : undefined;
  } else {
    host = await db.query.users.findFirst({ where: eq(users.id, ev.ownerUserId ?? b.hostUserId) });
    host ??= await db.query.users.findFirst({ where: eq(users.id, b.hostUserId) });
  }
  if (!host) return null;
  const event = await toPublic(ev, host);
  const [inv] = await db.select().from(invitees).where(eq(invitees.bookingId, b.id)).orderBy(asc(invitees.createdAt)).limit(1);

  // Preserve history: walk the reschedule chain backwards (bounded).
  const history: BookingView["history"] = [];
  let prevId = b.rescheduledFromId;
  for (let i = 0; prevId && i < 20; i++) {
    const p = await db.query.bookings.findFirst({ where: eq(bookings.id, prevId) });
    if (!p) break;
    history.push({ id: p.id, status: p.status, startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString() });
    prevId = p.rescheduledFromId;
  }
  const state = computeManageState(b, event);
  let series: BookingView["series"] = null;
  let canCancelSeries = false;
  if (b.seriesId) {
    const rows = await db.select().from(bookings).where(and(eq(bookings.seriesId, b.seriesId), sql`not (${bookings.externalEventIds} ? 'collectiveOf')`, sql`${bookings.status} <> 'rescheduled'`)).orderBy(asc(bookings.startsAt));
    series = { occurrences: rows.map((r) => ({ startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), status: r.status, current: r.id === b.id })) };
    const now = Date.now();
    const live = rows.filter((r) => (r.status === "confirmed" || r.status === "pending_confirmation" || r.status === "pending_payment") && r.startsAt.getTime() > now + event.minCancelNoticeMinutes * 60_000);
    canCancelSeries = live.length > 1 || (live.length === 1 && !state.canCancel);
  }
  return {
    id: b.id, status: b.status, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(),
    inviteeTimeZone: b.inviteeTimeZone,
    invitee: inv ? { name: inv.name, email: inv.email, phone: inv.phone } : null,
    meetingUrl: b.status === "confirmed" ? safeHttpUrl(maskedMeetingUrl(b)) : null, // invitees see /j/<code>, not the raw Meet URL
    /** Real meeting URL, only for adding the event to a calendar (Google/Outlook/.ics). */
    calendarMeetingUrl: b.status === "confirmed" ? safeHttpUrl(b.meetingUrl) : null,
    locationType: b.locationType ?? ev.locationType,
    cancelReason: b.cancelReason, cancelledAt: b.cancelledAt?.toISOString() ?? null, cancelledBy: b.cancelledBy,
    event, history, ...state, series, canCancelSeries,
  };
}
