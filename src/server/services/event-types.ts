import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertFeature, assertWithinPlan, type PlanSubject } from "./plan-limits";
import { eventTypeInputSchema, isTeamKind, slugify, type EventTypeInput } from "@/lib/validation/event-types";

const { eventTypes, eventHosts, eventQuestions, bookingPageSettings, organizationMembers, availabilitySchedules, users } = schema;

type EventTypeRow = typeof eventTypes.$inferSelect;
export type EventTypeDetail = EventTypeRow & {
  hosts: { userId: string; name: string; email: string; priority: number; weight: number; isRequired: boolean }[];
  questions: { id: string; label: string; type: string; options: string[] | null; required: boolean; position: number }[];
  pageSettings: { brandColor: string | null; logoUrl: string | null; headline: string | null; successMessage: string | null } | null;
};
export type EventTypeListItem = EventTypeRow & { hostCount: number };
export type Actor = { userId: string };

const ORG_ROLE_RANK = { member: 1, admin: 2, owner: 3 } as const;

function parse(input: unknown): EventTypeInput {
  const r = eventTypeInputSchema.safeParse(input);
  if (!r.success) {
    throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Invalid input", 422,
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

/** Membership role in an org or null. */
export async function getOrgRole(userId: string, orgId: string, db: Db = defaultDb) {
  const [m] = await db.select({ role: organizationMembers.role }).from(organizationMembers)
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, orgId))).limit(1);
  return m?.role ?? null;
}

async function assertOrgRole(userId: string, orgId: string, min: keyof typeof ORG_ROLE_RANK, db: Db) {
  const role = await getOrgRole(userId, orgId, db);
  if (!role) throw new AppError("FORBIDDEN", "You are not a member of this organization", 403);
  if (ORG_ROLE_RANK[role] < ORG_ROLE_RANK[min]) throw new AppError("FORBIDDEN", "You need admin rights in this organization", 403);
}

/** Load an event type (not soft-deleted) and verify actor access. */
async function loadAuthorized(actor: Actor, id: string, level: "read" | "manage", db: Db): Promise<EventTypeRow> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AppError("NOT_FOUND", "Event type not found", 404);
  const [row] = await db.select().from(eventTypes).where(and(eq(eventTypes.id, id), isNull(eventTypes.deletedAt))).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Event type not found", 404);
  if (row.ownerUserId) {
    if (row.ownerUserId !== actor.userId) throw new AppError("FORBIDDEN", "You do not have access to this event type", 403);
  } else if (row.organizationId) {
    await assertOrgRole(actor.userId, row.organizationId, level === "read" ? "member" : "admin", db);
  } else {
    throw new AppError("FORBIDDEN", "You do not have access to this event type", 403);
  }
  return row;
}

const planSubject = (row: { ownerUserId: string | null; organizationId: string | null }, actor: Actor): PlanSubject =>
  row.organizationId ? { orgId: row.organizationId } : { userId: row.ownerUserId ?? actor.userId };

