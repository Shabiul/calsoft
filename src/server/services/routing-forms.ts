import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  evaluateRoute, extractPrefill, formConfigSchema, validateAnswers, validateConfig,
  type Answers, type Destination, type FormConfig, type RoutingField,
} from "./routing-eval";

const { routingForms, routingSubmissions, eventTypes, organizationMembers, organizations, users } = schema;

export type RoutingFormRow = typeof routingForms.$inferSelect;
export interface RoutingFormDto {
  id: string; slug: string; name: string; config: FormConfig; createdAt: string; submissionCount?: number;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "form";
}

function parseConfig(row: Pick<RoutingFormRow, "fields" | "rules" | "fallback">): FormConfig {
  const r = formConfigSchema.safeParse({ fields: row.fields, rules: row.rules, fallback: row.fallback ?? null });
  // A stored config that no longer parses is treated as empty rather than crashing list pages.
  return r.success ? r.data : { fields: [], rules: [], fallback: null };
}
const toDto = (row: RoutingFormRow, submissionCount?: number): RoutingFormDto => ({
  id: row.id, slug: row.slug, name: row.name, config: parseConfig(row), createdAt: row.createdAt.toISOString(), submissionCount,
});

/** Event types a user may route to: their own + those of orgs they belong to. */
export async function listRoutableEventTypes(userId: string, db: Db = defaultDb) {
  const orgIds = (await db.select({ id: organizationMembers.organizationId }).from(organizationMembers).where(eq(organizationMembers.userId, userId))).map((r) => r.id);
  const rows = await db.select({ id: eventTypes.id, title: eventTypes.title, slug: eventTypes.slug, color: eventTypes.color })
    .from(eventTypes)
    .where(and(
      isNull(eventTypes.deletedAt), isNull(eventTypes.archivedAt),
      or(eq(eventTypes.ownerUserId, userId), orgIds.length ? inArray(eventTypes.organizationId, orgIds) : sql`false`),
    )).orderBy(eventTypes.title);
  return rows;
}

async function assertEventsRoutable(userId: string, config: FormConfig, db: Db) {
  const ids = new Set<string>();
  for (const r of config.rules) if (r.destination.type === "event") ids.add(r.destination.eventTypeId);
  if (config.fallback?.type === "event") ids.add(config.fallback.eventTypeId);
  if (!ids.size) return;
  const allowed = new Set((await listRoutableEventTypes(userId, db)).map((e) => e.id));
  for (const id of ids) if (!allowed.has(id)) throw new AppError("VALIDATION", "A rule points to an event type you cannot use", 422, [{ path: "rules", message: "Unknown or unavailable event type" }]);
}

function parseOrThrow(input: unknown): FormConfig {
  const parsed = formConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid form", 422,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const issues = validateConfig(parsed.data);
  if (issues.length) throw new AppError("VALIDATION", issues[0]!.message, 422, issues);
  return parsed.data;
}

export async function listForms(userId: string, db: Db = defaultDb): Promise<RoutingFormDto[]> {
  const rows = await db.select().from(routingForms).where(eq(routingForms.ownerUserId, userId)).orderBy(desc(routingForms.createdAt));
  if (!rows.length) return [];
  const counts = await db.select({ formId: routingSubmissions.formId, n: sql<number>`count(*)::int` })
    .from(routingSubmissions).where(inArray(routingSubmissions.formId, rows.map((r) => r.id))).groupBy(routingSubmissions.formId);
  const m = new Map(counts.map((c) => [c.formId, c.n]));
  return rows.map((r) => toDto(r, m.get(r.id) ?? 0));
}

export async function getForm(userId: string, id: string, db: Db = defaultDb): Promise<RoutingFormDto> {
  const [row] = await db.select().from(routingForms).where(and(eq(routingForms.id, id), eq(routingForms.ownerUserId, userId))).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Routing form not found", 404);
  return toDto(row);
}

