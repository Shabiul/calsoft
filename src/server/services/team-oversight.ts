/**
 * Team oversight for managers and team leads (and admins/owners): who signed in and when, who is meeting whom, and each person's
 * working hours. READ-ONLY. Every function checks the viewer's role in THAT organization (never trusts the caller), and a member's
 * detail page is audit-logged ("oversight.member_viewed") so people can ask who looked at their data.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";
import { canOversee, ROLE_RANK, type OrgRole } from "@/lib/org-roles";
import { describeDevice } from "@/lib/sign-in-info";

const { organizations, organizationMembers, users, bookings, eventTypes, invitees, signInLogs, sessions, accounts, availabilitySchedules,
  availabilityRules, availabilityOverrides, connectedCalendars, auditLogs } = schema;

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const LIVE = ["confirmed", "pending_confirmation", "pending_payment"] as const;
const DAY = 86_400_000;

export interface OversightOrg { id: string; name: string; role: OrgRole }

/** Organizations where this user may view the team's sign-ins, meetings and schedules. */
export async function listOversightOrgs(userId: string, db: Db = defaultDb): Promise<OversightOrg[]> {
  const rows = await db.select({ id: organizations.id, name: organizations.name, role: organizationMembers.role })
    .from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt)));
  return rows.filter((r) => canOversee(r.role)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function requireOversight(viewerId: string, orgId: string, db: Db): Promise<{ role: OrgRole; orgName: string }> {
  if (!isUuid(orgId)) throw new AppError("NOT_FOUND", "Team not found", 404);
  const [m] = await db.select({ role: organizationMembers.role, orgName: organizations.name })
    .from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, viewerId), eq(organizationMembers.organizationId, orgId), isNull(organizations.deletedAt))).limit(1);
  if (!m) throw new AppError("NOT_FOUND", "Team not found", 404); // do not reveal that the team exists
  if (!canOversee(m.role)) throw new AppError("FORBIDDEN", "Only managers, team leads and admins can view team activity", 403);
  return m;
}

export interface OverviewMember {
  userId: string; name: string; email: string; image: string | null; role: OrgRole; status: string; timeZone: string;
  lastSignInAt: Date | null; lastSignInMethod: string | null; signIns30d: number; lastActiveAt: Date;
  meetingsNext24h: number; meetingsNext7d: number; nextMeetingAt: Date | null;
}
export interface RecentSignIn { userId: string; name: string; provider: string | null; device: string | null; at: Date }

