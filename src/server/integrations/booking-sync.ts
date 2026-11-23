/**
 * Booking -> external calendar / meeting-link orchestrator.
 *
 * afterBookingCreated / afterBookingUpdated / afterBookingCancelled all converge the external world to the booking's
 * current state (reconcileBooking), so they are idempotent and safe to retry/duplicate:
 *  - ids of created resources are persisted on booking.external_event_ids IMMEDIATELY after each step
 *    ("cal:<calendar row id>" -> event id, "zoom" -> meeting id, "sig" -> hash of the last synced state);
 *  - Google uses deterministic event ids and Graph uses transactionId, so a crash between create and persist is converged;
 *  - a per-booking Postgres advisory lock prevents concurrent reconciles;
 *  - a failed step never aborts the booking: failures are written to booking_event ("integration_sync_failed") and
 *    retryable ones (network/5xx/429) are re-enqueued with backoff on the "scheduler" queue;
 *  - compensation: if the booking was cancelled while creating, everything created is torn down again.
 * These functions never throw.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db, pool, schema } from "@/server/db";
import { sha256 } from "@/lib/crypto";
import { getProvider } from "./provider";
import { ProviderError } from "./http";
import { withCalendarToken } from "./tokens";
import { createZoomMeeting, deleteZoomMeeting, getZoomConnection, passthroughLocation, updateZoomMeeting } from "./video";
import type { EventInput } from "./types";
import { joinLink } from "@/server/public/join";
import { markBotScheduled, createBot, deleteBot, notesUrl, notetakerConfigured, scheduleCollect } from "@/server/notetaker";

const { bookings, bookingEvents, calendars, connectedCalendars, eventTypes, invitees, users } = schema;

export const INTEGRATION_QUEUE = "scheduler";
export const INTEGRATION_JOB = "integration-booking-sync";
const MAX_ATTEMPTS = 5;

export interface SyncFailure { step: string; error: string; retryable: boolean }
export interface SyncResult { ok: boolean; skipped?: boolean; changed: string[]; failures: SyncFailure[] }

type Ids = Record<string, string>;

const toFailure = (step: string, e: unknown): SyncFailure => ({
  step, error: (e instanceof Error ? e.message : String(e)).slice(0, 500), retryable: e instanceof ProviderError ? e.retryable : false,
});

async function patchIds(bookingId: string, set: Ids, remove: string[] = []) {
  const keys = remove.length ? sql.join(remove.map((k) => sql`${k}`), sql`, `) : sql``;
  await db.update(bookings).set({
    externalEventIds: sql`(coalesce(${bookings.externalEventIds}, '{}'::jsonb) || ${JSON.stringify(set)}::jsonb) - ARRAY[${keys}]::text[]`,
    updatedAt: new Date(),
  }).where(eq(bookings.id, bookingId));
}

async function withLock<T>(bookingId: string, fn: () => Promise<T>): Promise<{ locked: false } | { locked: true; value: T }> {
  const client = await pool.connect();
  try {
    const r = await client.query("select pg_try_advisory_lock(hashtext($1)) as ok", [`integrations:${bookingId}`]);
    if (!r.rows[0]?.ok) return { locked: false };
    try { return { locked: true, value: await fn() }; }
    finally { await client.query("select pg_advisory_unlock(hashtext($1))", [`integrations:${bookingId}`]).catch(() => undefined); }
  } finally { client.release(); }
}

async function loadBooking(bookingId: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  return b;
}

async function destinationCalendars(hostUserId: string) {
  return db.select({ cal: calendars, conn: connectedCalendars }).from(calendars)
    .innerJoin(connectedCalendars, eq(calendars.connectedCalendarId, connectedCalendars.id))
    .where(and(eq(connectedCalendars.userId, hostUserId), eq(calendars.isDestination, true)));
}

// ───────────────────────── teardown (cancel / reschedule-away / expire)
async function teardown(bookingId: string, hostUserId: string, ids: Ids, failures: SyncFailure[], changed: string[]) {
  for (const key of Object.keys(ids)) {
    if (key === "sig") continue;
    try {
      if (key.startsWith("cal:")) {
        const calRowId = key.slice(4);
        const [row] = await db.select({ cal: calendars, conn: connectedCalendars }).from(calendars)
          .innerJoin(connectedCalendars, eq(calendars.connectedCalendarId, connectedCalendars.id)).where(eq(calendars.id, calRowId)).limit(1);
        if (row) {
          if (row.conn.status === "needs_reauth") throw new ProviderError("Calendar connection needs re-authorization; event could not be removed", "auth", 401);
          await withCalendarToken(row.conn.id, row.conn.provider, (t) => getProvider(row.conn.provider).deleteEvent(t, row.cal.externalId, ids[key]));
        } // calendar/connection removed by the user: nothing left to delete
      } else if (key === "zoom") {
        const zc = await getZoomConnection(hostUserId);
        if (zc) await deleteZoomMeeting(zc.id, ids[key]);
      } else if (key === "recall") {
        await deleteBot(ids[key]);
      }
      await patchIds(bookingId, {}, [key]);
      delete ids[key];
      changed.push(`deleted:${key}`);
    } catch (e) {
      failures.push(toFailure(`delete:${key}`, e));
    }
  }
  if (!failures.length && ids.sig) { await patchIds(bookingId, {}, ["sig"]); delete ids.sig; }
}

// ───────────────────────── create/update
async function upsert(bookingId: string, ids: Ids, failures: SyncFailure[], changed: string[]) {
  const b = await loadBooking(bookingId);
  if (!b) return;
  const [et] = await db.select().from(eventTypes).where(eq(eventTypes.id, b.eventTypeId)).limit(1);
  const [host] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, b.hostUserId)).limit(1);
  const invs = await db.select().from(invitees).where(eq(invitees.bookingId, bookingId)).orderBy(asc(invitees.createdAt));
  const first = invs[0];
  const locType = b.locationType ?? et?.locationType ?? null;
  const title = `${et?.title ?? "Meeting"}${first ? ` with ${first.name}` : ""}`;
  const notes = notesUrl(bookingId);
  const description = [
    `Agenda: ${et?.title ?? "Meeting"}`,
    et?.description?.trim() || null,
    host ? `Host: ${host.name} (${host.email})` : null,
    invs.length ? `Attendees:\n${invs.map((i) => `- ${i.name} (${i.email})`).join("\n")}` : null,
    ["google_meet", "zoom", "teams", "custom_url"].includes(locType ?? "") ? `Join the meeting: ${joinLink(b.joinCode)}` : null,
    notes ? `Meeting notes: ${notes}` : null,
    et?.notetakerEnabled ? "A notetaker will join to record and transcribe this meeting." : null,
    `Booked via ${process.env.APP_NAME ?? "MeetFlow"}`,
  ].filter(Boolean).join("\n\n");
  const pass = passthroughLocation(locType, et?.locationValue, first?.phone);
  let meetingUrl: string | undefined = pass.meetingUrl;
  const sig = sha256(JSON.stringify([b.startsAt.toISOString(), b.endsAt.toISOString(), title, locType, et?.locationValue ?? null, first?.email ?? null]));
  const sigChanged = ids.sig !== sig;

  // 1) Zoom meeting
  if (locType === "zoom") {
    try {
      const zc = await getZoomConnection(b.hostUserId);
      if (!zc) throw new ProviderError("Zoom is not connected for the host; no meeting link was created", "other");
      if (zc.status !== "active") throw new ProviderError("Zoom connection needs re-authorization", "auth", 401);
      const input = { bookingId, topic: title, startsAt: b.startsAt, endsAt: b.endsAt, agenda: description };
      let created = false;
      if (ids.zoom) {
        meetingUrl = b.meetingUrl ?? undefined;
        if (sigChanged) {
          try { await updateZoomMeeting(zc.id, ids.zoom, input); changed.push("updated:zoom"); }
          catch (e) { if (e instanceof ProviderError && e.kind === "not_found") { delete ids.zoom; created = true; } else throw e; }
        }
      } else created = true;
      if (created) {
        const m = await createZoomMeeting(zc.id, input);
        ids.zoom = m.id; meetingUrl = m.joinUrl;
        await patchIds(bookingId, { zoom: m.id });
        changed.push("created:zoom");
      }
    } catch (e) { failures.push(toFailure("zoom", e)); }
  }
  if (meetingUrl && meetingUrl !== b.meetingUrl) {
    await db.update(bookings).set({ meetingUrl, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
  }

  // 2) Calendar events on the host's destination calendar(s)
  const dests = await destinationCalendars(b.hostUserId);
  if (locType === "google_meet" && !dests.some((d) => d.conn.provider === "google"))
    failures.push({ step: "google_meet", error: "Google Meet needs a Google destination calendar; no meeting link was created", retryable: false });
  if (locType === "teams" && !dests.some((d) => d.conn.provider === "microsoft"))
    failures.push({ step: "teams", error: "Microsoft Teams needs a Microsoft destination calendar; no meeting link was created", retryable: false });

  for (const { cal, conn } of dests) {
    const key = `cal:${cal.id}`;
    const step = `${conn.provider}:${cal.name}`;
    if (conn.status !== "active") { failures.push({ step, error: `Calendar connection ${conn.status}; reconnect it in Integrations`, retryable: false }); continue; }
    const native = (locType === "google_meet" && conn.provider === "google") || (locType === "teams" && conn.provider === "microsoft");
    const input: EventInput = {
      bookingId, title, description, startsAt: b.startsAt, endsAt: b.endsAt, location: pass.location,
      meetingUrl: native ? undefined : meetingUrl, nativeMeeting: native && !ids[key],
      attendees: [...(first ? invs.map((i) => ({ email: i.email, name: i.name })) : [])],
    };
    try {
      const provider = getProvider(conn.provider);
      let result: { id: string; meetingUrl?: string } | null = null;
      if (ids[key]) {
        if (sigChanged) {
          try { result = await withCalendarToken(conn.id, conn.provider, (t) => provider.updateEvent(t, cal.externalId, ids[key], { ...input, nativeMeeting: false })); changed.push(`updated:${key}`); }
          catch (e) { if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "gone")) { delete ids[key]; } else throw e; }
        }
      }
      if (!ids[key]) {
        result = await withCalendarToken(conn.id, conn.provider, (t) => provider.createEvent(t, cal.externalId, { ...input, nativeMeeting: native }));
        ids[key] = result.id;
        await patchIds(bookingId, { [key]: result.id });
        changed.push(`created:${key}`);
      }
      if (result?.meetingUrl && native && result.meetingUrl !== meetingUrl) {
        meetingUrl = result.meetingUrl;
        await db.update(bookings).set({ meetingUrl, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
      }
    } catch (e) { failures.push(toFailure(step, e)); }
  }

  // 3) Notetaker bot (needs the final meeting link; a new time or link replaces the bot)
  const joinUrl = meetingUrl ?? b.meetingUrl;
  if (et?.notetakerEnabled && notetakerConfigured() && joinUrl && b.endsAt > new Date()) {
    try {
      const want = `${b.startsAt.toISOString()}|${joinUrl}`;
      if (ids.recall && ids.recall_at !== want) {
        await deleteBot(ids.recall);
        await patchIds(bookingId, {}, ["recall", "recall_at"]);
        delete ids.recall; delete ids.recall_at;
      }
      if (!ids.recall) {
        const botId = await createBot(bookingId, joinUrl, b.startsAt);
        ids.recall = botId; ids.recall_at = want;
        await patchIds(bookingId, { recall: botId, recall_at: want });
        await markBotScheduled(bookingId, botId);
        await scheduleCollect(bookingId, botId, b.endsAt);
        changed.push("created:recall");
      }
    } catch (e) { failures.push(toFailure("notetaker", e)); }
  }

  if (!failures.length && sigChanged) { await patchIds(bookingId, { sig }); ids.sig = sig; }
}

// ───────────────────────── orchestration
export async function reconcileBooking(bookingId: string, opts: { attempt?: number } = {}): Promise<SyncResult> {
  const attempt = opts.attempt ?? 0;
  const failures: SyncFailure[] = [];
  const changed: string[] = [];
  try {
    const run = await withLock(bookingId, async () => {
      const b = await loadBooking(bookingId);
      if (!b) { failures.push({ step: "load", error: "booking not found", retryable: false }); return; }
      const ids: Ids = { ...(b.externalEventIds ?? {}) };
      if (b.status !== "confirmed") {
        await teardown(bookingId, b.hostUserId, ids, failures, changed);
        return;
      }
      await upsert(bookingId, ids, failures, changed);
      // Compensation: booking may have been cancelled/rescheduled while we were talking to providers.
      const after = await loadBooking(bookingId);
      if (after && after.status !== "confirmed") {
        const fresh: Ids = { ...(after.externalEventIds ?? {}) };
        await teardown(bookingId, after.hostUserId, fresh, failures, changed);
      }
    });
    if (!run.locked) {
      await scheduleRetry(bookingId, attempt, 5_000);
      return { ok: false, skipped: true, changed, failures };
    }
  } catch (e) {
    failures.push(toFailure("orchestrator", e));
    if (!(e instanceof ProviderError)) failures[failures.length - 1].retryable = true; // unexpected (db hiccup): retry
  }
  await record(bookingId, attempt, failures, changed);
  if (failures.some((f) => f.retryable)) await scheduleRetry(bookingId, attempt);
  return { ok: failures.length === 0, changed, failures };
}

async function record(bookingId: string, attempt: number, failures: SyncFailure[], changed: string[]) {
  try {
    if (failures.length) {
      await db.insert(bookingEvents).values({ bookingId, type: "integration_sync_failed", actor: "system", data: { attempt, failures } });
    } else if (changed.length) {
      await db.insert(bookingEvents).values({ bookingId, type: "integration_synced", actor: "system", data: { changed } });
    }
  } catch { /* auditing must never break the flow */ }
}

export async function scheduleRetry(bookingId: string, attempt: number, delayMs?: number): Promise<boolean> {
  if (attempt >= MAX_ATTEMPTS) return false;
  try {
    const { enqueue } = await import("@/server/queue");
    const delay = delayMs ?? Math.min(30_000 * 2 ** attempt, 3600_000);
    await enqueue(INTEGRATION_QUEUE, { name: INTEGRATION_JOB, data: { bookingId, attempt: attempt + 1 } },
      { delay, jobId: `isync-${bookingId}-${attempt + 1}`, attempts: 1 });
    return true;
  } catch { return false; } // queue unavailable: failure is recorded on the booking; the next update/manual retry converges
}

/** Worker entry: dispatch { bookingId, attempt } jobs named INTEGRATION_JOB on queue INTEGRATION_QUEUE. */
export async function processIntegrationJob(data: { bookingId: string; attempt?: number }) {
  return reconcileBooking(data.bookingId, { attempt: data.attempt ?? 0 });
}

export const afterBookingCreated = (bookingId: string) => reconcileBooking(bookingId);
export const afterBookingUpdated = (bookingId: string) => reconcileBooking(bookingId);
export const afterBookingCancelled = (bookingId: string) => reconcileBooking(bookingId);
