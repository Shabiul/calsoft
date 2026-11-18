/**
 * Slot computation. `getAvailableSlots` is the public contract (docs/ARCHITECTURE.md).
 * The same engine is re-run by the booking service inside the booking transaction (under advisory locks)
 * to validate a slot authoritatively.
 *
 * Kinds:
 *  - one_on_one: the (first) host's availability.
 *  - group: like one_on_one, but a slot already booked for this event stays open until `capacity` is reached.
 *  - collective: only starts where ALL required hosts are free; hostUserId = primary (first) host.
 *  - round_robin: union of hosts; one entry per start, host chosen by `pickHost` (priority, then weighted load).
 */
import { and, eq, gt, inArray, isNull, lt, sql, asc } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema, type Db } from "../db";
import { AppError } from "../errors";
import {
  buildLimitIndex, expandAvailability, generateSlotStarts, pickHost, withinLimits,
  type DateOverride, type HostCandidate, type Interval, type WeeklyRule,
} from "./availability";
import { defaultBusyProvider, type BusyProvider } from "./busy-provider";

export { pickHost } from "./availability";
export type { BusyProvider } from "./busy-provider";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;
export type EventRow = typeof schema.eventTypes.$inferSelect;

/** Statuses that hold a slot (must mirror the booking_no_overlap WHERE clause in drizzle/constraints.sql). */
export const ACTIVE_STATUSES = ["confirmed", "pending_payment", "pending_confirmation"] as const;
const MIN = 60_000, DAY = 86_400_000;

export interface Slot {
  startsAt: string;
  hostUserId: string;
  /** All hosts free at this start (collective: every required host; round robin: every candidate). */
  hostUserIds?: string[];
  /** Group events: seats remaining. */
  spotsLeft?: number;
}

export interface GetSlotsInput {
  eventTypeId: string;
  from: string | Date;
  to: string | Date;
  inviteeTimeZone: string;
  excludeBookingId?: string;
  /** Injectable for tests / transactions. */
  now?: Date;
  exec?: Executor;
  busyProvider?: BusyProvider;
}

export interface HostInfo {
  userId: string; priority: number; weight: number; isRequired: boolean;
  timeZone: string; rules: WeeklyRule[]; overrides: DateOverride[]; hasSchedule: boolean;
}
export interface EventContext { event: EventRow; hosts: HostInfo[] }

const asDate = (v: string | Date, name: string) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError("VALIDATION", `Invalid ${name}`, 400);
  return d;
};

export async function loadEventContext(exec: Executor, eventTypeId: string): Promise<EventContext> {
  const x = exec as Db;
  const [event] = await x.select().from(schema.eventTypes).where(eq(schema.eventTypes.id, eventTypeId)).limit(1);
  if (!event || event.deletedAt || event.archivedAt || !event.isActive) throw new AppError("NOT_FOUND", "Event type not found", 404);

  const hostRows = await x
    .select({ userId: schema.eventHosts.userId, priority: schema.eventHosts.priority, weight: schema.eventHosts.weight, isRequired: schema.eventHosts.isRequired })
    .from(schema.eventHosts)
    .innerJoin(schema.users, eq(schema.users.id, schema.eventHosts.userId))
    .where(and(eq(schema.eventHosts.eventTypeId, eventTypeId), isNull(schema.users.deletedAt), eq(schema.users.status, "active")))
    .orderBy(asc(schema.eventHosts.priority), asc(schema.eventHosts.userId));

  let chosen = hostRows;
  if (!chosen.length && event.ownerUserId) {
    // personal event: the owner is the host, but a suspended/deleted owner must not take bookings
    const [owner] = await x.select({ id: schema.users.id }).from(schema.users)
      .where(and(eq(schema.users.id, event.ownerUserId), isNull(schema.users.deletedAt), eq(schema.users.status, "active"))).limit(1);
    if (owner) chosen = [{ userId: owner.id, priority: 0, weight: 1, isRequired: true }];
  }
  if (!chosen.length) throw new AppError("NOT_FOUND", "Event type has no hosts", 404);

  if (event.kind === "one_on_one" || event.kind === "group") {
    const primary = chosen.find((h) => h.userId === event.ownerUserId) ?? chosen[0];
    chosen = [primary];
  } else if (event.kind === "collective") {
    const req = chosen.filter((h) => h.isRequired);
    chosen = req.length ? req : chosen;
  }

  const userIds = chosen.map((h) => h.userId);
  const users = await x.select({ id: schema.users.id, tz: schema.users.timeZone }).from(schema.users).where(inArray(schema.users.id, userIds));
  const tzOf = new Map(users.map((u) => [u.id, u.tz]));
  const schedules = await x.select().from(schema.availabilitySchedules).where(inArray(schema.availabilitySchedules.userId, userIds));
  const explicit = event.scheduleId ? schedules.find((s) => s.id === event.scheduleId) ?? (await x.select().from(schema.availabilitySchedules).where(eq(schema.availabilitySchedules.id, event.scheduleId)).limit(1))[0] : undefined;

  const pickSchedule = (userId: string) => {
    if (explicit && (userId === event.ownerUserId || explicit.userId === userId)) return explicit;
    const mine = schedules.filter((s) => s.userId === userId);
    return mine.find((s) => s.isDefault) ?? mine[0];
  };
  const chosenSchedules = chosen.map((h) => pickSchedule(h.userId));
  const sIds = [...new Set(chosenSchedules.filter(Boolean).map((s) => s!.id))];
  const rules = sIds.length ? await x.select().from(schema.availabilityRules).where(inArray(schema.availabilityRules.scheduleId, sIds)) : [];
  const overrides = sIds.length ? await x.select().from(schema.availabilityOverrides).where(inArray(schema.availabilityOverrides.scheduleId, sIds)) : [];

  const hosts: HostInfo[] = chosen.map((h, i) => {
    const s = chosenSchedules[i];
    return {
      userId: h.userId, priority: h.priority, weight: h.weight, isRequired: h.isRequired,
      timeZone: s?.timeZone ?? tzOf.get(h.userId) ?? "UTC",
      hasSchedule: !!s,
      rules: s ? rules.filter((r) => r.scheduleId === s.id) : [],
      overrides: s ? overrides.filter((o) => o.scheduleId === s.id) : [],
    };
  });
  return { event, hosts };
}