function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === "object" && (cur as { code?: string }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

async function slugTaken(scope: { ownerUserId: string | null; organizationId: string | null }, slug: string, excludeId: string | null, db: Db) {
  const owner = scope.organizationId ? eq(eventTypes.organizationId, scope.organizationId) : eq(eventTypes.ownerUserId, scope.ownerUserId!);
  const conds = [owner, eq(eventTypes.slug, slug), isNull(eventTypes.deletedAt)];
  if (excludeId) conds.push(ne(eventTypes.id, excludeId));
  const [r] = await db.select({ id: eventTypes.id }).from(eventTypes).where(and(...conds)).limit(1);
  return !!r;
}

async function uniqueSlug(scope: { ownerUserId: string | null; organizationId: string | null }, base: string, db: Db) {
  let candidate = base;
  for (let n = 2; await slugTaken(scope, candidate, null, db); n++) candidate = `${base.slice(0, 55)}-${n}`;
  return candidate;
}

async function validateRefs(actor: Actor, v: EventTypeInput, scope: { ownerUserId: string | null; organizationId: string | null }, db: Db) {
  if (v.organizationId) {
    const ids = v.hosts.map((h) => h.userId);
    const members = ids.length
      ? await db.select({ userId: organizationMembers.userId }).from(organizationMembers)
          .where(and(eq(organizationMembers.organizationId, v.organizationId), inArray(organizationMembers.userId, ids)))
      : [];
    if (members.length !== new Set(ids).size) throw new AppError("VALIDATION", "All hosts must be members of the organization", 422, [{ path: "hosts", message: "All hosts must be members of the organization" }]);
  }
  if (v.scheduleId) {
    const [s] = await db.select({ userId: availabilitySchedules.userId }).from(availabilitySchedules).where(eq(availabilitySchedules.id, v.scheduleId)).limit(1);
    const allowed = new Set([actor.userId, ...(scope.ownerUserId ? [scope.ownerUserId] : []), ...v.hosts.map((h) => h.userId)]);
    if (!s || !allowed.has(s.userId)) throw new AppError("VALIDATION", "Choose one of your own availability schedules", 422, [{ path: "scheduleId", message: "Schedule not found" }]);
  }
}

type WriteTx = Pick<Db, "select" | "insert" | "update" | "delete">;

async function writeChildren(tx: WriteTx, eventTypeId: string, v: EventTypeInput) {
  await tx.delete(eventHosts).where(eq(eventHosts.eventTypeId, eventTypeId));
  if (v.organizationId && v.hosts.length)
    await tx.insert(eventHosts).values(v.hosts.map((h) => ({ eventTypeId, userId: h.userId, priority: h.priority, weight: h.weight, isRequired: h.isRequired })));
  // questions: keep ids that still exist so earlier invitee answers stay linked
  const existing = await tx.select({ id: eventQuestions.id }).from(eventQuestions).where(eq(eventQuestions.eventTypeId, eventTypeId));
  const existingIds = new Set(existing.map((q) => q.id));
  const keep = new Set<string>();
  for (const [position, q] of v.questions.entries()) {
    const opts = ["dropdown", "radio", "checkbox"].includes(q.type) ? (q.options ?? []) : null;
    if (q.id && existingIds.has(q.id)) {
      keep.add(q.id);
      await tx.update(eventQuestions).set({ label: q.label, type: q.type, options: opts, required: q.required, position }).where(eq(eventQuestions.id, q.id));
    } else {
      const [ins] = await tx.insert(eventQuestions).values({ eventTypeId, label: q.label, type: q.type, options: opts, required: q.required, position }).returning({ id: eventQuestions.id });
      keep.add(ins.id);
    }
  }
  const drop = [...existingIds].filter((i) => !keep.has(i));
  if (drop.length) await tx.delete(eventQuestions).where(inArray(eventQuestions.id, drop));
  if (v.pageSettings) {
    const p = { brandColor: v.pageSettings.brandColor ?? null, logoUrl: v.pageSettings.logoUrl ?? null, headline: v.pageSettings.headline || null, successMessage: v.pageSettings.successMessage || null };
    await tx.insert(bookingPageSettings).values({ eventTypeId, ...p }).onConflictDoUpdate({ target: bookingPageSettings.eventTypeId, set: p });
  } else {
    await tx.delete(bookingPageSettings).where(eq(bookingPageSettings.eventTypeId, eventTypeId));
  }
}

const KIND_FEATURE: Partial<Record<EventTypeInput["kind"], string>> = { group: "groupEvents", round_robin: "roundRobin", collective: "collective" };

async function assertFeatures(subject: PlanSubject, v: EventTypeInput, prev: { kind?: string; priceAmount?: number | null } | null, db: Db) {
  const f = KIND_FEATURE[v.kind];
  if (f && prev?.kind !== v.kind) await assertFeature(subject, f, db);
  if (v.priceAmount != null && prev?.priceAmount == null) await assertFeature(subject, "payments", db);
}

function columns(v: EventTypeInput) {
  return {
    title: v.title, slug: v.slug, description: v.description || null, kind: v.kind, durationMinutes: v.durationMinutes,
    locationType: v.locationType, locationValue: v.locationValue || null,
    bufferBeforeMinutes: v.bufferBeforeMinutes, bufferAfterMinutes: v.bufferAfterMinutes,
    minNoticeMinutes: v.minNoticeMinutes, maxHorizonDays: v.maxHorizonDays,
    slotIntervalMinutes: v.slotIntervalMinutes ?? null, dailyLimit: v.dailyLimit ?? null, weeklyLimit: v.weeklyLimit ?? null,
    capacity: v.capacity, scheduleId: v.scheduleId ?? null, requiresConfirmation: v.requiresConfirmation,
    cancellationPolicy: v.cancellationPolicy || null, allowReschedule: v.allowReschedule, minCancelNoticeMinutes: v.minCancelNoticeMinutes,
    color: v.color ?? null, redirectUrl: v.redirectUrl ?? null,
    priceAmount: v.priceAmount ?? null, priceCurrency: v.priceAmount != null ? (v.priceCurrency ?? null) : null,
    paymentProvider: v.priceAmount != null ? (v.paymentProvider ?? null) : null,
    reminders: [...new Set(v.reminders)].sort((a, b) => b - a), recurrence: v.recurrence ?? null,
    isActive: v.isActive, isOneOff: v.isOneOff,
  };
}

// ───────── reads
export async function listEventTypes(
  actor: Actor,
  opts: { organizationId?: string | null; includeArchived?: boolean } = {},
  db: Db = defaultDb,
): Promise<EventTypeListItem[]> {
  let scope;
  if (opts.organizationId) {
    await assertOrgRole(actor.userId, opts.organizationId, "member", db);
    scope = eq(eventTypes.organizationId, opts.organizationId);
  } else scope = eq(eventTypes.ownerUserId, actor.userId);
  const conds = [scope, isNull(eventTypes.deletedAt)];
  if (!opts.includeArchived) conds.push(isNull(eventTypes.archivedAt));
  const rows = await db.select().from(eventTypes).where(and(...conds)).orderBy(desc(eventTypes.createdAt));
  if (!rows.length) return [];
  const hostRows = await db.select({ eventTypeId: eventHosts.eventTypeId, n: sql<number>`count(*)::int` }).from(eventHosts)
    .where(inArray(eventHosts.eventTypeId, rows.map((r) => r.id))).groupBy(eventHosts.eventTypeId);
  const m = new Map(hostRows.map((h) => [h.eventTypeId, h.n]));
  return rows.map((r) => ({ ...r, hostCount: m.get(r.id) ?? 0 }));
}

export async function getEventType(actor: Actor, id: string, db: Db = defaultDb): Promise<EventTypeDetail> {
  const row = await loadAuthorized(actor, id, "read", db);
  const [hosts, questions, [page]] = await Promise.all([
    db.select({ userId: eventHosts.userId, name: users.name, email: users.email, priority: eventHosts.priority, weight: eventHosts.weight, isRequired: eventHosts.isRequired })
      .from(eventHosts).innerJoin(users, eq(users.id, eventHosts.userId)).where(eq(eventHosts.eventTypeId, id)).orderBy(asc(eventHosts.priority)),
    db.select().from(eventQuestions).where(eq(eventQuestions.eventTypeId, id)).orderBy(asc(eventQuestions.position)),
    db.select().from(bookingPageSettings).where(eq(bookingPageSettings.eventTypeId, id)).limit(1),
  ]);
  return {
    ...row, hosts,
    questions: questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options, required: q.required, position: q.position })),
    pageSettings: page ? { brandColor: page.brandColor, logoUrl: page.logoUrl, headline: page.headline, successMessage: page.successMessage } : null,
  };
}