export async function createForm(userId: string, input: { name: string; slug?: string; config?: unknown }, db: Db = defaultDb): Promise<RoutingFormDto> {
  const name = input.name?.trim();
  if (!name || name.length > 120) throw new AppError("VALIDATION", "Name is required (max 120 characters)", 422);
  const slug = (input.slug?.trim() || slugify(name)).toLowerCase();
  if (!SLUG_RE.test(slug)) throw new AppError("VALIDATION", "Slug may contain lowercase letters, digits and dashes", 422);
  const config = input.config
    ? parseOrThrow(input.config)
    : { fields: [{ id: "name", label: "Name", type: "short_text" as const, required: true }, { id: "email", label: "Email", type: "email" as const, required: true }], rules: [], fallback: null };
  await assertEventsRoutable(userId, config, db);
  try {
    const [row] = await db.insert(routingForms).values({ ownerUserId: userId, slug, name, fields: config.fields, rules: config.rules, fallback: config.fallback }).returning();
    return toDto(row!);
  } catch (e) {
    if ((e as { code?: string; cause?: { code?: string } })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505") {
      throw new AppError("CONFLICT", "You already have a form with this slug", 409);
    }
    throw e;
  }
}

export async function updateForm(userId: string, id: string, input: { name: string; slug: string; config: unknown }, db: Db = defaultDb): Promise<RoutingFormDto> {
  await getForm(userId, id, db);
  const name = input.name?.trim();
  if (!name || name.length > 120) throw new AppError("VALIDATION", "Name is required (max 120 characters)", 422);
  const slug = input.slug?.trim().toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) throw new AppError("VALIDATION", "Slug may contain lowercase letters, digits and dashes", 422);
  const config = parseOrThrow(input.config);
  await assertEventsRoutable(userId, config, db);
  try {
    const [row] = await db.update(routingForms).set({ name, slug, fields: config.fields, rules: config.rules, fallback: config.fallback })
      .where(and(eq(routingForms.id, id), eq(routingForms.ownerUserId, userId))).returning();
    return toDto(row!);
  } catch (e) {
    if ((e as { code?: string })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505") {
      throw new AppError("CONFLICT", "You already have a form with this slug", 409);
    }
    throw e;
  }
}

export async function deleteForm(userId: string, id: string, db: Db = defaultDb): Promise<void> {
  const r = await db.delete(routingForms).where(and(eq(routingForms.id, id), eq(routingForms.ownerUserId, userId))).returning({ id: routingForms.id });
  if (!r.length) throw new AppError("NOT_FOUND", "Routing form not found", 404);
}

export interface SubmissionDto {
  id: string; createdAt: string; name: string | null; email: string | null; answers: Answers;
  outcome: { type: string; source: string; ruleIndex?: number; eventTypeId?: string; url?: string; message?: string; unavailable?: boolean };
}

export async function listSubmissions(userId: string, formId: string, opts: { page?: number; pageSize?: number } = {}, db: Db = defaultDb) {
  await getForm(userId, formId, db);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(routingSubmissions).where(eq(routingSubmissions.formId, formId));
  const rows = await db.select().from(routingSubmissions).where(eq(routingSubmissions.formId, formId))
    .orderBy(desc(routingSubmissions.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  return {
    total: n, page, pageSize,
    rows: rows.map((r): SubmissionDto => ({
      id: r.id, createdAt: r.createdAt.toISOString(), name: r.name, email: r.email, answers: r.answers,
      outcome: r.outcome as SubmissionDto["outcome"],
    })),
  };
}

// ───────── public

export interface PublicFormDto { id: string; name: string; hostName: string; fields: RoutingField[] }

export async function loadPublicForm(username: string, slug: string, db: Db = defaultDb): Promise<PublicFormDto | null> {
  const [u] = await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.username, username.toLowerCase()), isNull(users.deletedAt), eq(users.status, "active"))).limit(1);
  if (!u) return null;
  const [row] = await db.select().from(routingForms).where(and(eq(routingForms.ownerUserId, u.id), eq(routingForms.slug, slug.toLowerCase()))).limit(1);
  if (!row) return null;
  const cfg = parseConfig(row);
  if (!cfg.fields.length) return null;
  return { id: row.id, name: row.name, hostName: u.name, fields: cfg.fields };
}