interface ComputeOpts {
  from: Date; to: Date; now: Date; excludeBookingId?: string; busyProvider: BusyProvider;
  /** Recurring series: later occurrences are not bound by max_horizon_days (min notice still applies). */
  skipHorizon?: boolean;
}

/** Core engine over a loaded context. Returns slots incl. all candidate hosts. */
export async function computeSlots(exec: Executor, ctx: EventContext, o: ComputeOpts): Promise<Slot[]> {
  const x = exec as Db;
  const { event, hosts } = ctx;
  const fromMs = o.from.getTime(), toMs = o.to.getTime();
  const dur = event.durationMinutes;
  const bb = event.bufferBeforeMinutes, ba = event.bufferAfterMinutes;
  const earliest = o.now.getTime() + event.minNoticeMinutes * MIN;
  const latest = o.skipHorizon ? Number.MAX_SAFE_INTEGER : DateTime.fromMillis(o.now.getTime()).plus({ days: event.maxHorizonDays }).toMillis();
  if (toMs <= fromMs || fromMs > latest || toMs < earliest) return [];

  const hostIds = hosts.map((h) => h.userId);
  const hasLimits = !!(event.dailyLimit || event.weeklyLimit);
  const margin = (hasLimits ? 8 : 1) * DAY + (dur + bb + ba) * MIN;
  const qFrom = new Date(fromMs - margin), qTo = new Date(toMs + margin);

  const excl = o.excludeBookingId;
  const bookingRows = await x
    .select({
      id: schema.bookings.id, hostUserId: schema.bookings.hostUserId, eventTypeId: schema.bookings.eventTypeId,
      startsAt: schema.bookings.startsAt, blockStart: schema.bookings.blockStart, blockEnd: schema.bookings.blockEnd,
    })
    .from(schema.bookings)
    .where(and(
      inArray(schema.bookings.hostUserId, hostIds),
      inArray(schema.bookings.status, [...ACTIVE_STATUSES]),
      lt(schema.bookings.blockStart, qTo), gt(schema.bookings.blockEnd, qFrom),
      excl ? sql`${schema.bookings.id} <> ${excl} and coalesce(${schema.bookings.externalEventIds}->>'collectiveOf','') <> ${excl}` : undefined,
    ));

  const blocked = await x.select().from(schema.blockedTimes).where(and(
    inArray(schema.blockedTimes.userId, hostIds), lt(schema.blockedTimes.startsAt, qTo), gt(schema.blockedTimes.endsAt, qFrom),
  ));

  const isGroup = event.kind === "group";
  const perHost = new Map<string, Map<number, number>>(); // host -> start -> spotsLeft (or 1)

  for (const h of hosts) {
    if (!h.hasSchedule) { perHost.set(h.userId, new Map()); continue; }
    const mine = bookingRows.filter((b) => b.hostUserId === h.userId);
    // For group events, bookings of THIS event are handled via capacity, not as busy time.
    const sameEvent = isGroup ? mine.filter((b) => b.eventTypeId === event.id) : [];
    const others = isGroup ? mine.filter((b) => b.eventTypeId !== event.id) : mine;

    const external = await o.busyProvider(h.userId, new Date(fromMs - margin), new Date(toMs + margin));
    const hard: Interval[] = [
      ...external,
      ...blocked.filter((b) => b.userId === h.userId).map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() })),
    ];
    const blocks: Interval[] = others.map((b) => ({ start: b.blockStart.getTime(), end: b.blockEnd.getTime() }));

    const availability = expandAvailability({ rules: h.rules, overrides: h.overrides, timeZone: h.timeZone, from: fromMs, to: toMs });
    let starts = generateSlotStarts({
      availability, busyBlocks: blocks, busyHard: hard, durationMin: dur, bufferBeforeMin: bb, bufferAfterMin: ba,
      intervalMin: event.slotIntervalMinutes, from: fromMs, to: toMs, earliest, latest,
    });

    const limitSource = mine.filter((b) => b.eventTypeId === event.id).map((b) => b.startsAt.getTime());
    const idx = buildLimitIndex(limitSource, h.timeZone);
    const spots = new Map<number, number>();

    if (isGroup) {
      const countAt = new Map<number, number>();
      for (const b of sameEvent) countAt.set(b.startsAt.getTime(), (countAt.get(b.startsAt.getTime()) ?? 0) + 1);
      const sameBlocks = sameEvent.map((b) => ({ start: b.startsAt.getTime(), end: b.startsAt.getTime() + dur * MIN, s: b.startsAt.getTime() }));
      starts = starts.filter((t) => {
        // Another session of this event overlapping at a DIFFERENT start blocks the host.
        if (sameBlocks.some((b) => b.s !== t && b.start < t + dur * MIN && t < b.end)) return false;
        const taken = countAt.get(t) ?? 0;
        if (taken >= event.capacity) return false;
        spots.set(t, event.capacity - taken);
        return true;
      });
      // Limits count sessions (distinct starts), not seats, for group events.
      const distinct = [...new Set(limitSource)];
      const gIdx = buildLimitIndex(distinct, h.timeZone);
      starts = starts.filter((t) => countAt.has(t) || withinLimits(t, gIdx, event.dailyLimit, event.weeklyLimit));
    } else {
      starts = starts.filter((t) => withinLimits(t, idx, event.dailyLimit, event.weeklyLimit));
      for (const t of starts) spots.set(t, 1);
    }
    perHost.set(h.userId, spots);
  }

  const iso = (t: number) => new Date(t).toISOString();

  if (event.kind === "collective") {
    const primary = hosts[0];
    let common = [...(perHost.get(primary.userId)?.keys() ?? [])];
    for (const h of hosts.slice(1)) { const s = perHost.get(h.userId)!; common = common.filter((t) => s.has(t)); }
    return common.sort((a, b) => a - b).map((t) => ({ startsAt: iso(t), hostUserId: primary.userId, hostUserIds: hostIds }));
  }

  if (event.kind === "round_robin") {
    const loadRows = await x
      .select({ hostUserId: schema.bookings.hostUserId, n: sql<number>`count(*)::int` })
      .from(schema.bookings)
      .where(and(
        inArray(schema.bookings.hostUserId, hostIds), eq(schema.bookings.eventTypeId, event.id),
        inArray(schema.bookings.status, [...ACTIVE_STATUSES]),
        gt(schema.bookings.startsAt, o.now), lt(schema.bookings.startsAt, new Date(o.now.getTime() + 60 * DAY)),
      ))
      .groupBy(schema.bookings.hostUserId);
    const load = new Map(loadRows.map((r) => [r.hostUserId, r.n]));
    const all = new Set<number>();
    for (const s of perHost.values()) for (const t of s.keys()) all.add(t);
    return [...all].sort((a, b) => a - b).map((t) => {
      const cands: HostCandidate[] = hosts.filter((h) => perHost.get(h.userId)!.has(t))
        .map((h) => ({ userId: h.userId, priority: h.priority, weight: h.weight, load: load.get(h.userId) ?? 0 }));
      const win = pickHost(cands)!;
      return { startsAt: iso(t), hostUserId: win.userId, hostUserIds: cands.map((c) => c.userId) };
    });
  }

  const h = hosts[0];
  const s = perHost.get(h.userId)!;
  return [...s.keys()].sort((a, b) => a - b).map((t) => ({
    startsAt: iso(t), hostUserId: h.userId, hostUserIds: [h.userId],
    ...(isGroup ? { spotsLeft: s.get(t) } : {}),
  }));
}

/** Public contract. Returns UTC ISO start times; the UI formats them in the invitee's zone. */
export async function getAvailableSlots(input: GetSlotsInput): Promise<Slot[]> {
  if (!DateTime.local().setZone(input.inviteeTimeZone).isValid) throw new AppError("VALIDATION", "Invalid time zone", 400);
  const exec = input.exec ?? db;
  const ctx = await loadEventContext(exec, input.eventTypeId);
  return computeSlots(exec, ctx, {
    from: asDate(input.from, "from"), to: asDate(input.to, "to"), now: input.now ?? new Date(),
    excludeBookingId: input.excludeBookingId, busyProvider: input.busyProvider ?? defaultBusyProvider,
  });
}