export async function listOrgMembers(actor: Actor, organizationId: string, db: Db = defaultDb) {
  await assertOrgRole(actor.userId, organizationId, "member", db);
  return db.select({ userId: users.id, name: users.name, email: users.email, role: organizationMembers.role })
    .from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId)).orderBy(asc(users.name));
}

export async function listUserOrganizations(actor: Actor, db: Db = defaultDb) {
  return db.select({ id: schema.organizations.id, name: schema.organizations.name, slug: schema.organizations.slug, role: organizationMembers.role })
    .from(organizationMembers).innerJoin(schema.organizations, eq(schema.organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, actor.userId), isNull(schema.organizations.deletedAt))).orderBy(asc(schema.organizations.name));
}

// ───────── writes
export async function createEventType(actor: Actor, input: unknown, db: Db = defaultDb): Promise<EventTypeDetail> {
  const v = parse(input);
  if (v.organizationId) await assertOrgRole(actor.userId, v.organizationId, "admin", db);
  if (isTeamKind(v.kind) && !v.organizationId) throw new AppError("VALIDATION", "Team event kinds require an organization", 422);
  const scope = v.organizationId ? { ownerUserId: null, organizationId: v.organizationId } : { ownerUserId: actor.userId, organizationId: null };
  const subject = planSubject(scope, actor);
  if (!v.isOneOff) await assertWithinPlan(subject, "maxEventTypes", db);
  await assertFeatures(subject, v, null, db);
  await validateRefs(actor, v, scope, db);
  if (await slugTaken(scope, v.slug, null, db)) throw new AppError("SLUG_TAKEN", `The link "${v.slug}" is already used by another event type`, 409, [{ path: "slug", message: "Already in use" }]);
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.insert(eventTypes).values({ ...columns(v), ...scope }).returning({ id: eventTypes.id });
      await writeChildren(tx, row.id, v);
      return row.id;
    });
    return await getEventType(actor, id, db);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("SLUG_TAKEN", `The link "${v.slug}" is already used by another event type`, 409, [{ path: "slug", message: "Already in use" }]);
    throw e;
  }
}

