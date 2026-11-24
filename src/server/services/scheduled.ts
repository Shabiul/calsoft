/**
 * "Scheduled events" read/write model for the dashboard (upcoming / past / cancelled, search, filters,
 * detail drawer, host notes, CSV export). Mutations delegate to the booking service.
 *
 * Visibility: a user sees bookings they host, plus (for organization bookings) all bookings of orgs where
 * they are owner/admin/manager/team lead or hold the `bookings.view_all` permission. Collective bookings have one row per host;
 * linked rows (`external_event_ids ? 'collectiveOf'`) are hidden and the primary row is shown once, also to
 * hosts who only own a linked row.
 */
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";
import { randomToken } from "@/lib/crypto";
import { approveBooking, cancelBooking, createBooking, declineBooking, markBooking, rescheduleBooking } from "./booking";
import { getEventType } from "./event-types";
import { meetLinkExpected } from "@/server/integrations/meet-pending";
import { getAvailableSlots } from "@/server/scheduling/slots";

const { bookings: B, invitees, inviteeAnswers, eventTypes, users, organizations, organizationMembers, bookingEvents } = schema;

export type ScheduledTab = "upcoming" | "past" | "cancelled";
export interface ScheduledFilters { tab?: ScheduledTab; q?: string; eventTypeId?: string; hostId?: string; page?: number; pageSize?: number }

export const PAGE_SIZE = 25;
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const LINKED = sql`${B.externalEventIds} ? 'collectiveOf'`;
/** Statuses that hold a slot and appear in "Upcoming" (requests awaiting approval included). */
const ACTIVE = ["confirmed", "pending_payment", "pending_confirmation"] as const;

/** Rows I host (not linked) OR org rows I may see (not linked) OR primaries of collective rows I host. */
function visible(userId: string): SQL {
  return sql`(
    ((${B.hostUserId} = ${userId}
      -- the scheduler keeps access only while still a member of the team of the booking (an ex-member must not)
      or (${B.scheduledByUserId} = ${userId} and ${B.organizationId} in (select m.organization_id from organization_member m where m.user_id = ${userId}))
      or ${B.organizationId} in (
        select m.organization_id from organization_member m
        where m.user_id = ${userId} and (m.role in ('owner','admin','manager','team_lead') or m.permissions ? 'bookings.view_all')))
      and not (${LINKED}))
    or ${B.id} in (
        select (x.external_event_ids->>'collectiveOf')::uuid from booking x
        where x.host_user_id = ${userId} and x.external_event_ids ? 'collectiveOf')
  )`;
}
function hostIs(hostId: string): SQL {
  return sql`((${B.hostUserId} = ${hostId} and not (${LINKED})) or ${B.id} in (
    select (x.external_event_ids->>'collectiveOf')::uuid from booking x where x.host_user_id = ${hostId} and x.external_event_ids ? 'collectiveOf'))`;
}
const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function where(userId: string, f: ScheduledFilters, now: Date): SQL {
  const parts: (SQL | undefined)[] = [visible(userId)];
  const tab = f.tab ?? "upcoming";
  if (tab === "upcoming") parts.push(inArray(B.status, [...ACTIVE]), sql`${B.endsAt} >= ${now}`);
  else if (tab === "past") parts.push(or(inArray(B.status, ["completed", "no_show", "expired"]), and(inArray(B.status, [...ACTIVE]), sql`${B.endsAt} < ${now}`)));
  else parts.push(eq(B.status, "cancelled"));
  if (f.eventTypeId && isUuid(f.eventTypeId)) parts.push(eq(B.eventTypeId, f.eventTypeId));
  if (f.hostId) parts.push(hostIs(f.hostId));
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const like = `%${escLike(q)}%`;
    parts.push(sql`(exists (select 1 from invitee i where i.booking_id = ${B.id} and (i.name ilike ${like} or i.email ilike ${like}))
      or exists (select 1 from event_type et where et.id = ${B.eventTypeId} and et.title ilike ${like}))`);
  }
  return and(...parts)!;
}