export async function getTeamOverview(viewerId: string, orgId: string, now = new Date(), db: Db = defaultDb) {
  const { role: viewerRole, orgName } = await requireOversight(viewerId, orgId, db);
  const allMembers = await db.select({
    userId: users.id, name: users.name, email: users.email, image: users.image, role: organizationMembers.role,
    status: users.status, timeZone: users.timeZone, lastActiveAt: users.lastActiveAt, managerUserId: organizationMembers.managerUserId,
  }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, orgId), isNull(users.deletedAt)));
  // Team leads see themselves and the people who report to them; managers, admins and owners see everyone.
  const members = allMembers.filter((m) => viewerRole !== "team_lead" || m.userId === viewerId || m.managerUserId === viewerId);
  const ids = members.map((m) => m.userId);
  const since30 = new Date(now.getTime() - 30 * DAY);

  const lastLogin = new Map<string, { at: Date; provider: string | null }>();
  const count30 = new Map<string, number>();
  const meet = new Map<string, { n24: number; n7: number; next: Date | null }>();
  let recent: RecentSignIn[] = [];
  if (ids.length) {
    const last = await db.execute(sql`
      select distinct on (user_id) user_id, provider, created_at from sign_in_log
      where event = 'sign_in' and user_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) order by user_id, created_at desc`);
    for (const r of last.rows as { user_id: string; provider: string | null; created_at: string | Date }[]) lastLogin.set(r.user_id, { at: new Date(r.created_at), provider: r.provider });
    // Accounts that signed in before the log existed: fall back to their newest session.
    const legacy = await db.select({ userId: sessions.userId, at: sql<Date>`max(${sessions.createdAt})` }).from(sessions)
      .where(inArray(sessions.userId, ids)).groupBy(sessions.userId);
    for (const l of legacy) if (!lastLogin.has(l.userId)) lastLogin.set(l.userId, { at: new Date(l.at), provider: null });

    const counts = await db.select({ userId: signInLogs.userId, n: sql<number>`count(*)::int` }).from(signInLogs)
      .where(and(inArray(signInLogs.userId, ids), eq(signInLogs.event, "sign_in"), gte(signInLogs.createdAt, since30))).groupBy(signInLogs.userId);
    for (const c of counts) count30.set(c.userId, c.n);

    const mt = await db.select({
      hostUserId: bookings.hostUserId,
      n24: sql<number>`count(*) filter (where ${bookings.startsAt} < ${new Date(now.getTime() + DAY)})::int`,
      n7: sql<number>`count(*)::int`, next: sql<Date | null>`min(${bookings.startsAt})`,
    }).from(bookings).where(and(inArray(bookings.hostUserId, ids), inArray(bookings.status, [...LIVE]),
      gte(bookings.endsAt, now), lte(bookings.startsAt, new Date(now.getTime() + 7 * DAY)))).groupBy(bookings.hostUserId);
    for (const m of mt) meet.set(m.hostUserId, { n24: m.n24, n7: m.n7, next: m.next ? new Date(m.next) : null });

    const feed = await db.select({ userId: signInLogs.userId, provider: signInLogs.provider, device: signInLogs.device, at: signInLogs.createdAt, name: users.name })
      .from(signInLogs).innerJoin(users, eq(users.id, signInLogs.userId))
      .where(and(inArray(signInLogs.userId, ids), eq(signInLogs.event, "sign_in"))).orderBy(desc(signInLogs.createdAt)).limit(30);
    recent = feed;
  }

  const rows: OverviewMember[] = members.map((m) => ({
    ...m, lastSignInAt: lastLogin.get(m.userId)?.at ?? null, lastSignInMethod: lastLogin.get(m.userId)?.provider ?? null,
    signIns30d: count30.get(m.userId) ?? 0, meetingsNext24h: meet.get(m.userId)?.n24 ?? 0, meetingsNext7d: meet.get(m.userId)?.n7 ?? 0,
    nextMeetingAt: meet.get(m.userId)?.next ?? null,
  })).sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name));
  return { orgName, viewerRole, members: rows, recentSignIns: recent };
}

export interface MemberMeeting {
  id: string; startsAt: Date; endsAt: Date; status: string; eventTitle: string; inviteeName: string | null; inviteeEmail: string | null;
  meetingUrl: string | null; locationType: string | null;
}
export interface MemberSchedule {
  name: string; timeZone: string; isDefault: boolean;
  weekly: { weekday: number; startTime: string; endTime: string }[];
  overrides: { date: string; isUnavailable: boolean; startTime: string | null; endTime: string | null }[];
}

