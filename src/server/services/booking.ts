/**
 * Booking service. Every mutation is one DB transaction:
 *   1. advisory locks (event + every candidate host, sorted -> no deadlocks),
 *   2. authoritative slot re-validation through the same engine used for display (slots.ts),
 *   3. inserts; the booking_no_overlap EXCLUDE constraint is the final backstop (23P01 -> SLOT_UNAVAILABLE).
 *
 * Collective events: one booking row PER required host (primary host row carries the manage token and
 * idempotency key; the others carry externalEventIds.collectiveOf = primary id). Each row is an ordinary exclusive
 * booking, so the exclusion constraint protects every host's calendar. See docs/DATABASE_DESIGN.md.
 *
 * Side effects (emails, webhooks, workflows) are NOT done here: after commit we call `onBookingEvent`.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema, type Db } from "../db";
import { AppError } from "../errors";
import { computeSlots, loadEventContext, type EventContext, type Executor } from "../scheduling/slots";
import { defaultBusyProvider, type BusyProvider } from "../scheduling/busy-provider";
import type { Interval } from "../scheduling/availability";
import { seriesStarts } from "../scheduling/recurrence";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Booking = typeof schema.bookings.$inferSelect;
export type BookingStatus = Booking["status"];
export type BookingEventType =
  | "booking.created" | "booking.rescheduled" | "booking.cancelled"
  | "booking.confirmed" | "booking.declined" | "booking.completed" | "booking.no_show" | "booking.expired";
export type Actor = "invitee" | "host" | "system";

const MIN = 60_000;
/** Statuses that hold the slot / can be cancelled or rescheduled. Mirrors drizzle/constraints.sql. */
const ACTIVE: BookingStatus[] = ["confirmed", "pending_payment", "pending_confirmation"];

// ───────── hook (injectable; default lazily calls emitEvent from the queue module if it exists)
export interface BookingEventExtra {
  manageToken?: string; previousBookingId?: string; reason?: string;
  /** Recurring series: 0-based position of this occurrence and series size. Emails are sent for index 0 only. */
  seriesIndex?: number; seriesCount?: number;
  /** booking.confirmed raised by a host approving a request (selects the "approved" email). */
  approved?: boolean;
}
export type BookingEventHook = (type: BookingEventType, bookingId: string, extra?: BookingEventExtra) => void | Promise<void>;
let hook: BookingEventHook | null = null;
/** Override (tests) or reset (null) the post-commit hook. */
export function setBookingEventHook(fn: BookingEventHook | null) { hook = fn; }

async function defaultHook(type: BookingEventType, bookingId: string, extra?: BookingEventExtra) {
  try {
    const { emitEvent } = await import("../queue");
    await emitEvent(type, { bookingId, ...extra });
  } catch (err) {
    if (!/Cannot find module|Failed to resolve|Failed to load/i.test(String((err as Error).message))) {
      console.warn(`[booking] emitEvent(${type}) failed:`, (err as Error).message);
    }
  }
}
export async function onBookingEvent(type: BookingEventType, bookingId: string, extra?: BookingEventExtra) {
  try { await (hook ?? defaultHook)(type, bookingId, extra); } catch (e) { console.warn("[booking] hook error:", (e as Error).message); }
}

// ───────── helpers
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

function pgCode(e: unknown): string | undefined {
  let cur = e as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 4 && cur; i++) { if (typeof cur.code === "string" && /^[0-9A-Z]{5}$/.test(cur.code)) return cur.code; cur = cur.cause as typeof cur; }
  return undefined;
}
const pgConstraint = (e: unknown): string | undefined => {
  let cur = e as { constraint?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 4 && cur; i++) { if (cur.constraint) return cur.constraint; cur = cur.cause as typeof cur; }
};
const slotGone = (series?: { occurrence: number; startsAt: string; count: number }) => series
  ? new AppError("SLOT_UNAVAILABLE", `Session ${series.occurrence} of ${series.count} (${series.startsAt}) is not available, so the series could not be booked. Please pick another start time.`, 409, { failedOccurrence: series.occurrence, failedStartsAt: series.startsAt, count: series.count })
  : new AppError("SLOT_UNAVAILABLE", "That time is no longer available. Please pick another slot.", 409);