export type ScheduledRow = {
  id: string; startsAt: Date; endsAt: Date; status: (typeof B.$inferSelect)["status"];
  eventTitle: string; eventColor: string | null; eventKind: string; eventTypeId: string;
  hostName: string; hostNames: string[]; organizationName: string | null;
  inviteeName: string; inviteeEmail: string; inviteeCount: number; inviteeTimeZone: string;
};

async function decorate(rows: (typeof B.$inferSelect)[], db: Db): Promise<ScheduledRow[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const orgIds = [...new Set(rows.map((r) => r.organizationId).filter((x): x is string => !!x))];
  const [evs, invs, linked, orgs] = await Promise.all([
    db.select({ id: eventTypes.id, title: eventTypes.title, color: eventTypes.color, kind: eventTypes.kind }).from(eventTypes).where(inArray(eventTypes.id, [...new Set(rows.map((r) => r.eventTypeId))])),
    db.select().from(invitees).where(inArray(invitees.bookingId, ids)).orderBy(asc(invitees.createdAt)),
    db.select({ hostUserId: B.hostUserId, parent: sql<string>`${B.externalEventIds}->>'collectiveOf'` }).from(B).where(sql`${B.externalEventIds}->>'collectiveOf' in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`),
    orgIds.length ? db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds)) : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const hostIds = [...new Set([...rows.map((r) => r.hostUserId), ...linked.map((l) => l.hostUserId)])];
  const hs = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, hostIds));
  const hostName = new Map(hs.map((h) => [h.id, h.name]));
  return rows.map((r) => {
    const e = evs.find((x) => x.id === r.eventTypeId);
    const mine = invs.filter((i) => i.bookingId === r.id);
    const extra = linked.filter((l) => l.parent === r.id).map((l) => hostName.get(l.hostUserId) ?? "Unknown");
    return {
      id: r.id, startsAt: r.startsAt, endsAt: r.endsAt, status: r.status,
      eventTitle: e?.title ?? "Event", eventColor: e?.color ?? null, eventKind: e?.kind ?? "one_on_one", eventTypeId: r.eventTypeId,
      hostName: hostName.get(r.hostUserId) ?? "Unknown", hostNames: [hostName.get(r.hostUserId) ?? "Unknown", ...extra],
      organizationName: orgs.find((o) => o.id === r.organizationId)?.name ?? null,
      inviteeName: mine[0]?.name ?? "", inviteeEmail: mine[0]?.email ?? "", inviteeCount: mine.length, inviteeTimeZone: r.inviteeTimeZone,
    };
  });
}