export type PublicRouteResult =
  | { kind: "redirect"; url: string; external: boolean }
  | { kind: "message"; title: string; message: string };

async function resolveDestination(d: Destination, answers: Answers, fields: RoutingField[], db: Db): Promise<
  { result: PublicRouteResult; stored: Record<string, unknown> }
> {
  if (d.type === "message") return { result: { kind: "message", title: d.title || "Thanks!", message: d.message }, stored: { type: "message", message: d.message } };
  if (d.type === "url") return { result: { kind: "redirect", url: d.url, external: true }, stored: { type: "url", url: d.url } };
  const [e] = await db.select({
    slug: eventTypes.slug, isActive: eventTypes.isActive, deletedAt: eventTypes.deletedAt, archivedAt: eventTypes.archivedAt,
    ownerUserId: eventTypes.ownerUserId, orgId: eventTypes.organizationId,
  }).from(eventTypes).where(eq(eventTypes.id, d.eventTypeId)).limit(1);
  let prefix: string | null = null;
  if (e && e.isActive && !e.deletedAt && !e.archivedAt) {
    if (e.ownerUserId) {
      const [o] = await db.select({ username: users.username }).from(users).where(eq(users.id, e.ownerUserId)).limit(1);
      prefix = o?.username ?? null;
    } else if (e.orgId) {
      const [o] = await db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, e.orgId)).limit(1);
      prefix = o?.slug ?? null;
    }
  }
  if (!e || !prefix) {
    return {
      result: { kind: "message", title: "Currently unavailable", message: "The meeting this form routes to is not available right now. Please contact the host directly." },
      stored: { type: "event", eventTypeId: d.eventTypeId, unavailable: true },
    };
  }
  const pre = extractPrefill(fields, answers);
  const qs = new URLSearchParams();
  if (pre.name) qs.set("name", pre.name);
  if (pre.email) qs.set("email", pre.email);
  const q = qs.toString();
  return {
    result: { kind: "redirect", url: `/${prefix}/${e.slug}${q ? `?${q}` : ""}`, external: false },
    stored: { type: "event", eventTypeId: d.eventTypeId },
  };
}

/** Validate answers, evaluate rules, persist the submission and return where to send the visitor. */
export async function submitPublicForm(username: string, slug: string, raw: Answers, db: Db = defaultDb): Promise<
  { ok: true; result: PublicRouteResult } | { ok: false; errors: Record<string, string> }
> {
  const [u] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.username, username.toLowerCase()), isNull(users.deletedAt), eq(users.status, "active"))).limit(1);
  if (!u) throw new AppError("NOT_FOUND", "Form not found", 404);
  const [row] = await db.select().from(routingForms).where(and(eq(routingForms.ownerUserId, u.id), eq(routingForms.slug, slug.toLowerCase()))).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Form not found", 404);
  const cfg = parseConfig(row);

  const v = validateAnswers(cfg.fields, raw);
  if (!v.ok) return { ok: false, errors: v.errors };

  const route = evaluateRoute(cfg, v.answers);
  const pre = extractPrefill(cfg.fields, v.answers);
  let result: PublicRouteResult;
  let stored: Record<string, unknown>;
  if (route.destination) {
    const r = await resolveDestination(route.destination, v.answers, cfg.fields, db);
    result = r.result;
    stored = { ...r.stored, source: route.source, ...(route.source === "rule" ? { ruleIndex: route.ruleIndex } : {}) };
  } else {
    result = { kind: "message", title: "Thanks!", message: "Thanks, we received your response and will be in touch." };
    stored = { type: "none", source: "none" };
  }
  await db.insert(routingSubmissions).values({
    formId: row.id, answers: v.answers, outcome: stored, email: pre.email?.toLowerCase() ?? null, name: pre.name ?? null,
  });
  return { ok: true, result };
}