async function lock(tx: Tx, keys: string[]) {
  for (const k of [...new Set(keys)].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${k}, 0))`);
}

async function prefetchBusy(ctx: EventContext, start: Date, provider: BusyProvider, last: Date = start): Promise<BusyProvider> {
  const from = new Date(start.getTime() - 2 * 86_400_000), to = new Date(last.getTime() + 2 * 86_400_000);
  const map = new Map<string, Interval[]>();
  await Promise.all(ctx.hosts.map(async (h) => { map.set(h.userId, await provider(h.userId, from, to)); }));
  return async (userId) => map.get(userId) ?? [];
}

export interface Deps { now?: Date; busyProvider?: BusyProvider }

export interface CreateBookingInput {
  eventTypeId: string;
  startsAt: string | Date;
  invitee: { name: string; email: string; phone?: string | null; timeZone: string };
  /** Keyed by event_question.id. */
  answers?: Record<string, string | string[]>;
  idempotencyKey?: string;
  /** Round robin only: prefer this host if free. */
  hostUserId?: string;
  actor?: Actor;
  actorId?: string;
}
export interface BookingResult {
  booking: Booking;
  /** Plain manage token (only known at creation). null when an idempotent replay returns an existing booking. */
  manageToken: string | null;
  idempotentReplay?: boolean;
  /** Recurring series: every occurrence in time order (occurrence 1 === `booking`). Tokens are null on replay. */
  series?: { booking: Booking; manageToken: string | null }[];
}

interface ResolvedAnswer { questionId: string; question: string; answer: string }

async function resolveAnswers(x: Db, eventTypeId: string, answers: Record<string, string | string[]> | undefined): Promise<ResolvedAnswer[]> {
  const qs = await x.select().from(schema.eventQuestions).where(eq(schema.eventQuestions.eventTypeId, eventTypeId));
  const out: ResolvedAnswer[] = [];
  for (const q of qs) {
    const raw = answers?.[q.id];
    const val = Array.isArray(raw) ? raw.join(", ") : (raw ?? "").toString().trim();
    if (!val) {
      if (q.required) throw new AppError("VALIDATION", `"${q.label}" is required`, 400, { questionId: q.id });
      continue;
    }
    out.push({ questionId: q.id, question: q.label, answer: val });
  }
  return out;
}

interface InsertParams {
  ctx: EventContext; hostIds: string[]; start: Date; status: BookingStatus;
  invitee: { name: string; email: string; phone?: string | null; timeZone: string };
  answers: ResolvedAnswer[]; idempotencyKey?: string | null; actor: string;
  /** Previous rows (old booking ids by host) for reschedule history. */
  previous?: Map<string, string>;
  eventData?: Record<string, unknown>;
  /** Recurring series membership (all occurrences share the id). */
  seriesId?: string | null;
}

/** Inserts the booking row(s) + invitee + answers + history. Returns primary booking + plain token. */
async function insertBookingGroup(tx: Tx, p: InsertParams): Promise<{ booking: Booking; token: string; all: Booking[] }> {
  const { event } = p.ctx;
  const end = new Date(p.start.getTime() + event.durationMinutes * MIN);
  const blockStart = new Date(p.start.getTime() - event.bufferBeforeMinutes * MIN);
  const blockEnd = new Date(end.getTime() + event.bufferAfterMinutes * MIN);
  const token = newToken();
  const primaryId = randomUUID();
  const paid = !!event.priceAmount && event.priceAmount > 0;
  const email = p.invitee.email.trim().toLowerCase();
  const all: Booking[] = [];

  for (let i = 0; i < p.hostIds.length; i++) {
    const hostId = p.hostIds[i];
    const isPrimary = i === 0;
    const host = p.ctx.hosts.find((h) => h.userId === hostId);
    const [row] = await tx.insert(schema.bookings).values({
      id: isPrimary ? primaryId : randomUUID(),
      eventTypeId: event.id, hostUserId: hostId, organizationId: event.organizationId,
      startsAt: p.start, endsAt: end, blockStart, blockEnd, status: p.status,
      inviteeTimeZone: p.invitee.timeZone, hostTimeZone: host?.timeZone ?? "UTC",
      locationType: event.locationType, meetingUrl: event.locationType === "custom_url" ? event.locationValue : null,
      idempotencyKey: isPrimary ? p.idempotencyKey ?? null : null,
      manageTokenHash: isPrimary ? hashToken(token) : null,
      rescheduledFromId: p.previous?.get(hostId) ?? null,
      exclusiveSlot: event.kind !== "group",
      seriesId: p.seriesId ?? null,
      holdExpiresAt: p.status === "pending_payment" ? new Date(Date.now() + 15 * MIN) : null,
      externalEventIds: isPrimary ? {} : { collectiveOf: primaryId },
    }).returning();
    all.push(row);

    const [contact] = await tx.insert(schema.contacts).values({
      ownerUserId: hostId, organizationId: event.organizationId, email, name: p.invitee.name, phone: p.invitee.phone ?? null, timeZone: p.invitee.timeZone,
    }).onConflictDoUpdate({
      target: [schema.contacts.ownerUserId, schema.contacts.email],
      set: { name: p.invitee.name, phone: p.invitee.phone ?? null, timeZone: p.invitee.timeZone, updatedAt: new Date() },
    }).returning({ id: schema.contacts.id });

    const [inv] = await tx.insert(schema.invitees).values({
      bookingId: row.id, contactId: contact.id, name: p.invitee.name, email, phone: p.invitee.phone ?? null,
    }).returning({ id: schema.invitees.id });
    if (p.answers.length) {
      await tx.insert(schema.inviteeAnswers).values(p.answers.map((a) => ({ inviteeId: inv.id, questionId: a.questionId, question: a.question, answer: a.answer })));
    }
    await tx.insert(schema.bookingEvents).values({
      bookingId: row.id, type: p.previous ? "rescheduled_to" : "created", actor: p.actor,
      data: { startsAt: p.start.toISOString(), inviteeEmail: email, ...(p.eventData ?? {}) },
    });
  }
  return { booking: all[0], token, all };
}

async function runWrite<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof AppError) throw e;
    if (pgCode(e) === "23P01") throw slotGone();
    throw e;
  }
}

// ───────── create
/**
 * Status rule for a new booking (documented in docs/IMPLEMENTATION_STATUS.md):
 *   paid event                -> pending_payment  (pay FIRST; after payment, requires_confirmation => pending_confirmation)
 *   requires_confirmation     -> pending_confirmation (host approves/declines; the slot is held meanwhile)
 *   otherwise                 -> confirmed
 */
function initialStatus(event: EventContext["event"]): BookingStatus {
  if (event.priceAmount && event.priceAmount > 0) return "pending_payment";
  return event.requiresConfirmation ? "pending_confirmation" : "confirmed";
}

/** Status a pending_payment booking moves to once paid. */
export function statusAfterPayment(event: { requiresConfirmation: boolean }): BookingStatus {
  return event.requiresConfirmation ? "pending_confirmation" : "confirmed";
}

function pickHosts(ctx: EventContext, slot: { hostUserId: string; hostUserIds?: string[] }, preferred?: string): string[] {
  if (ctx.event.kind === "collective") return ctx.hosts.map((h) => h.userId);
  if (ctx.event.kind === "round_robin" && preferred && slot.hostUserIds?.includes(preferred)) return [preferred];
  return [slot.hostUserId];
}

/** The recurrence that applies to an event (group events never recur). */
function recurrenceOf(event: EventContext["event"]) {
  const r = event.recurrence;
  if (!r || event.kind === "group" || !(r.count >= 2)) return null;
  return r;
}

export interface SeriesPreviewItem { startsAt: string; endsAt: string; available: boolean }
export interface SeriesPreview { timeZone: string; recurrence: { count: number; interval: "week" | "month" }; occurrences: SeriesPreviewItem[] }
/** Read-only: the occurrence dates a series starting at `startsAt` would use and whether each is currently bookable. */
export async function previewSeries(eventTypeId: string, startsAt: string | Date, deps: Deps = {}): Promise<SeriesPreview | null> {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) throw new AppError("VALIDATION", "Invalid startsAt", 400);
  const ctx = await loadEventContext(db, eventTypeId);
  const rec = recurrenceOf(ctx.event);
  if (!rec) return null;
  const tz = ctx.hosts[0].timeZone;
  const starts = seriesStarts(start, tz, rec);
  const busy = await prefetchBusy(ctx, starts[0], deps.busyProvider ?? defaultBusyProvider, starts[starts.length - 1]);
  const now = deps.now ?? new Date();
  const out: SeriesPreviewItem[] = [];
  for (let i = 0; i < starts.length; i++) {
    const slots = await computeSlots(db, ctx, { from: starts[i], to: new Date(starts[i].getTime() + 1), now, busyProvider: busy, skipHorizon: i > 0 });
    out.push({
      startsAt: starts[i].toISOString(), endsAt: new Date(starts[i].getTime() + ctx.event.durationMinutes * MIN).toISOString(),
      available: slots.some((x) => x.startsAt === starts[i].toISOString()),
    });
  }
  return { timeZone: tz, recurrence: rec, occurrences: out };
}

export async function createBooking(input: CreateBookingInput, deps: Deps = {}): Promise<BookingResult> {
  const start = new Date(input.startsAt);
  if (Number.isNaN(start.getTime())) throw new AppError("VALIDATION", "Invalid startsAt", 400);
  const name = input.invitee.name?.trim(), email = input.invitee.email?.trim().toLowerCase();
  if (!name) throw new AppError("VALIDATION", "Name is required", 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("VALIDATION", "A valid email is required", 400);
  if (!DateTime.local().setZone(input.invitee.timeZone).isValid) throw new AppError("VALIDATION", "Invalid time zone", 400);
  const invitee = { ...input.invitee, name, email };

  /** Idempotency covers the whole series: the key lives on occurrence 1; the series is atomic so its siblings exist too. */
  const replayOf = async (b: Booking): Promise<BookingResult> =>
    ({ booking: b, manageToken: null, idempotentReplay: true, series: b.seriesId ? await loadSeriesRows(db, b.seriesId, b) : undefined });
  const replay = async (): Promise<BookingResult | null> => {
    if (!input.idempotencyKey) return null;
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.idempotencyKey, input.idempotencyKey)).limit(1);
    return b ? replayOf(b) : null;
  };
  const early = await replay();
  if (early) return early;

  const ctx = await loadEventContext(db, input.eventTypeId);
  const rec = recurrenceOf(ctx.event);
  if (rec && ctx.event.priceAmount && ctx.event.priceAmount > 0) {
    throw new AppError("VALIDATION", "Paid recurring events are not supported. Remove the price or the recurrence.", 400);
  }
  const answers = await resolveAnswers(db, input.eventTypeId, input.answers);
  const starts = rec ? seriesStarts(start, ctx.hosts[0].timeZone, rec) : [start];
  const busy = await prefetchBusy(ctx, starts[0], deps.busyProvider ?? defaultBusyProvider, starts[starts.length - 1]);
  const now = deps.now ?? new Date();

  type Out = { rows: { booking: Booking; token: string }[]; replay?: Booking };
  let result: Out;
  try {
    result = await runWrite(() => db.transaction(async (tx): Promise<Out> => {
      await lock(tx, [`event:${ctx.event.id}`, ...ctx.hosts.map((h) => `host:${h.userId}`)]);
      // A concurrent request with the same key may have committed while we waited for the lock.
      if (input.idempotencyKey) {
        const [dupe] = await tx.select().from(schema.bookings).where(eq(schema.bookings.idempotencyKey, input.idempotencyKey)).limit(1);
        if (dupe) return { rows: [], replay: dupe };
      }

      // Validate EVERY occurrence before writing anything; any failure aborts the whole series.
      const plan: { start: Date; hostIds: string[] }[] = [];
      let preferred: string | undefined = input.hostUserId;
      for (let i = 0; i < starts.length; i++) {
        const slots = await computeSlots(tx, ctx, { from: starts[i], to: new Date(starts[i].getTime() + 1), now, busyProvider: busy, skipHorizon: i > 0 });
        const slot = slots.find((s) => s.startsAt === starts[i].toISOString());
        if (!slot) throw slotGone(rec ? { occurrence: i + 1, startsAt: starts[i].toISOString(), count: starts.length } : undefined);
        const hostIds = pickHosts(ctx, slot, preferred);
        if (ctx.event.kind === "round_robin") preferred = hostIds[0]; // keep one host for the whole series when possible
        plan.push({ start: starts[i], hostIds });
      }

      if (ctx.event.kind === "group") {
        const dup = await tx.select({ id: schema.bookings.id }).from(schema.bookings)
          .innerJoin(schema.invitees, eq(schema.invitees.bookingId, schema.bookings.id))
          .where(and(eq(schema.bookings.eventTypeId, ctx.event.id), eq(schema.bookings.startsAt, start), inArray(schema.bookings.status, ACTIVE), eq(schema.invitees.email, email))).limit(1);
        if (dup.length) throw new AppError("ALREADY_BOOKED", "You are already registered for this session.", 409);
      }

      const status = initialStatus(ctx.event);
      const seriesId = rec ? randomUUID() : null;
      const rows: { booking: Booking; token: string }[] = [];
      for (let i = 0; i < plan.length; i++) {
        try {
          const g = await insertBookingGroup(tx, {
            ctx, hostIds: plan[i].hostIds, start: plan[i].start, status, invitee, answers,
            idempotencyKey: i === 0 ? input.idempotencyKey : undefined, actor: input.actor ?? "invitee", seriesId,
            eventData: rec ? { series: { id: seriesId, index: i, count: plan.length, interval: rec.interval } } : undefined,
          });
          rows.push({ booking: g.booking, token: g.token });
        } catch (e) {
          // The exclusion constraint is the backstop; report which occurrence lost.
          if (rec && pgCode(e) === "23P01") throw slotGone({ occurrence: i + 1, startsAt: plan[i].start.toISOString(), count: plan.length });
          throw e;
        }
      }
      return { rows };
    }));
  } catch (e) {
    if (pgCode(e) === "23505" && pgConstraint(e)?.includes("idempotency")) {
      const r = await replay();
      if (r) return r;
    }
    throw e;
  }
  if (result.replay) return replayOf(result.replay);
  const first = result.rows[0];
  for (let i = 0; i < result.rows.length; i++) {
    await onBookingEvent("booking.created", result.rows[i].booking.id, {
      manageToken: result.rows[i].token,
      ...(rec ? { seriesIndex: i, seriesCount: result.rows.length } : {}),
    });
  }
  return {
    booking: first.booking, manageToken: first.token,
    ...(rec ? { series: result.rows.map((r) => ({ booking: r.booking, manageToken: r.token })) } : {}),
  };
}

/** Primary (non-shadow) occurrences of a series in time order, excluding rows retired by reschedule. */
async function loadSeriesRows(x: Db | Tx, seriesId: string, fallback?: Booking): Promise<{ booking: Booking; manageToken: string | null }[]> {
  const rows = await (x as Db).select().from(schema.bookings)
    .where(and(eq(schema.bookings.seriesId, seriesId), sql`not (${schema.bookings.externalEventIds} ? 'collectiveOf')`, sql`${schema.bookings.status} <> 'rescheduled'`))
    .orderBy(asc(schema.bookings.startsAt));
  const list = rows.length ? rows : fallback ? [fallback] : [];
  return list.map((booking) => ({ booking, manageToken: null }));
}

// ───────── lookup helpers
export interface BookingRef { bookingId?: string; manageToken?: string }

/** Resolve to the PRIMARY booking row (collective shadow rows resolve to their primary). */
async function loadPrimary(x: Db | Tx, ref: BookingRef, forUpdate = false): Promise<Booking> {
  const q = x as Db;
  let where;
  if (ref.manageToken) where = eq(schema.bookings.manageTokenHash, hashToken(ref.manageToken));
  else if (ref.bookingId) where = eq(schema.bookings.id, ref.bookingId);
  else throw new AppError("VALIDATION", "bookingId or manageToken required", 400);
  const base = q.select().from(schema.bookings).where(where).limit(1);
  const [row] = forUpdate ? await base.for("update") : await base;
  if (!row) throw new AppError("NOT_FOUND", "Booking not found", 404);
  const parent = (row.externalEventIds as Record<string, string>)?.collectiveOf;
  if (parent) return loadPrimary(x, { bookingId: parent }, forUpdate);
  return row;
}

async function loadGroup(x: Db | Tx, primary: Booking): Promise<Booking[]> {
  return (x as Db).select().from(schema.bookings).where(sql`${schema.bookings.id} = ${primary.id} or ${schema.bookings.externalEventIds}->>'collectiveOf' = ${primary.id}`);
}

async function inviteeOf(x: Db | Tx, bookingId: string) {
  const [inv] = await (x as Db).select().from(schema.invitees).where(eq(schema.invitees.bookingId, bookingId)).limit(1);
  return inv;
}

// ───────── reschedule
export interface RescheduleInput extends BookingRef {
  newStartsAt: string | Date; actor?: Actor; actorId?: string; reason?: string; inviteeTimeZone?: string;
}
export async function rescheduleBooking(input: RescheduleInput, deps: Deps = {}): Promise<BookingResult> {
  const start = new Date(input.newStartsAt);
  if (Number.isNaN(start.getTime())) throw new AppError("VALIDATION", "Invalid newStartsAt", 400);
  const actor = input.actor ?? (input.manageToken ? "invitee" : "host");
  const now = deps.now ?? new Date();

  const old0 = await loadPrimary(db, input);
  const ctx = await loadEventContext(db, old0.eventTypeId);
  const busy = await prefetchBusy(ctx, start, deps.busyProvider ?? defaultBusyProvider);

  const result = await runWrite(() => db.transaction(async (tx) => {
    await lock(tx, [`event:${ctx.event.id}`, ...ctx.hosts.map((h) => `host:${h.userId}`)]);
    const old = await loadPrimary(tx, { bookingId: old0.id }, true);
    if (!ACTIVE.includes(old.status)) throw new AppError("INVALID_STATE", `Booking is ${old.status} and cannot be rescheduled`, 409);
    if (actor === "invitee") {
      if (!ctx.event.allowReschedule) throw new AppError("FORBIDDEN", "Rescheduling is not allowed for this event", 403);
      if (old.startsAt.getTime() - now.getTime() < ctx.event.minCancelNoticeMinutes * MIN) throw new AppError("FORBIDDEN", "Too close to the start time to reschedule", 403);
    }
    const oldRows = await loadGroup(tx, old);
    const slots = await computeSlots(tx, ctx, { from: start, to: new Date(start.getTime() + 1), now, busyProvider: busy, excludeBookingId: old.id });
    const slot = slots.find((s) => s.startsAt === start.toISOString());
    if (!slot) throw slotGone();

    let hostIds: string[];
    if (ctx.event.kind === "collective") hostIds = ctx.hosts.map((h) => h.userId);
    else if (ctx.event.kind === "round_robin" && slot.hostUserIds?.includes(old.hostUserId)) hostIds = [old.hostUserId];
    else hostIds = [slot.hostUserId];

    // Retire the old rows FIRST so the exclusion constraint no longer counts them.
    await tx.update(schema.bookings).set({ status: "rescheduled", updatedAt: new Date() }).where(inArray(schema.bookings.id, oldRows.map((r) => r.id)));
    for (const r of oldRows) {
      await tx.insert(schema.bookingEvents).values({ bookingId: r.id, type: "rescheduled", actor, data: { from: r.startsAt.toISOString(), to: start.toISOString(), reason: input.reason ?? null, actorId: input.actorId ?? null } });
    }

    const oldInv = await inviteeOf(tx, old.id);
    if (!oldInv) throw new AppError("INTERNAL", "Booking has no invitee", 500);
    const ans = await tx.select().from(schema.inviteeAnswers).where(eq(schema.inviteeAnswers.inviteeId, oldInv.id));
    const previous = new Map(oldRows.map((r) => [r.hostUserId, r.id]));
    const g = await insertBookingGroup(tx, {
      ctx, hostIds, start, status: old.status,
      invitee: { name: oldInv.name, email: oldInv.email, phone: oldInv.phone, timeZone: input.inviteeTimeZone ?? old.inviteeTimeZone },
      answers: ans.map((a) => ({ questionId: a.questionId ?? "", question: a.question, answer: a.answer })).filter((a) => a.questionId),
      actor, previous: new Map(hostIds.map((h) => [h, previous.get(h) ?? old.id])),
      eventData: { rescheduledFromId: old.id }, seriesId: old.seriesId, // one occurrence moves; the series membership is kept
    });
    // answers whose question was deleted keep their text but have no questionId; re-attach them to the new invitee
    const orphan = ans.filter((a) => !a.questionId);
    if (orphan.length) {
      const inv = await inviteeOf(tx, g.booking.id);
      await tx.insert(schema.inviteeAnswers).values(orphan.map((a) => ({ inviteeId: inv.id, questionId: null, question: a.question, answer: a.answer })));
    }
    return { booking: g.booking, token: g.token, previousId: old.id };
  }));
  await onBookingEvent("booking.rescheduled", result.booking.id, { manageToken: result.token, previousBookingId: result.previousId });
  return { booking: result.booking, manageToken: result.token };
}

// ───────── cancel
export interface CancelInput extends BookingRef {
  actor?: Actor; actorId?: string; reason?: string;
  /** "series" cancels every still-cancellable occurrence of the series the referenced booking belongs to. */
  scope?: "occurrence" | "series";
}
export async function cancelBooking(input: CancelInput, deps: Deps = {}): Promise<Booking> {
  if (input.scope === "series") return cancelSeries(input, deps);
  const actor = input.actor ?? (input.manageToken ? "invitee" : "host");
  const now = deps.now ?? new Date();
  let changed = false;
  const booking = await db.transaction(async (tx) => {
    const old = await loadPrimary(tx, input, true);
    if (old.status === "cancelled") return old; // idempotent
    if (!ACTIVE.includes(old.status)) throw new AppError("INVALID_STATE", `Booking is ${old.status} and cannot be cancelled`, 409);
    if (actor === "invitee") {
      const [ev] = await tx.select({ n: schema.eventTypes.minCancelNoticeMinutes }).from(schema.eventTypes).where(eq(schema.eventTypes.id, old.eventTypeId));
      if (ev && old.startsAt.getTime() - now.getTime() < ev.n * MIN) throw new AppError("FORBIDDEN", "Too close to the start time to cancel", 403);
    }
    const rows = await loadGroup(tx, old);
    const ids = rows.map((r) => r.id);
    await tx.update(schema.bookings).set({ status: "cancelled", cancelledAt: now, cancelReason: input.reason ?? null, cancelledBy: actor, updatedAt: now }).where(inArray(schema.bookings.id, ids));
    await tx.update(schema.invitees).set({ cancelledAt: now }).where(inArray(schema.invitees.bookingId, ids));
    for (const id of ids) await tx.insert(schema.bookingEvents).values({ bookingId: id, type: "cancelled", actor, data: { reason: input.reason ?? null, actorId: input.actorId ?? null } });
    changed = true;
    const [fresh] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, old.id));
    return fresh;
  });
  if (changed) await onBookingEvent("booking.cancelled", booking.id);
  return booking;
}

/** Cancels all future, still-active occurrences of a series in ONE transaction (all-or-nothing). */
async function cancelSeries(input: CancelInput, deps: Deps): Promise<Booking> {
  const actor = input.actor ?? (input.manageToken ? "invitee" : "host");
  const now = deps.now ?? new Date();
  const emitted: { id: string; seriesIndex: number; seriesCount: number }[] = [];
  const booking = await db.transaction(async (tx) => {
    const old = await loadPrimary(tx, input, true);
    if (!old.seriesId) throw new AppError("INVALID_STATE", "This booking is not part of a recurring series", 409);
    const [ev] = await tx.select({ n: schema.eventTypes.minCancelNoticeMinutes }).from(schema.eventTypes).where(eq(schema.eventTypes.id, old.eventTypeId));
    const cutoff = actor === "invitee" ? now.getTime() + (ev?.n ?? 0) * MIN : now.getTime();
    const active = await tx.select().from(schema.bookings)
      .where(and(eq(schema.bookings.seriesId, old.seriesId), inArray(schema.bookings.status, ACTIVE)))
      .orderBy(asc(schema.bookings.startsAt), asc(schema.bookings.id)).for("update");
    const targets = active.filter((r) => r.startsAt.getTime() > now.getTime() && r.startsAt.getTime() >= cutoff);
    if (!targets.length) {
      if (active.some((r) => r.startsAt.getTime() > now.getTime())) throw new AppError("FORBIDDEN", "Too close to the start time to cancel", 403);
      const [fresh] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, old.id));
      return fresh; // nothing left to cancel (idempotent)
    }
    const ids = targets.map((r) => r.id);
    await tx.update(schema.bookings).set({ status: "cancelled", cancelledAt: now, cancelReason: input.reason ?? null, cancelledBy: actor, updatedAt: now }).where(inArray(schema.bookings.id, ids));
    await tx.update(schema.invitees).set({ cancelledAt: now }).where(inArray(schema.invitees.bookingId, ids));
    for (const id of ids) await tx.insert(schema.bookingEvents).values({ bookingId: id, type: "cancelled", actor, data: { reason: input.reason ?? null, actorId: input.actorId ?? null, scope: "series" } });
    const primaries = targets.filter((r) => !(r.externalEventIds as Record<string, string>)?.collectiveOf);
    primaries.forEach((r, i) => emitted.push({ id: r.id, seriesIndex: i, seriesCount: primaries.length }));
    const [fresh] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, old.id));
    return fresh;
  });
  for (const e of emitted) await onBookingEvent("booking.cancelled", e.id, { seriesIndex: e.seriesIndex, seriesCount: e.seriesCount });
  return booking;
}

// ───────── host approval (requires_confirmation)
export interface DecideInput extends BookingRef { actor?: Actor; actorId?: string; reason?: string }

/** Rows a decision applies to: the whole series (pending occurrences) or the booking's collective group. */
async function pendingSet(tx: Tx, old: Booking): Promise<Booking[]> {
  const rows = old.seriesId
    ? await tx.select().from(schema.bookings).where(eq(schema.bookings.seriesId, old.seriesId)).orderBy(asc(schema.bookings.startsAt), asc(schema.bookings.id)).for("update")
    : await loadGroup(tx, old);
  return rows.filter((r) => r.status === "pending_confirmation");
}
const primariesOf = (rows: Booking[]) => rows.filter((r) => !(r.externalEventIds as Record<string, string>)?.collectiveOf);

/**
 * Host approves a request: pending_confirmation -> confirmed (for a series: every pending occurrence). The slot was
 * held the whole time (the exclusion constraint covers pending_confirmation), so approval cannot lose a race.
 * Authorization is the caller's job (dashboard/API check host/org access first).
 */
export async function approveBooking(input: DecideInput, deps: Deps = {}): Promise<Booking> {
  const actor = input.actor ?? "host";
  const now = deps.now ?? new Date();
  const emitted: { id: string; i: number; n: number }[] = [];
  const booking = await db.transaction(async (tx) => {
    const old = await loadPrimary(tx, input, true);
    if (old.status === "confirmed") return old; // idempotent
    if (old.status !== "pending_confirmation") throw new AppError("INVALID_STATE", `Booking is ${old.status}; only pending requests can be approved`, 409);
    if (old.startsAt.getTime() <= now.getTime()) throw new AppError("INVALID_STATE", "This request is for a time that has already started", 409);
    const rows = await pendingSet(tx, old);
    const ids = rows.map((r) => r.id);
    try {
      await tx.update(schema.bookings).set({ status: "confirmed", holdExpiresAt: null, updatedAt: now }).where(inArray(schema.bookings.id, ids));
    } catch (e) { if (pgCode(e) === "23P01") throw slotGone(); throw e; }
    for (const id of ids) await tx.insert(schema.bookingEvents).values({ bookingId: id, type: "approved", actor, data: { from: "pending_confirmation", actorId: input.actorId ?? null } });
    const prim = primariesOf(rows);
    prim.forEach((r, i) => emitted.push({ id: r.id, i, n: prim.length }));
    const [fresh] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, old.id));
    return fresh;
  });
  for (const e of emitted) await onBookingEvent("booking.confirmed", e.id, { approved: true, ...(booking.seriesId ? { seriesIndex: e.i, seriesCount: e.n } : {}) });
  return booking;
}

/**
 * Host declines a request: pending_confirmation -> cancelled (cancelled_by = host, so any payment is refunded in full
 * by the refund policy) and the slot is released immediately. For a series the whole series is declined.
 */
export async function declineBooking(input: DecideInput, deps: Deps = {}): Promise<Booking> {
  const actor = input.actor ?? "host";
  const now = deps.now ?? new Date();
  const reason = input.reason?.trim().slice(0, 500) || null;
  const emitted: { id: string; i: number; n: number }[] = [];
  const booking = await db.transaction(async (tx) => {
    const old = await loadPrimary(tx, input, true);
    if (old.status === "cancelled" && old.cancelledBy === "host") return old; // idempotent
    if (old.status !== "pending_confirmation") throw new AppError("INVALID_STATE", `Booking is ${old.status}; only pending requests can be declined`, 409);
    const rows = await pendingSet(tx, old);
    const ids = rows.map((r) => r.id);
    await tx.update(schema.bookings).set({ status: "cancelled", cancelledAt: now, cancelReason: reason, cancelledBy: "host", holdExpiresAt: null, updatedAt: now }).where(inArray(schema.bookings.id, ids));
    await tx.update(schema.invitees).set({ cancelledAt: now }).where(inArray(schema.invitees.bookingId, ids));
    for (const id of ids) await tx.insert(schema.bookingEvents).values({ bookingId: id, type: "declined", actor, data: { reason, actorId: input.actorId ?? null } });
    const prim = primariesOf(rows);
    prim.forEach((r, i) => emitted.push({ id: r.id, i, n: prim.length }));
    const [fresh] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, old.id));
    return fresh;
  });
  for (const e of emitted) await onBookingEvent("booking.declined", e.id, { reason: reason ?? undefined, ...(booking.seriesId ? { seriesIndex: e.i, seriesCount: e.n } : {}) });
  return booking;
}

// ───────── mark
const MARKABLE: Partial<Record<BookingStatus, BookingStatus[]>> = {
  pending_payment: ["confirmed", "expired"],
  confirmed: ["completed", "no_show"],
  completed: ["no_show", "confirmed"],
  no_show: ["completed", "confirmed"],
};
const MARK_EVENT: Partial<Record<BookingStatus, BookingEventType>> = {
  confirmed: "booking.confirmed", completed: "booking.completed", no_show: "booking.no_show", expired: "booking.expired",
};
export async function markBooking(input: BookingRef & { status: BookingStatus; actor?: Actor; actorId?: string }): Promise<Booking> {
  let changed = false;
  let target = input.status;
  const booking = await db.transaction(async (tx) => {
    const old = await loadPrimary(tx, input, true);
    if (old.status === input.status) return old;
    if (!MARKABLE[old.status]?.includes(input.status)) throw new AppError("INVALID_STATE", `Cannot change booking from ${old.status} to ${input.status}`, 409);
    // Payment settled for an event that also needs host approval: it becomes a request, not a confirmed booking.
    if (old.status === "pending_payment" && input.status === "confirmed") {
      const [ev] = await tx.select({ requiresConfirmation: schema.eventTypes.requiresConfirmation }).from(schema.eventTypes).where(eq(schema.eventTypes.id, old.eventTypeId));
      if (ev) target = statusAfterPayment(ev);
    }
    if (old.status === target) return old;
    const rows = await loadGroup(tx, old);
    const ids = rows.map((r) => r.id);
    try {
      await tx.update(schema.bookings).set({ status: target, updatedAt: new Date(), ...(target === "confirmed" || target === "pending_confirmation" ? { holdExpiresAt: null } : {}) }).where(inArray(schema.bookings.id, ids));
    } catch (e) { if (pgCode(e) === "23P01") throw slotGone(); throw e; }
    for (const id of ids) await tx.insert(schema.bookingEvents).values({ bookingId: id, type: `marked_${target}`, actor: input.actor ?? "host", data: { from: old.status, actorId: input.actorId ?? null } });
    changed = true;
    const [fresh] = await tx.select().from(schema.bookings).where(eq(schema.bookings.id, old.id));
    return fresh;
  });
  const ev = MARK_EVENT[target];
  if (changed && ev) await onBookingEvent(ev, booking.id);
  return booking;
}

// ───────── manage link
export async function getBookingByManageToken(token: string) {
  if (!token) throw new AppError("NOT_FOUND", "Booking not found", 404);
  const booking = await loadPrimary(db, { manageToken: token });
  const [eventType] = await db.select({
    id: schema.eventTypes.id, title: schema.eventTypes.title, slug: schema.eventTypes.slug, kind: schema.eventTypes.kind,
    durationMinutes: schema.eventTypes.durationMinutes, locationType: schema.eventTypes.locationType, locationValue: schema.eventTypes.locationValue,
    allowReschedule: schema.eventTypes.allowReschedule, minCancelNoticeMinutes: schema.eventTypes.minCancelNoticeMinutes,
    cancellationPolicy: schema.eventTypes.cancellationPolicy, ownerUserId: schema.eventTypes.ownerUserId,
  }).from(schema.eventTypes).where(eq(schema.eventTypes.id, booking.eventTypeId));
  const invitee = await inviteeOf(db, booking.id);
  const answers = invitee ? await db.select().from(schema.inviteeAnswers).where(eq(schema.inviteeAnswers.inviteeId, invitee.id)) : [];
  const hostIds = (await loadGroup(db, booking)).map((r) => r.hostUserId);
  const hosts = await db.select({ id: schema.users.id, name: schema.users.name, username: schema.users.username, image: schema.users.image }).from(schema.users).where(inArray(schema.users.id, hostIds));
  const [next] = await db.select({ id: schema.bookings.id, startsAt: schema.bookings.startsAt }).from(schema.bookings).where(eq(schema.bookings.rescheduledFromId, booking.id)).limit(1);
  return { booking, eventType, invitee, answers, hosts, rescheduledTo: next ?? null };
}

export type { Executor };