export async function listScheduled(userId: string, f: ScheduledFilters = {}, db: Db = defaultDb, now = new Date()) {
  const pageSize = Math.min(Math.max(f.pageSize ?? PAGE_SIZE, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const w = where(userId, f, now);
  const order = (f.tab ?? "upcoming") === "upcoming" ? asc(B.startsAt) : desc(B.startsAt);
  const [rows, [c]] = await Promise.all([
    db.select().from(B).where(w).orderBy(order, asc(B.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(B).where(w),
  ]);
  return { rows: await decorate(rows, db), total: c?.n ?? 0, page, pageSize };
}

/** Counts for the tab badges. */
export async function countScheduled(userId: string, f: Omit<ScheduledFilters, "tab">, db: Db = defaultDb, now = new Date()) {
  const out = {} as Record<ScheduledTab, number>;
  for (const tab of ["upcoming", "past", "cancelled"] as const) {
    const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(B).where(where(userId, { ...f, tab }, now));
    out[tab] = c?.n ?? 0;
  }
  return out;
}

export async function getFilterOptions(userId: string, db: Db = defaultDb) {
  const memberships = await db.select({ orgId: organizationMembers.organizationId, role: organizationMembers.role }).from(organizationMembers).where(eq(organizationMembers.userId, userId));
  const orgIds = memberships.map((m) => m.orgId);
  const adminOrgIds = memberships.filter((m) => m.role !== "member").map((m) => m.orgId);
  const [events, hostRows] = await Promise.all([
    db.select({ id: eventTypes.id, title: eventTypes.title }).from(eventTypes)
      .where(and(sql`${eventTypes.deletedAt} is null`, or(eq(eventTypes.ownerUserId, userId), orgIds.length ? inArray(eventTypes.organizationId, orgIds) : undefined))).orderBy(asc(eventTypes.title)),
    adminOrgIds.length
      ? db.select({ id: users.id, name: users.name }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId)).where(inArray(organizationMembers.organizationId, adminOrgIds))
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const hosts = new Map<string, string>(hostRows.map((h) => [h.id, h.name]));
  if (!hosts.has(userId)) { const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)); hosts.set(userId, me?.name ?? "Me"); }
  return { events, hosts: [...hosts].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) };
}

// ───────── detail
export type BookingDetail = ScheduledRow & {
  meetingUrl: string | null; locationType: string | null; hostNotes: string | null; hostTimeZone: string;
  cancelReason: string | null; cancelledAt: Date | null; cancelledBy: string | null;
  invitees: { name: string; email: string; phone: string | null }[];
  answers: { question: string; answer: string }[];
  timeline: { id: string; at: Date; type: string; actor: string | null; detail: string | null }[];
  canCancel: boolean; canReschedule: boolean; canMark: boolean;
  /** Host can approve/decline (status pending_confirmation). */
  canDecide: boolean;
  rescheduledFromId: string | null;
  /** Recurring series: size and position, plus how many future occurrences "cancel series" would remove. */
  series: { id: string; count: number; position: number; upcoming: number; pendingApproval: number } | null;
};

async function loadAccessible(userId: string, bookingId: string, db: Db) {
  if (!isUuid(bookingId)) throw new AppError("NOT_FOUND", "Booking not found", 404);
  const [row] = await db.select().from(B).where(eq(B.id, bookingId)).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Booking not found", 404);
  const parent = (row.externalEventIds as Record<string, string> | null)?.collectiveOf;
  const primaryId = parent ?? row.id;
  const [ok] = await db.select({ id: B.id }).from(B).where(and(eq(B.id, primaryId), visible(userId))).limit(1);
  if (!ok) throw new AppError("NOT_FOUND", "Booking not found", 404); // do not reveal existence
  const [primary] = parent ? await db.select().from(B).where(eq(B.id, primaryId)).limit(1) : [row];
  return primary;
}

const EVENT_LABEL: Record<string, string> = {
  created: "Booked", rescheduled: "Rescheduled", rescheduled_to: "Created by reschedule", cancelled: "Cancelled",
  marked_completed: "Marked completed", marked_no_show: "Marked no-show", marked_confirmed: "Confirmed", marked_expired: "Expired",
  guests_added: "Guests added", notes_updated: "Notes updated", approved: "Approved", declined: "Declined",
  marked_pending_confirmation: "Paid, awaiting approval",
};

export async function getBookingDetail(userId: string, bookingId: string, db: Db = defaultDb): Promise<BookingDetail> {
  const b = await loadAccessible(userId, bookingId, db);
  const [base] = await decorate([b], db);
  const invs = await db.select().from(invitees).where(eq(invitees.bookingId, b.id)).orderBy(asc(invitees.createdAt));
  const answers = invs[0] ? await db.select({ question: inviteeAnswers.question, answer: inviteeAnswers.answer }).from(inviteeAnswers).where(eq(inviteeAnswers.inviteeId, invs[0].id)) : [];
  // History: this booking and the chain of bookings it was rescheduled from.
  const chain = [b.id];
  let prev = b.rescheduledFromId;
  for (let i = 0; prev && i < 20; i++) {
    chain.push(prev);
    const [p] = await db.select({ r: B.rescheduledFromId }).from(B).where(eq(B.id, prev)).limit(1);
    prev = p?.r ?? null;
  }
  const events = await db.select().from(bookingEvents).where(inArray(bookingEvents.bookingId, chain)).orderBy(asc(bookingEvents.createdAt));
  const active = (ACTIVE as readonly string[]).includes(b.status);
  let series: BookingDetail["series"] = null;
  if (b.seriesId) {
    const sr = await db.select({ id: B.id, startsAt: B.startsAt, status: B.status }).from(B)
      .where(and(eq(B.seriesId, b.seriesId), sql`not (${LINKED})`, sql`${B.status} <> 'rescheduled'`)).orderBy(asc(B.startsAt));
    series = {
      id: b.seriesId, count: sr.length, position: Math.max(sr.findIndex((r) => r.id === b.id), 0) + 1,
      upcoming: sr.filter((r) => (ACTIVE as readonly string[]).includes(r.status) && r.startsAt > new Date()).length,
      pendingApproval: sr.filter((r) => r.status === "pending_confirmation").length,
    };
  }
  return {
    ...base, meetingUrl: b.meetingUrl, locationType: b.locationType, hostNotes: b.hostNotes, hostTimeZone: b.hostTimeZone,
    cancelReason: b.cancelReason, cancelledAt: b.cancelledAt, cancelledBy: b.cancelledBy,
    invitees: invs.map((i) => ({ name: i.name, email: i.email, phone: i.phone })), answers,
    timeline: events.map((e) => {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const detail = e.type === "rescheduled" && d.to ? `to ${new Date(String(d.to)).toISOString()}` : typeof d.reason === "string" && d.reason ? d.reason : null;
      return { id: e.id, at: e.createdAt, type: EVENT_LABEL[e.type] ?? e.type, actor: e.actor, detail };
    }),
    canCancel: active, canReschedule: active, canMark: b.status === "confirmed" || b.status === "completed" || b.status === "no_show",
    canDecide: b.status === "pending_confirmation", series,
    rescheduledFromId: b.rescheduledFromId,
  };
}

// ───────── mutations (authorization = visibility, then the booking service does the work)
export async function cancelScheduled(userId: string, bookingId: string, reason?: string, scope: "occurrence" | "series" = "occurrence") {
  const b = await loadAccessible(userId, bookingId, defaultDb);
  return cancelBooking({ bookingId: b.id, actor: "host", actorId: userId, reason: reason?.trim().slice(0, 500) || undefined, scope });
}
/** Host approves a request awaiting confirmation (a series is approved as a whole). */
export async function approveScheduled(userId: string, bookingId: string) {
  const b = await loadAccessible(userId, bookingId, defaultDb);
  return approveBooking({ bookingId: b.id, actor: "host", actorId: userId });
}
/** Host declines a request awaiting confirmation (slot released, invitee emailed; a series is declined as a whole). */
export async function declineScheduled(userId: string, bookingId: string, reason?: string) {
  const b = await loadAccessible(userId, bookingId, defaultDb);
  return declineBooking({ bookingId: b.id, actor: "host", actorId: userId, reason: reason?.trim().slice(0, 500) || undefined });
}
export async function rescheduleScheduled(userId: string, bookingId: string, newStartsAt: string) {
  const b = await loadAccessible(userId, bookingId, defaultDb);
  return rescheduleBooking({ bookingId: b.id, newStartsAt, actor: "host", actorId: userId });
}
export async function markScheduled(userId: string, bookingId: string, status: "completed" | "no_show" | "confirmed") {
  const b = await loadAccessible(userId, bookingId, defaultDb);
  return markBooking({ bookingId: b.id, status, actor: "host", actorId: userId });
}
export async function setHostNotes(userId: string, bookingId: string, notes: string, db: Db = defaultDb) {
  const b = await loadAccessible(userId, bookingId, db);
  const clean = notes.slice(0, 5000);
  await db.update(B).set({ hostNotes: clean || null, updatedAt: new Date() }).where(eq(B.id, b.id));
  await db.insert(bookingEvents).values({ bookingId: b.id, type: "notes_updated", actor: "host", data: { actorId: userId } });
}
export async function getRescheduleSlots(userId: string, bookingId: string, from: Date, to: Date) {
  const b = await loadAccessible(userId, bookingId, defaultDb);
  if (to.getTime() - from.getTime() > 14 * 86_400_000) throw new AppError("VALIDATION", "Choose a range of up to 14 days", 422);
  const slots = await getAvailableSlots({ eventTypeId: b.eventTypeId, from, to, inviteeTimeZone: b.inviteeTimeZone, excludeBookingId: b.id });
  return slots.map((s) => s.startsAt);
}

// ───────── host-scheduled meetings
/** Open slots for an event type the user can access, for the host-side "Schedule meeting" form. */
export async function getScheduleSlots(userId: string, eventTypeId: string, from: Date, to: Date, timeZone: string) {
  await getEventType({ userId }, eventTypeId);
  if (to.getTime() - from.getTime() > 14 * 86_400_000) throw new AppError("VALIDATION", "Choose a range of up to 14 days", 422);
  const slots = await getAvailableSlots({ eventTypeId, from, to, inviteeTimeZone: timeZone });
  return slots.map((s) => s.startsAt);
}

export interface ScheduleMeetingInput {
  eventTypeId: string; startsAt: string; timeZone: string;
  invitee: { name: string; email: string; phone?: string | null };
  /** Additional attendees (emails) invited to the meeting. */
  guests?: string[];
  /** Internal meeting context for the host/team (never sent to the invitee). */
  context?: string;
}
/** The host books a meeting on behalf of an invitee and invites extra attendees. Goes through the normal booking path (slot checks, calendar/Meet, emails). */
export async function scheduleMeeting(userId: string, input: ScheduleMeetingInput) {
  await getEventType({ userId }, input.eventTypeId);
  const res = await createBooking({
    eventTypeId: input.eventTypeId, startsAt: input.startsAt,
    invitee: { ...input.invitee, timeZone: input.timeZone },
    guests: input.guests, actor: "host", actorId: userId, hostNotes: input.context, scheduledByUserId: userId,
  });
  return { bookingId: res.booking.id, meetPending: await meetLinkExpected(res.booking) };
}

/** Creates a single-use personal booking link carrying internal meeting context. Returns the token for `?ctx=`. */
export async function createContextLink(userId: string, eventTypeId: string, notes: string, db: Db = defaultDb): Promise<string> {
  await getEventType({ userId }, eventTypeId);
  const clean = notes.trim().slice(0, 5000);
  if (!clean) throw new AppError("VALIDATION", "Write the meeting context first", 422);
  const token = randomToken(18); // 24 url-safe chars
  await db.insert(schema.meetingContexts).values({ token, eventTypeId, createdByUserId: userId, notes: clean });
  return token;
}

/** Current Meet/meeting link of a booking the user can access (polled while the link is being created). */
export async function getMeetingUrl(userId: string, bookingId: string, db: Db = defaultDb): Promise<string | null> {
  const b = await loadAccessible(userId, bookingId, db);
  return b.meetingUrl ?? null;
}

// ───────── CSV
const csvCell = (v: unknown) => {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export async function exportScheduledCsv(userId: string, f: ScheduledFilters, db: Db = defaultDb): Promise<string> {
  const head = ["Booking ID", "Status", "Event", "Starts (UTC)", "Ends (UTC)", "Host(s)", "Invitee", "Invitee email", "Invitee time zone", "Guests", "Organization"];
  const lines = [head.join(",")];
  for (let page = 1; page <= 50; page++) {
    const { rows } = await listScheduled(userId, { ...f, page, pageSize: 100 }, db);
    for (const r of rows) {
      lines.push([r.id, r.status, r.eventTitle, r.startsAt, r.endsAt, r.hostNames.join("; "), r.inviteeName, r.inviteeEmail, r.inviteeTimeZone, Math.max(r.inviteeCount - 1, 0), r.organizationName].map(csvCell).join(","));
    }
    if (rows.length < 100) break;
  }
  return lines.join("\r\n") + "\r\n";
}
