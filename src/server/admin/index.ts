/** Super-admin data services. Callers (admin pages/actions) MUST have passed requireSuperadmin() first. */
import { and, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { connection } from "next/server";
import { z } from "zod";
import { db, pool, schema } from "@/server/db";
import { AppError } from "@/server/errors";
import { audit } from "@/server/audit";

const { users, sessions, organizations, organizationMembers, bookings, eventTypes, subscriptionPlans, subscriptions, auditLogs, platformSettings } = schema;
export const PAGE_SIZE = 25;
const escLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");
const num = (v: unknown) => Number(v ?? 0);

// ───────── overview
export async function getOverview() {
  const r = await db.execute(sql`select
    (select count(*)::int from "user" where deleted_at is null) as users,
    (select count(*)::int from "user" where status = 'suspended') as suspended,
    (select count(*)::int from organization where deleted_at is null) as orgs,
    (select count(*)::int from booking) as bookings,
    (select count(*)::int from booking where created_at > now() - interval '7 days') as bookings_7d,
    (select count(*)::int from subscription where status = 'active') as active_subs`);
  const row = r.rows[0] as Record<string, number>;
  return { users: row.users, suspended: row.suspended, orgs: row.orgs, bookings: row.bookings, bookings7d: row.bookings_7d, activeSubs: row.active_subs };
}

// ───────── users
export async function listUsers(o: { q?: string; status?: string; page?: number }) {
  const conds: SQL[] = [];
  if (o.q) conds.push(or(ilike(users.email, `%${escLike(o.q)}%`), ilike(users.name, `%${escLike(o.q)}%`), ilike(users.username, `%${escLike(o.q)}%`)) as SQL);
  if (o.status === "active" || o.status === "suspended") conds.push(eq(users.status, o.status));
  const where = conds.length ? and(...conds) : undefined;
  const page = Math.max(1, o.page ?? 1);
  const [rows, [{ n }]] = await Promise.all([
    db.select({
      id: users.id, name: users.name, email: users.email, username: users.username, status: users.status,
      platformRole: users.platformRole, createdAt: users.createdAt, deletedAt: users.deletedAt,
    }).from(users).where(where).orderBy(desc(users.createdAt), users.id).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(users).where(where),
  ]);
  return { rows, total: n, page, pages: Math.max(1, Math.ceil(n / PAGE_SIZE)) };
}

export async function setUserStatus(actorId: string, userId: string, status: "active" | "suspended") {
  if (actorId === userId) throw new AppError("FORBIDDEN", "You cannot change your own status", 403);
  const [u] = await db.select({ id: users.id, role: users.platformRole, status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new AppError("NOT_FOUND", "User not found", 404);
  if (status === "suspended" && u.role === "superadmin") throw new AppError("FORBIDDEN", "Superadmins cannot be suspended", 403);
  await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
  // Suspension revokes live sessions immediately (login is blocked by the auth session hook).
  if (status === "suspended") await db.delete(sessions).where(eq(sessions.userId, userId));
  await audit(actorId, status === "suspended" ? "admin.user.suspended" : "admin.user.reactivated", { type: "user", id: userId }, { from: u.status });
}

// ───────── organizations
export async function listOrganizations(o: { q?: string; page?: number }) {
  const where = and(sql`${organizations.deletedAt} is null`, o.q ? or(ilike(organizations.name, `%${escLike(o.q)}%`), ilike(organizations.slug, `%${escLike(o.q)}%`)) : undefined);
  const page = Math.max(1, o.page ?? 1);
  const [rows, [{ n }]] = await Promise.all([
    db.select({
      id: organizations.id, name: organizations.name, slug: organizations.slug, planId: organizations.planId, createdAt: organizations.createdAt,
      members: sql<number>`(select count(*)::int from ${organizationMembers} m where m.organization_id = ${organizations.id})`,
    }).from(organizations).where(where).orderBy(desc(organizations.createdAt), organizations.id).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(organizations).where(where),
  ]);
  return { rows, total: n, page, pages: Math.max(1, Math.ceil(n / PAGE_SIZE)) };
}

// ───────── plans & subscriptions
export async function listPlans() {
  return db.select().from(subscriptionPlans).orderBy(subscriptionPlans.priceMonthly, subscriptionPlans.id);
}

export const limitsSchema = z.record(z.string().min(1).max(60), z.union([z.number().finite(), z.boolean()]));
export const planSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/, "id: lowercase letters, digits, - or _"),
  name: z.string().trim().min(1).max(80),
  priceMonthly: z.number().int().min(0).max(10_000_000),
  currency: z.string().trim().toUpperCase().length(3),
  isActive: z.boolean(),
  limits: limitsSchema,
});
export type PlanInput = z.infer<typeof planSchema>;