export async function updateEventType(actor: Actor, id: string, input: unknown, db: Db = defaultDb): Promise<EventTypeDetail> {
  const v = parse(input);
  const cur = await loadAuthorized(actor, id, "manage", db);
  if ((v.organizationId ?? null) !== (cur.organizationId ?? null))
    throw new AppError("VALIDATION", "An event type cannot be moved between personal and organization scope. Duplicate it instead.", 422);
  const scope = { ownerUserId: cur.ownerUserId, organizationId: cur.organizationId };
  await assertFeatures(planSubject(scope, actor), v, cur, db);
  await validateRefs(actor, v, scope, db);
  if (await slugTaken(scope, v.slug, id, db)) throw new AppError("SLUG_TAKEN", `The link "${v.slug}" is already used by another event type`, 409, [{ path: "slug", message: "Already in use" }]);
  try {
    await db.transaction(async (tx) => {
      await tx.update(eventTypes).set({ ...columns(v), isOneOff: cur.isOneOff, updatedAt: new Date() }).where(eq(eventTypes.id, id));
      await writeChildren(tx, id, v);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("SLUG_TAKEN", `The link "${v.slug}" is already used by another event type`, 409, [{ path: "slug", message: "Already in use" }]);
    throw e;
  }
  return getEventType(actor, id, db);
}

export async function duplicateEventType(actor: Actor, id: string, opts: { oneOff?: boolean } = {}, db: Db = defaultDb): Promise<EventTypeDetail> {
  const src = await getEventType(actor, id, db);
  await loadAuthorized(actor, id, "manage", db);
  const scope = { ownerUserId: src.ownerUserId, organizationId: src.organizationId };
  if (!opts.oneOff) await assertWithinPlan(planSubject(scope, actor), "maxEventTypes", db);
  const slug = opts.oneOff ? `${slugify(src.title).slice(0, 40)}-${randomBytes(4).toString("hex")}` : await uniqueSlug(scope, `${src.slug.slice(0, 50)}-copy`, db);
  const dup: EventTypeInput = eventTypeInputSchema.parse({
    organizationId: src.organizationId, title: opts.oneOff ? src.title : `${src.title} (copy)`.slice(0, 120), slug, description: src.description, kind: src.kind,
    durationMinutes: src.durationMinutes, locationType: src.locationType, locationValue: src.locationValue,
    bufferBeforeMinutes: src.bufferBeforeMinutes, bufferAfterMinutes: src.bufferAfterMinutes, minNoticeMinutes: src.minNoticeMinutes,
    maxHorizonDays: src.maxHorizonDays, slotIntervalMinutes: src.slotIntervalMinutes, dailyLimit: src.dailyLimit, weeklyLimit: src.weeklyLimit,
    capacity: src.capacity, scheduleId: src.scheduleId, requiresConfirmation: src.requiresConfirmation, cancellationPolicy: src.cancellationPolicy,
    allowReschedule: src.allowReschedule, minCancelNoticeMinutes: src.minCancelNoticeMinutes, color: src.color, redirectUrl: src.redirectUrl,
    priceAmount: src.priceAmount, priceCurrency: src.priceCurrency, paymentProvider: src.paymentProvider as "stripe" | "razorpay" | null,
    reminders: src.reminders, recurrence: src.recurrence, isActive: src.isActive, isOneOff: !!opts.oneOff,
    hosts: src.hosts.map((h) => ({ userId: h.userId, priority: h.priority, weight: h.weight, isRequired: h.isRequired })),
    questions: src.questions.map((q) => ({ label: q.label, type: q.type, options: q.options, required: q.required })),
    pageSettings: src.pageSettings,
  });
  const id2 = await db.transaction(async (tx) => {
    const [row] = await tx.insert(eventTypes).values({ ...columns(dup), ...scope }).returning({ id: eventTypes.id });
    await writeChildren(tx, row.id, dup);
    return row.id;
  });
  return getEventType(actor, id2, db);
}

export async function setEventTypeArchived(actor: Actor, id: string, archived: boolean, db: Db = defaultDb): Promise<void> {
  const row = await loadAuthorized(actor, id, "manage", db);
  if (!archived && row.archivedAt && !row.isOneOff) await assertWithinPlan(planSubject(row, actor), "maxEventTypes", db);
  await db.update(eventTypes).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() }).where(eq(eventTypes.id, id));
}