export async function getMemberDetail(viewerId: string, orgId: string, memberId: string, now = new Date(), db: Db = defaultDb) {
  const { role: viewerRole, orgName } = await requireOversight(viewerId, orgId, db);
  const [m] = await db.select({
    userId: users.id, name: users.name, email: users.email, image: users.image, role: organizationMembers.role, status: users.status,
    timeZone: users.timeZone, lastActiveAt: users.lastActiveAt, managerUserId: organizationMembers.managerUserId,
  }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, memberId), isNull(users.deletedAt))).limit(1);
  if (!m) throw new AppError("NOT_FOUND", "That person is not on this team", 404);
  if (viewerRole === "team_lead" && m.userId !== viewerId && m.managerUserId !== viewerId) throw new AppError("FORBIDDEN", "Team leads can view their own direct reports", 403);

  const [mgr] = m.managerUserId ? await db.select({ name: users.name }).from(users).where(eq(users.id, m.managerUserId)).limit(1) : [];

  // sign-in history: the durable log, else the newest sessions (accounts older than the log)
  let signIns: { at: Date; provider: string | null; device: string | null; event: string }[] = await db.select({ at: signInLogs.createdAt, provider: signInLogs.provider, device: signInLogs.device, event: signInLogs.event })
    .from(signInLogs).where(eq(signInLogs.userId, memberId)).orderBy(desc(signInLogs.createdAt)).limit(20);
  if (!signIns.length) {
    const s = await db.select({ at: sessions.createdAt, ua: sessions.userAgent }).from(sessions).where(eq(sessions.userId, memberId)).orderBy(desc(sessions.createdAt)).limit(10);
    signIns = s.map((x) => ({ at: x.at, provider: null, device: describeDevice(x.ua), event: "sign_in" }));
  }
  const logins = await db.select({ p: accounts.providerId }).from(accounts).where(eq(accounts.userId, memberId));

  // meetings: next 30 days and the last 7 days, every booking this person hosts (personal links included)
  const base = db.select({
    id: bookings.id, startsAt: bookings.startsAt, endsAt: bookings.endsAt, status: bookings.status, eventTitle: eventTypes.title,
    meetingUrl: bookings.meetingUrl, locationType: bookings.locationType,
  }).from(bookings).innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId));
  const upcoming = await base.where(and(eq(bookings.hostUserId, memberId), inArray(bookings.status, [...LIVE]), gte(bookings.endsAt, now), lte(bookings.startsAt, new Date(now.getTime() + 30 * DAY))))
    .orderBy(asc(bookings.startsAt)).limit(100);
  const recent = await base.where(and(eq(bookings.hostUserId, memberId), inArray(bookings.status, ["confirmed", "completed", "no_show", "cancelled"]),
    lte(bookings.startsAt, now), gte(bookings.startsAt, new Date(now.getTime() - 7 * DAY)))).orderBy(desc(bookings.startsAt)).limit(50);
  const all = [...upcoming, ...recent];
  const firstInv = new Map<string, { name: string; email: string }>();
  if (all.length) {
    const inv = await db.select({ bookingId: invitees.bookingId, name: invitees.name, email: invitees.email }).from(invitees)
      .where(and(inArray(invitees.bookingId, all.map((b) => b.id)), isNull(invitees.cancelledAt))).orderBy(asc(invitees.createdAt));
    for (const i of inv) if (!firstInv.has(i.bookingId)) firstInv.set(i.bookingId, i);
  }
  const shape = (b: (typeof all)[number]): MemberMeeting => ({ ...b, inviteeName: firstInv.get(b.id)?.name ?? null, inviteeEmail: firstInv.get(b.id)?.email ?? null });

  // working hours and the next date overrides
  const schedRows = await db.select().from(availabilitySchedules).where(eq(availabilitySchedules.userId, memberId)).orderBy(desc(availabilitySchedules.isDefault));
  const schedules: MemberSchedule[] = [];
  for (const s of schedRows) {
    const rules = await db.select({ weekday: availabilityRules.weekday, startTime: availabilityRules.startTime, endTime: availabilityRules.endTime })
      .from(availabilityRules).where(eq(availabilityRules.scheduleId, s.id)).orderBy(asc(availabilityRules.weekday), asc(availabilityRules.startTime));
    const ov = await db.select({ date: availabilityOverrides.date, isUnavailable: availabilityOverrides.isUnavailable, startTime: availabilityOverrides.startTime, endTime: availabilityOverrides.endTime })
      .from(availabilityOverrides).where(and(eq(availabilityOverrides.scheduleId, s.id), gte(availabilityOverrides.date, now.toISOString().slice(0, 10))))
      .orderBy(asc(availabilityOverrides.date)).limit(30);
    schedules.push({ name: s.name, timeZone: s.timeZone, isDefault: s.isDefault, weekly: rules, overrides: ov.map((o) => ({ ...o, date: String(o.date).slice(0, 10) })) });
  }

  // calendar connections: status only, never credentials
  const cals = await db.select({ provider: connectedCalendars.provider, email: connectedCalendars.email, status: connectedCalendars.status })
    .from(connectedCalendars).where(eq(connectedCalendars.userId, memberId));

  await db.insert(auditLogs).values({ actorId: viewerId, organizationId: orgId, action: "oversight.member_viewed", entity: "user", entityId: memberId, meta: { role: viewerRole } });

  return {
    orgName, viewerRole,
    member: { ...m, managerName: mgr?.name ?? null, loginMethods: [...new Set(logins.map((l) => l.p))].filter((p) => p !== "credential") },
    signIns, upcoming: upcoming.map(shape), recent: recent.map(shape), schedules, calendars: cals,
  };
}