/** Parses the textarea JSON for plan limits into a validated object. */
export function parseLimitsJson(text: string): Record<string, number | boolean> {
  let raw: unknown;
  try { raw = JSON.parse(text || "{}"); } catch { throw new AppError("VALIDATION", "Limits must be valid JSON", 422); }
  const r = limitsSchema.safeParse(raw);
  if (!r.success) throw new AppError("VALIDATION", "Limits must be an object of numbers/booleans, e.g. {\"maxEventTypes\": 5}", 422, r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export async function savePlan(actorId: string, input: unknown) {
  const r = planSchema.safeParse(input);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Invalid plan", 422, r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const p = r.data;
  const [before] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, p.id)).limit(1);
  await db.insert(subscriptionPlans).values(p).onConflictDoUpdate({ target: subscriptionPlans.id, set: { name: p.name, priceMonthly: p.priceMonthly, currency: p.currency, isActive: p.isActive, limits: p.limits } });
  await audit(actorId, before ? "admin.plan.updated" : "admin.plan.created", { type: "subscription_plan", id: p.id }, { before: before ?? null, after: p });
}

export async function listSubscriptions(o: { status?: string; page?: number }) {
  const where = o.status ? eq(subscriptions.status, o.status) : undefined;
  const page = Math.max(1, o.page ?? 1);
  const [rows, [{ n }]] = await Promise.all([
    db.select({
      id: subscriptions.id, planId: subscriptions.planId, status: subscriptions.status, provider: subscriptions.provider,
      currentPeriodEnd: subscriptions.currentPeriodEnd, createdAt: subscriptions.createdAt,
      userEmail: users.email, orgName: organizations.name,
    }).from(subscriptions).leftJoin(users, eq(users.id, subscriptions.userId)).leftJoin(organizations, eq(organizations.id, subscriptions.organizationId))
      .where(where).orderBy(desc(subscriptions.createdAt), subscriptions.id).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(subscriptions).where(where),
  ]);
  return { rows, total: n, page, pages: Math.max(1, Math.ceil(n / PAGE_SIZE)) };
}

export async function changeSubscriptionPlan(actorId: string, subscriptionId: string, planId: string) {
  const [plan] = await db.select({ id: subscriptionPlans.id }).from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
  if (!plan) throw new AppError("NOT_FOUND", "Plan not found", 404);
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
  if (!sub) throw new AppError("NOT_FOUND", "Subscription not found", 404);
  await db.update(subscriptions).set({ planId }).where(eq(subscriptions.id, subscriptionId));
  if (sub.organizationId) await db.update(organizations).set({ planId, updatedAt: new Date() }).where(eq(organizations.id, sub.organizationId));
  await audit(actorId, "admin.subscription.plan_changed", { type: "subscription", id: subscriptionId }, { from: sub.planId, to: planId });
}

// ───────── booking statistics
export async function getBookingStats(days = 30) {
  await connection(); // request-time data (Date.now) — opt out of prerendering
  const since = new Date(Date.now() - days * 86_400_000);
  const [byStatus, perDay, topEvents, totals] = await Promise.all([
    db.select({ status: bookings.status, n: sql<number>`count(*)::int` }).from(bookings).groupBy(bookings.status),
    db.execute(sql`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as n from booking
      where created_at >= ${since.toISOString()} group by 1 order by 1`),
    db.select({ id: eventTypes.id, title: eventTypes.title, n: sql<number>`count(${bookings.id})::int` }).from(bookings)
      .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId)).where(gte(bookings.createdAt, since))
      .groupBy(eventTypes.id, eventTypes.title).orderBy(desc(sql`count(${bookings.id})`)).limit(10),
    db.execute(sql`select count(*)::int as total, count(*) filter (where starts_at > now() and status = 'confirmed')::int as upcoming from booking`),
  ]);
  const t = totals.rows[0] as { total: number; upcoming: number };
  return {
    days, total: t.total, upcoming: t.upcoming,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Record<string, number>,
    perDay: (perDay.rows as { day: string; n: number }[]).map((r) => ({ day: r.day, n: num(r.n) })),
    topEvents,
  };
}

// ───────── system health
export interface HealthReport {
  checkedAt: string;
  database: { ok: boolean; latencyMs: number | null; error?: string };
  redis: { ok: boolean; latencyMs: number | null; error?: string };
  queues: Awaited<ReturnType<typeof import("@/server/queue/stats").getQueueStats>> | null;
  queueError?: string;
  webhookFailures: { failed: number; dead: number; recent: { id: string; event: string; status: string; error: string | null; responseCode: number | null; createdAt: Date }[] };
}

