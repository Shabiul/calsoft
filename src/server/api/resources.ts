/**
 * Data access + serializers for the REST API. Every query is scoped to the API key's tenant
 * (key owner user, plus the key's organization when set). Bookings are mutated only via the booking service.
 */
import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { AppError } from "@/server/errors";
import { decodeCursor, encodeCursor, page, type ApiKeyContext } from "./handler";

const { bookings, invitees, contacts, connectedCalendars, calendars, organizations, organizationMembers, users } = schema;

type Booking = typeof bookings.$inferSelect;

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ───────── bookings
export function serializeBooking(b: Booking, invitee?: { name: string; email: string; phone: string | null } | null) {
  return {
    id: b.id, event_id: b.eventTypeId, host_user_id: b.hostUserId, organization_id: b.organizationId, status: b.status,
    starts_at: iso(b.startsAt), ends_at: iso(b.endsAt), host_time_zone: b.hostTimeZone, invitee_time_zone: b.inviteeTimeZone,
    location_type: b.locationType, meeting_url: b.meetingUrl, rescheduled_from_id: b.rescheduledFromId, series_id: b.seriesId,
    cancelled_at: iso(b.cancelledAt), cancel_reason: b.cancelReason, cancelled_by: b.cancelledBy,
    invitee: invitee ? { name: invitee.name, email: invitee.email, phone: invitee.phone } : null,
    created_at: iso(b.createdAt), updated_at: iso(b.updatedAt),
  };
}

export function bookingTenant(key: ApiKeyContext): SQL {
  const own = eq(bookings.hostUserId, key.userId);
  return key.organizationId ? (or(own, eq(bookings.organizationId, key.organizationId)) as SQL) : own;
}

export async function getBookingFor(key: ApiKeyContext, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Booking not found", 404);
  const [b] = await db.select().from(bookings).where(and(eq(bookings.id, id), bookingTenant(key))).limit(1);
  if (!b) throw new AppError("NOT_FOUND", "Booking not found", 404);
  const [inv] = await db.select().from(invitees).where(eq(invitees.bookingId, b.id)).limit(1);
  return serializeBooking(b, inv);
}

export interface BookingFilter {
  limit: number; cursor?: string; status?: Booking["status"]; event_id?: string; from?: Date; to?: Date; invitee_email?: string;
}
export async function listBookingsFor(key: ApiKeyContext, f: BookingFilter) {
  const conds: SQL[] = [bookingTenant(key)];
  if (f.status) conds.push(eq(bookings.status, f.status));
  if (f.event_id) conds.push(eq(bookings.eventTypeId, f.event_id));
  if (f.from) conds.push(sql`${bookings.startsAt} >= ${f.from.toISOString()}`);
  if (f.to) conds.push(sql`${bookings.startsAt} < ${f.to.toISOString()}`);
  if (f.invitee_email) {
    conds.push(sql`exists (select 1 from ${invitees} i where i.booking_id = ${bookings.id} and lower(i.email) = ${f.invitee_email.toLowerCase()})`);
  }
  const cur = decodeCursor(f.cursor);
  if (cur) conds.push(or(lt(bookings.startsAt, new Date(cur.t)), and(eq(bookings.startsAt, new Date(cur.t)), lt(bookings.id, cur.id))) as SQL);
  const rows = await db.select().from(bookings).where(and(...conds)).orderBy(desc(bookings.startsAt), desc(bookings.id)).limit(f.limit + 1);
  const hasMore = rows.length > f.limit;
  const slice = rows.slice(0, f.limit);
  const invs = slice.length ? await db.select().from(invitees).where(inArray(invitees.bookingId, slice.map((r) => r.id))) : [];
  const by = new Map(invs.map((i) => [i.bookingId, i]));
  const last = slice[slice.length - 1];
  return page(slice.map((b) => serializeBooking(b, by.get(b.id))), hasMore, hasMore && last ? encodeCursor(last.startsAt, last.id) : null);
}

