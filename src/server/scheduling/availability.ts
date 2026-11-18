/**
 * Pure availability math (no DB, no I/O). All instants are epoch milliseconds (UTC).
 * Wall-clock logic happens ONLY through Luxon in an IANA zone; we never add 24h to an instant,
 * so DST transitions (23h/25h days) are handled correctly.
 */
import { DateTime } from "luxon";

export interface Interval { start: number; end: number }
export interface WeeklyRule { weekday: number; startTime: string; endTime: string } // 0=Sunday..6=Saturday
export interface DateOverride { date: string; isUnavailable: boolean; startTime: string | null; endTime: string | null }

const MIN = 60_000;

/** "HH:mm[:ss]" -> minutes since midnight. "24:00" is allowed as an end time. */
export function parseTimeToMinutes(t: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t.trim());
  if (!m) throw new Error(`Invalid time "${t}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Resolve a local calendar day + minutes-of-day into a UTC instant. */
function localInstant(day: DateTime, minutes: number): number {
  if (minutes >= 1440) return day.plus({ days: 1 }).startOf("day").toMillis();
  return day.startOf("day").set({ hour: Math.floor(minutes / 60), minute: minutes % 60 }).toMillis();
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export function subtractIntervals(base: Interval[], busy: Interval[]): Interval[] {
  const b = mergeIntervals(busy);
  const out: Interval[] = [];
  for (const seg of mergeIntervals(base)) {
    let cur = seg.start;
    for (const x of b) {
      if (x.end <= cur) continue;
      if (x.start >= seg.end) break;
      if (x.start > cur) out.push({ start: cur, end: x.start });
      cur = Math.max(cur, x.end);
      if (cur >= seg.end) break;
    }
    if (cur < seg.end) out.push({ start: cur, end: seg.end });
  }
  return out;
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const A = mergeIntervals(a), B = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i].start, B[j].start), e = Math.min(A[i].end, B[j].end);
    if (e > s) out.push({ start: s, end: e });
    if (A[i].end < B[j].end) i++; else j++;
  }
  return out;
}

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/**
 * Expand weekly rules + date overrides (interpreted in `timeZone`) into UTC intervals covering the
 * local days touched by [from, to). Intervals are NOT clipped to [from, to) (callers filter slot starts),
 * so slot grids stay anchored on the real window start.
 * Override semantics: if any override row exists for a date, it fully replaces that weekday's rules;
 * an `isUnavailable` row blocks the whole day.
 */
export function expandAvailability(opts: {
  rules: WeeklyRule[]; overrides: DateOverride[]; timeZone: string; from: number; to: number;
}): Interval[] {
  const { rules, overrides, timeZone, from, to } = opts;
  const byDate = new Map<string, DateOverride[]>();
  for (const o of overrides) {
    const k = String(o.date).slice(0, 10);
    const arr = byDate.get(k) ?? [];
    arr.push(o);
    byDate.set(k, arr);
  }
  const out: Interval[] = [];
  let day = DateTime.fromMillis(from, { zone: timeZone }).startOf("day");
  if (!day.isValid) throw new Error(`Invalid time zone "${timeZone}"`);
  while (day.toMillis() < to) {
    const key = day.toISODate()!;
    const ov = byDate.get(key);
    if (ov && ov.length) {
      if (!ov.some((o) => o.isUnavailable)) {
        for (const o of ov) {
          if (o.startTime == null || o.endTime == null) continue;
          out.push({ start: localInstant(day, parseTimeToMinutes(o.startTime)), end: localInstant(day, parseTimeToMinutes(o.endTime)) });
        }
      }
    } else {
      const wd = day.weekday % 7; // Luxon: 1=Mon..7=Sun -> 0=Sun
      for (const r of rules) {
        if (r.weekday !== wd) continue;
        out.push({ start: localInstant(day, parseTimeToMinutes(r.startTime)), end: localInstant(day, parseTimeToMinutes(r.endTime)) });
      }
    }
    day = day.plus({ days: 1 }).startOf("day"); // calendar arithmetic, DST-safe
  }
  return mergeIntervals(out.filter((i) => i.end > i.start));
}

export interface SlotParams {
  availability: Interval[];
  /** Existing bookings' blocked windows (already include THEIR buffers). The new slot's buffers are applied to it. */
  busyBlocks: Interval[];
  /** External calendar events / manual blocked time: compared against the bare slot (no buffers). */
  busyHard: Interval[];
  durationMin: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  /** Step between slot starts; defaults to duration. */
  intervalMin?: number | null;
  /** Slot starts must be in [from, to). */
  from: number; to: number;
  /** Earliest allowed start = now + minNotice. */
  earliest: number;
  /** Latest allowed start (max horizon). */
  latest: number;
}

/** Generate valid slot start instants (epoch ms), ascending. */
export function generateSlotStarts(p: SlotParams): number[] {
  const dur = p.durationMin * MIN;
  const step = (p.intervalMin && p.intervalMin > 0 ? p.intervalMin : p.durationMin) * MIN;
  const bb = (p.bufferBeforeMin ?? 0) * MIN, ba = (p.bufferAfterMin ?? 0) * MIN;
  const lo = Math.max(p.from, p.earliest), hi = Math.min(p.to - 1, p.latest);
  const blocks = mergeIntervals(p.busyBlocks), hard = mergeIntervals(p.busyHard);
  const out: number[] = [];
  for (const av of mergeIntervals(p.availability)) {
    for (let t = av.start; t + dur <= av.end; t += step) {
      if (t < lo) continue;
      if (t > hi) break;
      const slot = { start: t, end: t + dur };
      const block = { start: t - bb, end: t + dur + ba };
      if (blocks.some((b) => overlaps(b, block)) || hard.some((b) => overlaps(b, slot))) continue;
      out.push(t);
    }
  }
  return out;
}

/** Counts of existing bookings per local day / ISO week (host time zone). */
export interface LimitIndex { day: Map<string, number>; week: Map<string, number>; timeZone: string }
export const dayKey = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toISODate()!;
export const weekKey = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).startOf("week").toISODate()!;

export function buildLimitIndex(bookingStarts: number[], timeZone: string): LimitIndex {
  const day = new Map<string, number>(), week = new Map<string, number>();
  for (const s of bookingStarts) {
    const d = dayKey(s, timeZone), w = weekKey(s, timeZone);
    day.set(d, (day.get(d) ?? 0) + 1);
    week.set(w, (week.get(w) ?? 0) + 1);
  }
  return { day, week, timeZone };
}

export function withinLimits(startMs: number, idx: LimitIndex, daily?: number | null, weekly?: number | null): boolean {
  if (daily != null && daily > 0 && (idx.day.get(dayKey(startMs, idx.timeZone)) ?? 0) >= daily) return false;
  if (weekly != null && weekly > 0 && (idx.week.get(weekKey(startMs, idx.timeZone)) ?? 0) >= weekly) return false;
  return true;
}

export interface HostCandidate { userId: string; priority: number; weight: number; load: number }

/**
 * Round-robin host selection. Lower `priority` number wins first; within the same priority the host with the
 * lowest weighted load (load / weight) wins; ties break on higher weight, then userId (deterministic).
 */
export function pickHost<T extends HostCandidate>(candidates: T[]): T | undefined {
  if (!candidates.length) return undefined;
  return [...candidates].sort((a, b) =>
    a.priority - b.priority ||
    a.load / Math.max(a.weight, 1) - b.load / Math.max(b.weight, 1) ||
    b.weight - a.weight ||
    a.userId.localeCompare(b.userId),
  )[0];
}