export async function setEventTypeActive(actor: Actor, id: string, isActive: boolean, db: Db = defaultDb): Promise<void> {
  await loadAuthorized(actor, id, "manage", db);
  await db.update(eventTypes).set({ isActive, updatedAt: new Date() }).where(eq(eventTypes.id, id));
}

/** Soft delete: bookings keep their reference; the slug is freed. */
export async function deleteEventType(actor: Actor, id: string, db: Db = defaultDb): Promise<void> {
  await loadAuthorized(actor, id, "manage", db);
  await db.update(eventTypes).set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() }).where(eq(eventTypes.id, id));
}

/** Public path (without origin) of an event type page, or null if the owner has no username/org slug yet. */
export async function publicPathFor(row: Pick<EventTypeRow, "ownerUserId" | "organizationId" | "slug">, db: Db = defaultDb): Promise<string | null> {
  if (row.ownerUserId) {
    const [u] = await db.select({ username: users.username }).from(users).where(eq(users.id, row.ownerUserId)).limit(1);
    return u?.username ? `/${u.username}/${row.slug}` : null;
  }
  if (row.organizationId) {
    const [o] = await db.select({ slug: schema.organizations.slug }).from(schema.organizations).where(eq(schema.organizations.id, row.organizationId)).limit(1);
    return o ? `/${o.slug}/${row.slug}` : null;
  }
  return null;
}

