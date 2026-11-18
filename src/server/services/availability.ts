import { and, asc, eq, gte, inArray, ne } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  blockedTimeSchema, createScheduleSchema, normTime, scheduleInputSchema, overridesSchema, weeklyRulesSchema,
  type BlockedTimeInput, type Interval, type OverrideInput, type WeeklyRules,
} from "@/lib/validation/availability";
import { assertWithinPlan } from "./plan-limits";

const { availabilitySchedules, availabilityRules, availabilityOverrides, blockedTimes, eventTypes } = schema;

export type ScheduleSummary = {
  id: string; name: string; timeZone: string; isDefault: boolean;
  rules: WeeklyRules; overrideCount: number; eventTypeCount: number; updatedAt: Date;
};
export type ScheduleDetail = Omit<ScheduleSummary, "overrideCount"> & { overrides: OverrideInput[] };

type Tx = Pick<Db, "select" | "insert" | "update" | "delete">;

function zodToApp(e: unknown): never {
  if (e && typeof e === "object" && "issues" in e) {
    const issues = (e as { issues: { message: string; path: PropertyKey[] }[] }).issues;
    throw new AppError("VALIDATION", issues[0]?.message ?? "Invalid input", 422, issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  throw e;
}
function parse<T>(schemaObj: { parse: (v: unknown) => T }, v: unknown): T {
  try { return schemaObj.parse(v); } catch (e) { return zodToApp(e); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownedSchedule(db: Tx, userId: string, id: string) {
  if (!UUID_RE.test(id)) throw new AppError("NOT_FOUND", "Schedule not found", 404);
  const [s] = await db.select().from(availabilitySchedules).where(eq(availabilitySchedules.id, id)).limit(1);
  if (!s) throw new AppError("NOT_FOUND", "Schedule not found", 404);
  if (s.userId !== userId) throw new AppError("FORBIDDEN", "You do not have access to this schedule", 403);
  return s;
}

const WEEKDAY_9_5: WeeklyRules = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" }));

async function loadRules(db: Tx, scheduleIds: string[]) {
  if (!scheduleIds.length) return [];
  return db.select().from(availabilityRules).where(inArray(availabilityRules.scheduleId, scheduleIds))
    .orderBy(asc(availabilityRules.weekday), asc(availabilityRules.startTime));
}

export async function listSchedules(userId: string, db: Db = defaultDb): Promise<ScheduleSummary[]> {
  const scheds = await db.select().from(availabilitySchedules).where(eq(availabilitySchedules.userId, userId))
    .orderBy(asc(availabilitySchedules.createdAt));
  const ids = scheds.map((s) => s.id);
  const rules = await loadRules(db, ids);
  const ovr = ids.length ? await db.select({ scheduleId: availabilityOverrides.scheduleId, date: availabilityOverrides.date })
    .from(availabilityOverrides).where(inArray(availabilityOverrides.scheduleId, ids)) : [];
  const ets = ids.length ? await db.select({ scheduleId: eventTypes.scheduleId }).from(eventTypes)
    .where(and(inArray(eventTypes.scheduleId, ids), eq(eventTypes.ownerUserId, userId))) : [];
  return scheds.map((s) => ({
    id: s.id, name: s.name, timeZone: s.timeZone, isDefault: s.isDefault, updatedAt: s.updatedAt,
    rules: rules.filter((r) => r.scheduleId === s.id).map((r) => ({ weekday: r.weekday, start: normTime(r.startTime), end: normTime(r.endTime) })),
    overrideCount: new Set(ovr.filter((o) => o.scheduleId === s.id).map((o) => o.date)).size,
    eventTypeCount: ets.filter((e) => e.scheduleId === s.id).length,
  }));
}

export async function getSchedule(userId: string, id: string, db: Db = defaultDb): Promise<ScheduleDetail> {
  const s = await ownedSchedule(db, userId, id);
  const rules = await loadRules(db, [id]);
  const ovr = await db.select().from(availabilityOverrides).where(eq(availabilityOverrides.scheduleId, id))
    .orderBy(asc(availabilityOverrides.date), asc(availabilityOverrides.startTime));
  const byDate = new Map<string, OverrideInput>();
  for (const o of ovr) {
    const cur = byDate.get(o.date) ?? { date: o.date, unavailable: false, intervals: [] as Interval[] };
    if (o.isUnavailable) cur.unavailable = true;
    else if (o.startTime && o.endTime) cur.intervals.push({ start: normTime(o.startTime), end: normTime(o.endTime) });
    byDate.set(o.date, cur);
  }
  const n = (await db.select({ id: eventTypes.id }).from(eventTypes).where(eq(eventTypes.scheduleId, id))).length;
  return {
    id: s.id, name: s.name, timeZone: s.timeZone, isDefault: s.isDefault, updatedAt: s.updatedAt, eventTypeCount: n,
    rules: rules.map((r) => ({ weekday: r.weekday, start: normTime(r.startTime), end: normTime(r.endTime) })),
    overrides: [...byDate.values()],
  };
}

export async function createSchedule(userId: string, input: unknown, db: Db = defaultDb): Promise<ScheduleDetail> {
  const v = parse(createScheduleSchema, input);
  await assertWithinPlan({ userId }, "maxSchedules", db);
  const id = await db.transaction(async (tx) => {
    const existing = await tx.select({ id: availabilitySchedules.id }).from(availabilitySchedules).where(eq(availabilitySchedules.userId, userId));
    const [row] = await tx.insert(availabilitySchedules)
      .values({ userId, name: v.name, timeZone: v.timeZone, isDefault: existing.length === 0 }).returning({ id: availabilitySchedules.id });
    if (v.template === "weekdays_9_5") {
      await tx.insert(availabilityRules).values(WEEKDAY_9_5.map((r) => ({ scheduleId: row.id, weekday: r.weekday, startTime: r.start, endTime: r.end })));
    }
    return row.id;
  });
  return getSchedule(userId, id, db);
}

/** Replace name, time zone, weekly rules and (if provided) date overrides atomically. */
export async function saveSchedule(userId: string, id: string, input: unknown, db: Db = defaultDb): Promise<ScheduleDetail> {
  const v = parse(scheduleInputSchema, input);
  await ownedSchedule(db, userId, id);
  await db.transaction(async (tx) => {
    await tx.update(availabilitySchedules).set({ name: v.name, timeZone: v.timeZone, updatedAt: new Date() }).where(eq(availabilitySchedules.id, id));
    await tx.delete(availabilityRules).where(eq(availabilityRules.scheduleId, id));
    if (v.rules.length) await tx.insert(availabilityRules).values(v.rules.map((r) => ({ scheduleId: id, weekday: r.weekday, startTime: r.start, endTime: r.end })));
    if (v.overrides) await writeOverrides(tx, id, v.overrides);
  });
  return getSchedule(userId, id, db);
}

async function writeOverrides(tx: Tx, scheduleId: string, overrides: OverrideInput[]) {
  await tx.delete(availabilityOverrides).where(eq(availabilityOverrides.scheduleId, scheduleId));
  const rows = overrides.flatMap((o): (typeof availabilityOverrides.$inferInsert)[] =>
    o.unavailable
      ? [{ scheduleId, date: o.date, isUnavailable: true, startTime: null, endTime: null }]
      : o.intervals.map((i) => ({ scheduleId, date: o.date, isUnavailable: false, startTime: i.start, endTime: i.end })),
  );
  if (rows.length) await tx.insert(availabilityOverrides).values(rows);
}

export async function setScheduleOverrides(userId: string, id: string, overrides: unknown, db: Db = defaultDb): Promise<ScheduleDetail> {
  const v = parse(overridesSchema, overrides);
  await ownedSchedule(db, userId, id);
  await db.transaction(async (tx) => {
    await writeOverrides(tx, id, v);
    await tx.update(availabilitySchedules).set({ updatedAt: new Date() }).where(eq(availabilitySchedules.id, id));
  });
  return getSchedule(userId, id, db);
}

export async function setWeeklyRules(userId: string, id: string, rules: unknown, db: Db = defaultDb): Promise<ScheduleDetail> {
  const v = parse(weeklyRulesSchema, rules);
  await ownedSchedule(db, userId, id);
  await db.transaction(async (tx) => {
    await tx.delete(availabilityRules).where(eq(availabilityRules.scheduleId, id));
    if (v.length) await tx.insert(availabilityRules).values(v.map((r) => ({ scheduleId: id, weekday: r.weekday, startTime: r.start, endTime: r.end })));
    await tx.update(availabilitySchedules).set({ updatedAt: new Date() }).where(eq(availabilitySchedules.id, id));
  });
  return getSchedule(userId, id, db);
}

export async function setDefaultSchedule(userId: string, id: string, db: Db = defaultDb): Promise<void> {
  await ownedSchedule(db, userId, id);
  await db.transaction(async (tx) => {
    await tx.update(availabilitySchedules).set({ isDefault: false }).where(and(eq(availabilitySchedules.userId, userId), ne(availabilitySchedules.id, id)));
    await tx.update(availabilitySchedules).set({ isDefault: true, updatedAt: new Date() }).where(eq(availabilitySchedules.id, id));
  });
}

export async function duplicateSchedule(userId: string, id: string, db: Db = defaultDb): Promise<ScheduleDetail> {
  const src = await getSchedule(userId, id, db);
  await assertWithinPlan({ userId }, "maxSchedules", db);
  const newId = await db.transaction(async (tx) => {
    const [row] = await tx.insert(availabilitySchedules).values({ userId, name: `${src.name} (copy)`.slice(0, 80), timeZone: src.timeZone, isDefault: false })
      .returning({ id: availabilitySchedules.id });
    if (src.rules.length) await tx.insert(availabilityRules).values(src.rules.map((r) => ({ scheduleId: row.id, weekday: r.weekday, startTime: r.start, endTime: r.end })));
    await writeOverrides(tx, row.id, src.overrides);
    return row.id;
  });
  return getSchedule(userId, newId, db);
}

export async function deleteSchedule(userId: string, id: string, db: Db = defaultDb): Promise<void> {
  const s = await ownedSchedule(db, userId, id);
  const all = await db.select({ id: availabilitySchedules.id, createdAt: availabilitySchedules.createdAt }).from(availabilitySchedules)
    .where(eq(availabilitySchedules.userId, userId)).orderBy(asc(availabilitySchedules.createdAt));
  if (all.length <= 1) throw new AppError("INVALID_STATE", "You need at least one schedule. Create another before deleting this one.", 409);
  await db.transaction(async (tx) => {
    await tx.delete(availabilitySchedules).where(eq(availabilitySchedules.id, id)); // event_type.schedule_id -> set null
    if (s.isDefault) {
      const next = all.find((a) => a.id !== id)!;
      await tx.update(availabilitySchedules).set({ isDefault: true }).where(eq(availabilitySchedules.id, next.id));
    }
  });
}

// ───────── blocked time (vacations)
export type BlockedTimeRow = { id: string; startsAt: Date; endsAt: Date; reason: string | null };

export async function listBlockedTimes(userId: string, opts: { includePast?: boolean } = {}, db: Db = defaultDb): Promise<BlockedTimeRow[]> {
  const where = opts.includePast ? eq(blockedTimes.userId, userId) : and(eq(blockedTimes.userId, userId), gte(blockedTimes.endsAt, new Date()));
  return db.select({ id: blockedTimes.id, startsAt: blockedTimes.startsAt, endsAt: blockedTimes.endsAt, reason: blockedTimes.reason })
    .from(blockedTimes).where(where).orderBy(asc(blockedTimes.startsAt));
}

export async function createBlockedTime(userId: string, input: unknown, db: Db = defaultDb): Promise<BlockedTimeRow> {
  const v: BlockedTimeInput = parse(blockedTimeSchema, input);
  const [row] = await db.insert(blockedTimes).values({ userId, startsAt: new Date(v.startsAt), endsAt: new Date(v.endsAt), reason: v.reason || null })
    .returning({ id: blockedTimes.id, startsAt: blockedTimes.startsAt, endsAt: blockedTimes.endsAt, reason: blockedTimes.reason });
  return row;
}

export async function deleteBlockedTime(userId: string, id: string, db: Db = defaultDb): Promise<void> {
  const [b] = await db.select().from(blockedTimes).where(eq(blockedTimes.id, id)).limit(1);
  if (!b) throw new AppError("NOT_FOUND", "Blocked period not found", 404);
  if (b.userId !== userId) throw new AppError("FORBIDDEN", "You do not have access to this blocked period", 403);
  await db.delete(blockedTimes).where(eq(blockedTimes.id, id));
}
