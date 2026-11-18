import { and, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";
import { toCsv } from "./contacts";

const { bookings, eventTypes, organizationMembers, pageViews, payments, refunds, users } = schema;

export interface AnalyticsRange { from: Date; to: Date } // [from, to)
export interface AnalyticsQuery { timeZone: string; from?: Date; to?: Date; eventTypeId?: string }

export type Bucket = "day" | "week" | "month";
export interface AnalyticsReport {
  range: { from: string; to: string; timeZone: string; bucket: Bucket };
  totals: {
    total: number; byStatus: Record<string, number>; cancelled: number; rescheduled: number; noShow: number; completed: number;
    /** completed / (completed + no_show + cancelled); null when there is nothing to measure. */
    completionRate: number | null;
    /** cancelled / (all bookings except rescheduled and expired) */
    cancellationRate: number | null;
  };
  byEventType: { id: string; title: string; color: string | null; total: number; completed: number; cancelled: number }[];
  byHost: { id: string; name: string; total: number; completed: number; cancelled: number }[];
  /** Page views vs bookings made (by creation time) in the range. Views are raw hits, not unique visitors. */
  conversion: { pageViews: number; bookingsMade: number; rate: number | null; estimate: true; perEventType: { id: string; title: string; views: number; bookings: number; rate: number | null }[] };
  revenue: { currency: string; paid: number; refunded: number; payments: number }[];
  /** Counts of scheduled meetings (excludes cancelled/rescheduled/expired/unpaid holds), in the viewer's time zone. */
  weekdays: { weekday: number; label: string; count: number }[];
  hours: { hour: number; count: number }[];
  trend: { bucket: string; total: number; completed: number; cancelled: number }[];
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SCHEDULED = ["confirmed", "completed", "no_show"] as const;
const MAX_RANGE_DAYS = 800;

export const pct = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export function resolveRange(q: AnalyticsQuery, now = new Date()): { from: Date; to: Date; zone: string; bucket: Bucket } {
  const zone = DateTime.local().setZone(q.timeZone).isValid ? q.timeZone : "UTC";
  const endLocal = q.to ? DateTime.fromJSDate(q.to, { zone }) : DateTime.fromJSDate(now, { zone });
  const to = q.to ?? endLocal.plus({ days: 1 }).startOf("day").toJSDate();
  const from = q.from ?? DateTime.fromJSDate(to, { zone }).minus({ days: 30 }).startOf("day").toJSDate();
  if (!(from < to)) throw new AppError("VALIDATION", "Start date must be before end date", 422);
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > MAX_RANGE_DAYS) throw new AppError("VALIDATION", `Date range is limited to ${MAX_RANGE_DAYS} days`, 422);
  return { from, to, zone, bucket: days <= 92 ? "day" : days <= 400 ? "week" : "month" };
}

async function adminOrgIds(userId: string, db: Db): Promise<string[]> {
  return (await db.select({ id: organizationMembers.organizationId }).from(organizationMembers)
    .where(and(eq(organizationMembers.userId, userId), inArray(organizationMembers.role, ["owner", "admin"])))).map((r) => r.id);
}

/** Real numbers only, straight from the DB. Collective "linked" rows (one per extra host) are excluded so a meeting counts once. */
export async function getAnalytics(userId: string, query: AnalyticsQuery, db: Db = defaultDb, now = new Date()): Promise<AnalyticsReport> {
  const { from, to, zone, bucket } = resolveRange(query, now);
  const orgs = await adminOrgIds(userId, db);
  const base: SQL[] = [
    (orgs.length ? or(eq(bookings.hostUserId, userId), inArray(bookings.organizationId, orgs)) : eq(bookings.hostUserId, userId)) as SQL,
    sql`not (${bookings.externalEventIds} ? 'collectiveOf')`,
  ];
  if (query.eventTypeId) base.push(eq(bookings.eventTypeId, query.eventTypeId));
  const inRange = and(...base, gte(bookings.startsAt, from), lt(bookings.startsAt, to)) as SQL;
  const completed = sql<number>`count(*) filter (where ${bookings.status} = 'completed')::int`;
  const cancelled = sql<number>`count(*) filter (where ${bookings.status} = 'cancelled')::int`;
  const local = sql`(${bookings.startsAt} at time zone ${zone}::text)`;

  const [statusRows, typeRows, hostRows, weekdayRows, hourRows, trendRows, made, viewsRows, payRows, refundRows] = await Promise.all([
    db.select({ status: bookings.status, n: sql<number>`count(*)::int` }).from(bookings).where(inRange).groupBy(bookings.status),
    db.select({ id: eventTypes.id, title: eventTypes.title, color: eventTypes.color, total: sql<number>`count(*)::int`, completed, cancelled })
      .from(bookings).innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId)).where(inRange)
      .groupBy(eventTypes.id, eventTypes.title, eventTypes.color).orderBy(sql`count(*) desc`, eventTypes.title).limit(50),
    db.select({ id: users.id, name: users.name, total: sql<number>`count(*)::int`, completed, cancelled })
      .from(bookings).innerJoin(users, eq(users.id, bookings.hostUserId)).where(inRange)
      .groupBy(users.id, users.name).orderBy(sql`count(*) desc`, users.name).limit(50),
    db.select({ k: sql<number>`extract(isodow from ${local})::int`, n: sql<number>`count(*)::int` }).from(bookings)
      .where(and(inRange, inArray(bookings.status, [...SCHEDULED]))).groupBy(sql`1`),
    db.select({ k: sql<number>`extract(hour from ${local})::int`, n: sql<number>`count(*)::int` }).from(bookings)
      .where(and(inRange, inArray(bookings.status, [...SCHEDULED]))).groupBy(sql`1`),
    db.select({
      k: sql<string>`to_char(date_trunc(${sql.raw(`'${bucket}'`)}, ${local}), 'YYYY-MM-DD')`,
      total: sql<number>`count(*)::int`, completed, cancelled,
    }).from(bookings).where(inRange).groupBy(sql`1`).orderBy(sql`1`),
    // bookings made in range (creation time), excluding reschedule replacements: those are not new demand
    db.select({ id: bookings.eventTypeId, n: sql<number>`count(*)::int` }).from(bookings)
      .where(and(...base, gte(bookings.createdAt, from), lt(bookings.createdAt, to), isNull(bookings.rescheduledFromId))).groupBy(bookings.eventTypeId),
    db.select({ id: pageViews.eventTypeId, n: sql<number>`count(*)::int` }).from(pageViews)
      .innerJoin(eventTypes, eq(eventTypes.id, pageViews.eventTypeId))
      .where(and(gte(pageViews.createdAt, from), lt(pageViews.createdAt, to), query.eventTypeId ? eq(pageViews.eventTypeId, query.eventTypeId) : undefined,
        (orgs.length ? or(eq(eventTypes.ownerUserId, userId), inArray(eventTypes.organizationId, orgs)) : eq(eventTypes.ownerUserId, userId))))
      .groupBy(pageViews.eventTypeId),
    db.select({ currency: payments.currency, paid: sql<number>`coalesce(sum(${payments.amount}),0)::int`, n: sql<number>`count(*)::int` })
      .from(payments).innerJoin(bookings, eq(bookings.id, payments.bookingId))
      .where(and(...base, eq(payments.status, "paid"), gte(payments.createdAt, from), lt(payments.createdAt, to))).groupBy(payments.currency),
    db.select({ currency: payments.currency, refunded: sql<number>`coalesce(sum(${refunds.amount}),0)::int` })
      .from(refunds).innerJoin(payments, eq(payments.id, refunds.paymentId)).innerJoin(bookings, eq(bookings.id, payments.bookingId))
      .where(and(...base, gte(refunds.createdAt, from), lt(refunds.createdAt, to))).groupBy(payments.currency),
  ]);

  const byStatus: Record<string, number> = Object.fromEntries(
    ["pending_payment", "pending_confirmation", "confirmed", "completed", "cancelled", "rescheduled", "no_show", "expired"].map((s) => [s, 0]));
  let total = 0;
  for (const r of statusRows) { byStatus[r.status] = r.n; total += r.n; }
  const c = byStatus.completed!, nc = byStatus.cancelled!, ns = byStatus.no_show!;

  const weekdays = DAY_LABELS.map((label, i) => ({ weekday: i + 1, label, count: weekdayRows.find((r) => r.k === i + 1)?.n ?? 0 }));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourRows.find((r) => r.k === h)?.n ?? 0 }));

  // fill empty buckets so the trend has a continuous axis
  const byBucket = new Map(trendRows.map((r) => [r.k, r]));
  const trend: AnalyticsReport["trend"] = [];
  let cur = DateTime.fromJSDate(from, { zone }).startOf(bucket);
  const end = DateTime.fromJSDate(to, { zone });
  for (let i = 0; cur < end && i < 1000; i++) {
    const key = cur.toFormat("yyyy-MM-dd");
    const r = byBucket.get(key);
    trend.push({ bucket: key, total: r?.total ?? 0, completed: r?.completed ?? 0, cancelled: r?.cancelled ?? 0 });
    cur = cur.plus({ [bucket + "s"]: 1 });
  }

  const madeBy = new Map(made.map((r) => [r.id, r.n]));
  const viewsBy = new Map(viewsRows.filter((r) => r.id).map((r) => [r.id!, r.n]));
  const titles = new Map(typeRows.map((t) => [t.id, t.title]));
  const missing = [...new Set([...madeBy.keys(), ...viewsBy.keys()])].filter((id) => !titles.has(id));
  if (missing.length) {
    for (const t of await db.select({ id: eventTypes.id, title: eventTypes.title }).from(eventTypes).where(inArray(eventTypes.id, missing))) titles.set(t.id, t.title);
  }
  const perEventType = [...new Set([...madeBy.keys(), ...viewsBy.keys()])].map((id) => ({
    id, title: titles.get(id) ?? "Unknown", views: viewsBy.get(id) ?? 0, bookings: madeBy.get(id) ?? 0,
    rate: pct(madeBy.get(id) ?? 0, viewsBy.get(id) ?? 0),
  })).sort((a, b) => b.views - a.views);
  const pv = perEventType.reduce((s, r) => s + r.views, 0), bm = perEventType.reduce((s, r) => s + r.bookings, 0);

  const refMap = new Map(refundRows.map((r) => [r.currency, r.refunded]));
  const currencies = new Set([...payRows.map((p) => p.currency), ...refMap.keys()]);
  const revenue = [...currencies].sort().map((currency) => {
    const p = payRows.find((x) => x.currency === currency);
    return { currency, paid: p?.paid ?? 0, refunded: refMap.get(currency) ?? 0, payments: p?.n ?? 0 };
  });

  return {
    range: { from: from.toISOString(), to: to.toISOString(), timeZone: zone, bucket },
    totals: {
      total, byStatus, cancelled: nc, rescheduled: byStatus.rescheduled!, noShow: ns, completed: c,
      completionRate: pct(c, c + ns + nc),
      cancellationRate: pct(nc, total - byStatus.rescheduled! - byStatus.expired!),
    },
    byEventType: typeRows, byHost: hostRows,
    conversion: { pageViews: pv, bookingsMade: bm, rate: pct(bm, pv), estimate: true, perEventType },
    revenue, weekdays, hours, trend,
  };
}