const withTimeout = <T,>(p: Promise<T>, ms = 3000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

export async function getHealth(): Promise<HealthReport> {
  await connection();
  const database: HealthReport["database"] = { ok: false, latencyMs: null };
  let t = Date.now();
  try { await withTimeout(pool.query("select 1")); database.ok = true; database.latencyMs = Date.now() - t; } catch (e) { database.error = e instanceof Error ? e.message : "error"; }

  const redis: HealthReport["redis"] = { ok: false, latencyMs: null };
  let queues: HealthReport["queues"] = null;
  let queueError: string | undefined;
  try {
    const { getConnection } = await import("@/server/queue");
    t = Date.now();
    await withTimeout(getConnection().ping());
    redis.ok = true; redis.latencyMs = Date.now() - t;
    const { getQueueStats } = await import("@/server/queue/stats");
    queues = await withTimeout(getQueueStats(), 6000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (!redis.ok) redis.error = msg; else queueError = msg;
  }

  const [counts, recent] = await Promise.all([
    db.select({ status: schema.webhookDeliveries.status, n: sql<number>`count(*)::int` }).from(schema.webhookDeliveries)
      .where(inArray(schema.webhookDeliveries.status, ["failed", "dead"])).groupBy(schema.webhookDeliveries.status),
    db.select({
      id: schema.webhookDeliveries.id, event: schema.webhookDeliveries.event, status: schema.webhookDeliveries.status, error: schema.webhookDeliveries.error,
      responseCode: schema.webhookDeliveries.responseCode, createdAt: schema.webhookDeliveries.createdAt,
    }).from(schema.webhookDeliveries).where(inArray(schema.webhookDeliveries.status, ["failed", "dead"])).orderBy(desc(schema.webhookDeliveries.createdAt)).limit(10),
  ]);
  const c = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  return { checkedAt: new Date().toISOString(), database, redis, queues, queueError, webhookFailures: { failed: c.failed ?? 0, dead: c.dead ?? 0, recent } };
}

// ───────── audit log
export interface AuditFilter { actor?: string; action?: string; entity?: string; from?: string; to?: string; page?: number }
export async function listAudit(f: AuditFilter) {
  const conds: SQL[] = [];
  if (f.actor) conds.push(eq(auditLogs.actorId, f.actor));
  if (f.action) conds.push(ilike(auditLogs.action, `%${escLike(f.action)}%`));
  if (f.entity) conds.push(eq(auditLogs.entity, f.entity));
  const from = f.from ? new Date(f.from) : null, to = f.to ? new Date(f.to) : null;
  if (from && !Number.isNaN(from.getTime())) conds.push(gte(auditLogs.createdAt, from));
  if (to && !Number.isNaN(to.getTime())) conds.push(lte(auditLogs.createdAt, new Date(to.getTime() + 86_400_000 - 1)));
  const where = conds.length ? and(...conds) : undefined;
  const page = Math.max(1, f.page ?? 1);
  const [rows, [{ n }]] = await Promise.all([
    db.select({
      id: auditLogs.id, actorId: auditLogs.actorId, action: auditLogs.action, entity: auditLogs.entity, entityId: auditLogs.entityId,
      meta: auditLogs.meta, ip: auditLogs.ip, createdAt: auditLogs.createdAt, actorEmail: users.email,
    }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId)).where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(where),
  ]);
  return { rows, total: n, page, pages: Math.max(1, Math.ceil(n / PAGE_SIZE)) };
}

// ───────── platform configuration
export const CONFIG_FIELDS = {
  registrationOpen: { label: "Allow new sign-ups", type: "boolean", schema: z.boolean(), default: true },
  maintenanceMode: { label: "Maintenance mode (show banner)", type: "boolean", schema: z.boolean(), default: false },
  announcement: { label: "Announcement banner text", type: "text", schema: z.string().max(300), default: "" },
  supportEmail: { label: "Support email", type: "text", schema: z.string().max(200).refine((v) => v === "" || z.string().email().safeParse(v).success, "Invalid email"), default: "" },
  defaultPlanId: { label: "Default plan id for new accounts", type: "text", schema: z.string().max(40), default: "free" },
} as const;
export type ConfigKey = keyof typeof CONFIG_FIELDS;

export async function getPlatformConfig(): Promise<Record<ConfigKey, boolean | string>> {
  const rows = await db.select().from(platformSettings);
  const by = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, boolean | string> = {};
  for (const [k, f] of Object.entries(CONFIG_FIELDS)) {
    const v = by.get(k);
    out[k] = f.schema.safeParse(v).success ? (v as boolean | string) : f.default;
  }
  return out as Record<ConfigKey, boolean | string>;
}

export async function savePlatformConfig(actorId: string, values: Record<string, unknown>) {
  const before = await getPlatformConfig();
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, f] of Object.entries(CONFIG_FIELDS)) {
    if (!(k in values)) continue;
    const r = f.schema.safeParse(values[k]);
    if (!r.success) throw new AppError("VALIDATION", `${f.label}: ${r.error.issues[0]?.message ?? "invalid"}`, 422);
    if (r.data === before[k as ConfigKey]) continue;
    if (k === "defaultPlanId") {
      const [p] = await db.select({ id: subscriptionPlans.id }).from(subscriptionPlans).where(eq(subscriptionPlans.id, String(r.data))).limit(1);
      if (!p) throw new AppError("VALIDATION", "Default plan does not exist", 422);
    }
    await db.insert(platformSettings).values({ key: k, value: r.data, updatedBy: actorId })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: r.data, updatedBy: actorId, updatedAt: new Date() } });
    changes[k] = { from: before[k as ConfigKey], to: r.data };
  }
  if (Object.keys(changes).length) await audit(actorId, "admin.config.updated", { type: "platform_setting" }, { changes });
  return changes;
}