// ───────── event types
export function serializeEvent(e: typeof schema.eventTypes.$inferSelect, extra: Record<string, unknown> = {}) {
  return {
    id: e.id, organization_id: e.organizationId, owner_user_id: e.ownerUserId, slug: e.slug, title: e.title, description: e.description,
    kind: e.kind, duration_minutes: e.durationMinutes, location_type: e.locationType, location_value: e.locationValue,
    buffer_before_minutes: e.bufferBeforeMinutes, buffer_after_minutes: e.bufferAfterMinutes, min_notice_minutes: e.minNoticeMinutes,
    max_horizon_days: e.maxHorizonDays, capacity: e.capacity, schedule_id: e.scheduleId, requires_confirmation: e.requiresConfirmation,
    is_active: e.isActive, archived_at: iso(e.archivedAt), created_at: iso(e.createdAt), updated_at: iso(e.updatedAt), ...extra,
  };
}

/** Maps the public snake_case body to the internal camelCase event type input. */
export function eventBodyToInput(b: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, string> = {
    organization_id: "organizationId", duration_minutes: "durationMinutes", location_type: "locationType", location_value: "locationValue",
    buffer_before_minutes: "bufferBeforeMinutes", buffer_after_minutes: "bufferAfterMinutes", min_notice_minutes: "minNoticeMinutes",
    max_horizon_days: "maxHorizonDays", slot_interval_minutes: "slotIntervalMinutes", daily_limit: "dailyLimit", weekly_limit: "weeklyLimit",
    schedule_id: "scheduleId", requires_confirmation: "requiresConfirmation", cancellation_policy: "cancellationPolicy",
    allow_reschedule: "allowReschedule", min_cancel_notice_minutes: "minCancelNoticeMinutes", redirect_url: "redirectUrl",
    is_active: "isActive",
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) out[map[k] ?? k] = v;
  return out;
}

// ───────── contacts
export const serializeContact = (c: typeof contacts.$inferSelect) => ({
  id: c.id, email: c.email, name: c.name, phone: c.phone, time_zone: c.timeZone, organization_id: c.organizationId,
  created_at: iso(c.createdAt), updated_at: iso(c.updatedAt),
});

export function contactTenant(key: ApiKeyContext): SQL {
  const own = eq(contacts.ownerUserId, key.userId);
  return key.organizationId ? (or(own, eq(contacts.organizationId, key.organizationId)) as SQL) : own;
}

// ───────── calendars
export async function listCalendarsFor(key: ApiKeyContext) {
  const conns = await db.select({
    id: connectedCalendars.id, provider: connectedCalendars.provider, email: connectedCalendars.email,
    status: connectedCalendars.status, createdAt: connectedCalendars.createdAt,
  }).from(connectedCalendars).where(eq(connectedCalendars.userId, key.userId));
  const cals = conns.length ? await db.select().from(calendars).where(inArray(calendars.connectedCalendarId, conns.map((c) => c.id))) : [];
  return conns.map((c) => ({
    id: c.id, provider: c.provider, account_email: c.email, status: c.status, connected_at: iso(c.createdAt),
    calendars: cals.filter((k) => k.connectedCalendarId === c.id).map((k) => ({
      id: k.id, name: k.name, check_conflicts: k.checkConflicts, is_destination: k.isDestination,
    })),
  }));
}

// ───────── organizations
export async function listOrganizationsFor(key: ApiKeyContext) {
  const rows = await db.select({
    id: organizations.id, name: organizations.name, slug: organizations.slug, planId: organizations.planId,
    logoUrl: organizations.logoUrl, createdAt: organizations.createdAt, role: organizationMembers.role,
  }).from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, key.userId), sql`${organizations.deletedAt} is null`))
    .orderBy(organizations.name);
  const scoped = key.organizationId ? rows.filter((r) => r.id === key.organizationId) : rows;
  return scoped.map((r) => ({ id: r.id, name: r.name, slug: r.slug, plan_id: r.planId, logo_url: r.logoUrl, role: r.role, created_at: iso(r.createdAt) }));
}

export async function getOrganizationFor(key: ApiKeyContext, id: string) {
  const o = (await listOrganizationsFor(key)).find((x) => x.id === id);
  if (!o) throw new AppError("NOT_FOUND", "Organization not found", 404);
  return o;
}

export async function listMembersFor(key: ApiKeyContext, id: string) {
  await getOrganizationFor(key, id);
  const rows = await db.select({ userId: users.id, name: users.name, email: users.email, role: organizationMembers.role, joinedAt: organizationMembers.createdAt })
    .from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, id)).orderBy(users.name);
  return rows.map((r) => ({ user_id: r.userId, name: r.name, email: r.email, role: r.role, joined_at: iso(r.joinedAt) }));
}
