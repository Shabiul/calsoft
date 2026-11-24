/**
 * Team insights for managers, team leads and admins (read only, same scope as Team activity: team leads see themselves and their
 * direct reports). Two views: who is free when (a weekday x hour heatmap in the viewer's time zone), and each person's workload.
 */
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { requireOversight } from "./team-oversight";

const { organizationMembers, users, bookings, availabilitySchedules, availabilityRules } = schema;
const DAY = 86_400_000;

export interface HeatRule { timeZone: string; weekday: number; startTime: string; endTime: string }

/**
 * counts[weekday][hour] = how many people are available that hour (weekday 0 = Sunday), expressed in `viewerZone`.
 * Each person's weekly rules are converted from their own schedule zone using a reference week, so a 9-17 schedule in London shows up
 * at the right hours for a viewer in Lagos. Rules that wrap past midnight in the viewer's zone are split across both days.
 */
export function computeHeatmap(peopleRules: HeatRule[][], viewerZone: string, ref = DateTime.utc()): number[][] {
  const counts = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const sundayLocal = ref.setZone(viewerZone).startOf("week").minus({ days: 1 }); // Sunday of the reference week
  for (const rules of peopleRules) {
    const covered = new Set<string>(); // a person counts once per hour even with several overlapping rules
    for (const r of rules) {
      const [sh, sm] = r.startTime.split(":").map(Number), [eh, em] = r.endTime.split(":").map(Number);
      const day = DateTime.fromObject({ year: sundayLocal.year, month: sundayLocal.month, day: sundayLocal.day }, { zone: r.timeZone }).plus({ days: r.weekday });
      const start = day.set({ hour: sh, minute: sm }), end = day.set({ hour: eh, minute: em });
      if (!start.isValid || !end.isValid || end <= start) continue;
      for (let t = start.setZone(viewerZone).startOf("hour"); t < end; t = t.plus({ hours: 1 })) {
        // an hour counts when at least half of it is inside the rule
        const overlap = Math.min(end.toMillis(), t.toMillis() + 3_600_000) - Math.max(start.toMillis(), t.toMillis());
        if (overlap < 1_800_000) continue;
        const local = t.setZone(viewerZone);
        covered.add(`${local.weekday % 7}:${local.hour}`); // luxon: Mon=1..Sun=7 -> Sun=0
      }
    }
    for (const k of covered) { const [w, h] = k.split(":").map(Number); counts[w!]![h!]!++; }
  }
  return counts;
}

export interface WorkloadRow {
  userId: string; name: string; role: string; timeZone: string;
  total: number; completed: number; cancelled: number; noShow: number; perWeek: number; next7d: number;
}

export async function getTeamInsights(viewerId: string, orgId: string, viewerZone: string, now = new Date(), db: Db = defaultDb) {
  const { role: viewerRole, orgName } = await requireOversight(viewerId, orgId, db);
  const all = await db.select({ userId: users.id, name: users.name, role: organizationMembers.role, timeZone: users.timeZone, managerUserId: organizationMembers.managerUserId })
    .from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, orgId), isNull(users.deletedAt), eq(users.status, "active")));
  const people = all.filter((m) => viewerRole !== "team_lead" || m.userId === viewerId || m.managerUserId === viewerId);
  const ids = people.map((p) => p.userId);
  const zone = DateTime.local().setZone(viewerZone).isValid ? viewerZone : "UTC";
  if (!ids.length) return { orgName, viewerRole, viewerZone: zone, heatmap: computeHeatmap([], zone), people: 0, workload: [] as WorkloadRow[], windowDays: 28 };

  const since = new Date(now.getTime() - 28 * DAY), next7 = new Date(now.getTime() + 7 * DAY);
  const rules = await db.select({ userId: availabilitySchedules.userId, timeZone: availabilitySchedules.timeZone, weekday: availabilityRules.weekday, startTime: availabilityRules.startTime, endTime: availabilityRules.endTime })
    .from(availabilitySchedules).innerJoin(availabilityRules, eq(availabilityRules.scheduleId, availabilitySchedules.id))
    .where(and(inArray(availabilitySchedules.userId, ids), eq(availabilitySchedules.isDefault, true)));
  const byUser = new Map<string, HeatRule[]>();
  for (const r of rules) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  const heatmap = computeHeatmap(ids.map((i) => byUser.get(i) ?? []), zone);

  const past = (extra: ReturnType<typeof sql>) => sql<number>`count(*) filter (where ${bookings.startsAt} >= ${since} and ${bookings.startsAt} < ${now} and ${extra})::int`;
  const stats = await db.select({
    hostUserId: bookings.hostUserId,
    total: past(sql`${bookings.status} <> 'cancelled'`),
    completed: past(sql`${bookings.status} = 'completed'`),
    cancelled: past(sql`${bookings.status} = 'cancelled'`),
    noShow: past(sql`${bookings.status} = 'no_show'`),
    next7d: sql<number>`count(*) filter (where ${bookings.startsAt} >= ${now} and ${bookings.status} in ('confirmed','pending_confirmation'))::int`,
  }).from(bookings).where(and(inArray(bookings.hostUserId, ids), gte(bookings.startsAt, since), lt(bookings.startsAt, next7))).groupBy(bookings.hostUserId);
  const m = new Map(stats.map((s) => [s.hostUserId, s]));
  const workload: WorkloadRow[] = people.map((p) => {
    const s = m.get(p.userId);
    return { userId: p.userId, name: p.name, role: p.role, timeZone: p.timeZone, total: s?.total ?? 0, completed: s?.completed ?? 0, cancelled: s?.cancelled ?? 0, noShow: s?.noShow ?? 0,
      perWeek: Math.round(((s?.total ?? 0) / 4) * 10) / 10, next7d: s?.next7d ?? 0 };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { orgName, viewerRole, viewerZone: zone, heatmap, people: people.length, workload, windowDays: 28 };
}