export async function exportAnalyticsCsv(userId: string, query: AnalyticsQuery, db: Db = defaultDb): Promise<string> {
  const r = await getAnalytics(userId, query, db);
  const rows: unknown[][] = [];
  rows.push(["Range (UTC)", `${r.range.from} to ${r.range.to}`, "", "", ""], ["Time zone", r.range.timeZone, "", "", ""]);
  for (const [s, n] of Object.entries(r.totals.byStatus)) rows.push(["Status", s, n, "", ""]);
  rows.push(["Completion rate", r.totals.completionRate === null ? "" : (r.totals.completionRate * 100).toFixed(1) + "%", "", "", ""]);
  for (const t of r.byEventType) rows.push(["Event type", t.title, t.total, t.completed, t.cancelled]);
  for (const h of r.byHost) rows.push(["Host", h.name, h.total, h.completed, h.cancelled]);
  for (const w of r.weekdays) rows.push(["Weekday", w.label, w.count, "", ""]);
  for (const h of r.hours) rows.push(["Hour", `${String(h.hour).padStart(2, "0")}:00`, h.count, "", ""]);
  for (const t of r.trend) rows.push([`Trend (${r.range.bucket})`, t.bucket, t.total, t.completed, t.cancelled]);
  for (const v of r.conversion.perEventType) rows.push(["Conversion (estimate)", v.title, v.views, v.bookings, v.rate === null ? "" : (v.rate * 100).toFixed(1) + "%"]);
  for (const v of r.revenue) rows.push(["Revenue (minor units)", v.currency, v.paid, v.refunded, v.payments]);
  return toCsv(["Section", "Label", "Value / Total", "Completed / Bookings / Refunded", "Cancelled / Rate / Payments"], rows);
}
