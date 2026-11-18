/**
 * Incremental sync of external calendars into calendar_busy.
 * Google: events.list syncToken + events.watch channels. Microsoft: calendarView/delta deltaLink + Graph subscriptions.
 * Webhooks only trigger a sync; correctness never depends on them (syncAllDue also polls).
 */
import { and, eq, inArray, lt, or, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { hmacSign, safeEqual } from "@/lib/crypto";
import { getProvider } from "./provider";
import { ProviderError } from "./http";
import { withCalendarToken } from "./tokens";
import { canReceiveWebhooks, webhookUrl } from "./config";

const { calendars, connectedCalendars, calendarSyncStates, calendarBusy } = schema;

const WINDOW_PAST_MS = 24 * 3600_000;
const WINDOW_FUTURE_MS = 120 * 24 * 3600_000;
const POLL_INTERVAL_MS = 10 * 60_000;
const RENEW_BEFORE_MS = 24 * 3600_000;

export const webhookSecret = (calendarId: string) => hmacSign(calendarId, "webhook");

async function loadCalendar(calendarId: string) {
  const [row] = await db.select({ cal: calendars, conn: connectedCalendars }).from(calendars)
    .innerJoin(connectedCalendars, eq(calendars.connectedCalendarId, connectedCalendars.id)).where(eq(calendars.id, calendarId)).limit(1);
  return row;
}

async function setState(calendarId: string, patch: Partial<typeof calendarSyncStates.$inferInsert>) {
  await db.insert(calendarSyncStates).values({ calendarId, ...patch }).onConflictDoUpdate({ target: calendarSyncStates.calendarId, set: patch });
}

/** Sync one calendar. Never throws: errors are persisted on calendar_sync_state / connected_calendar. */
export async function syncCalendar(calendarId: string, opts: { full?: boolean } = {}): Promise<{ ok: boolean; changes: number; error?: string }> {
  const row = await loadCalendar(calendarId);
  if (!row) return { ok: false, changes: 0, error: "calendar not found" };
  const { cal, conn } = row;
  if (conn.status !== "active") return { ok: false, changes: 0, error: `connection ${conn.status}` };
  if (!cal.checkConflicts) return { ok: true, changes: 0 };
  const provider = getProvider(conn.provider);
  const [state] = await db.select().from(calendarSyncStates).where(eq(calendarSyncStates.calendarId, calendarId)).limit(1);
  const now = Date.now();
  const range = { from: new Date(now - WINDOW_PAST_MS), to: new Date(now + WINDOW_FUTURE_MS) };
  try {
    const result = await withCalendarToken(conn.id, conn.provider, async (token) => {
      try {
        return await provider.listChanges(token, cal.externalId, { syncToken: opts.full ? null : state?.syncToken, ...range });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === "gone" && state?.syncToken) {
          return provider.listChanges(token, cal.externalId, { syncToken: null, ...range }); // token expired: full resync
        }
        throw e;
      }
    });
    await db.transaction(async (tx) => {
      if (result.reset) await tx.delete(calendarBusy).where(eq(calendarBusy.calendarId, calendarId));
      const upserts = result.changes.filter((c) => c.busy).map((c) => ({ calendarId, externalEventId: c.id, startsAt: c.busy!.start, endsAt: c.busy!.end }));
      const removals = result.changes.filter((c) => !c.busy).map((c) => c.id);
      for (let i = 0; i < upserts.length; i += 500) {
        await tx.insert(calendarBusy).values(upserts.slice(i, i + 500)).onConflictDoUpdate({
          target: [calendarBusy.calendarId, calendarBusy.externalEventId],
          set: { startsAt: sql`excluded.starts_at`, endsAt: sql`excluded.ends_at` },
        });
      }
      for (let i = 0; i < removals.length; i += 500) {
        await tx.delete(calendarBusy).where(and(eq(calendarBusy.calendarId, calendarId), inArray(calendarBusy.externalEventId, removals.slice(i, i + 500))));
      }
      await tx.delete(calendarBusy).where(and(eq(calendarBusy.calendarId, calendarId), lt(calendarBusy.endsAt, new Date(now - WINDOW_PAST_MS))));
    });
    await setState(calendarId, { syncToken: result.nextSyncToken, lastSyncedAt: new Date(), lastError: null });
    return { ok: true, changes: result.changes.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setState(calendarId, { lastError: msg.slice(0, 500) }).catch(() => undefined);
    return { ok: false, changes: 0, error: msg };
  }
}

/** Create/renew the push channel when the public url allows it. Never throws. */
export async function ensureSubscription(calendarId: string): Promise<"active" | "unsupported" | "error"> {
  const row = await loadCalendar(calendarId);
  if (!row || row.conn.status !== "active" || !row.cal.checkConflicts) return "unsupported";
  if (!canReceiveWebhooks()) return "unsupported";
  const [state] = await db.select().from(calendarSyncStates).where(eq(calendarSyncStates.calendarId, calendarId)).limit(1);
  const provider = getProvider(row.conn.provider);
  try {
    const sub = await withCalendarToken(row.conn.id, row.conn.provider, (t) => provider.refreshSubscription(t, {
      calendarId: row.cal.externalId, existing: state?.channelId ? { id: state.channelId, resourceId: state.channelResourceId } : null,
      notificationUrl: webhookUrl(row.conn.provider), secret: webhookSecret(calendarId),
    }));
    if (!sub) return "unsupported";
    await setState(calendarId, { channelId: sub.id, channelResourceId: sub.resourceId ?? null, channelExpiresAt: sub.expiresAt });
    return "active";
  } catch (e) {
    await setState(calendarId, { lastError: `subscription: ${e instanceof Error ? e.message : e}`.slice(0, 500) }).catch(() => undefined);
    return "error";
  }
}

/** Sync + subscribe every conflict-checking calendar of one user's connection (after connect / manual refresh). */
export async function syncConnection(connectedCalendarId: string, opts: { full?: boolean } = {}) {
  const cals = await db.select({ id: calendars.id }).from(calendars).where(and(eq(calendars.connectedCalendarId, connectedCalendarId), eq(calendars.checkConflicts, true)));
  for (const c of cals) { await syncCalendar(c.id, opts); await ensureSubscription(c.id); }
}

/** Periodic job (worker/cron): poll stale calendars, renew expiring channels. */
export async function syncAllDue(): Promise<{ synced: number; renewed: number }> {
  const rows = await db.select({ id: calendars.id, state: calendarSyncStates })
    .from(calendars).innerJoin(connectedCalendars, eq(calendars.connectedCalendarId, connectedCalendars.id))
    .leftJoin(calendarSyncStates, eq(calendarSyncStates.calendarId, calendars.id))
    .where(and(eq(connectedCalendars.status, "active"), eq(calendars.checkConflicts, true)));
  let synced = 0, renewed = 0;
  const now = Date.now();
  for (const r of rows) {
    const hasPush = !!r.state?.channelId && (r.state.channelExpiresAt?.getTime() ?? 0) > now;
    // With a live push channel we only poll as a safety net (hourly); without, every POLL_INTERVAL_MS.
    const maxAge = hasPush ? 60 * 60_000 : POLL_INTERVAL_MS;
    if (!r.state?.lastSyncedAt || now - r.state.lastSyncedAt.getTime() > maxAge) { await syncCalendar(r.id); synced++; }
    if (canReceiveWebhooks() && (!r.state?.channelId || (r.state.channelExpiresAt?.getTime() ?? 0) - now < RENEW_BEFORE_MS)) {
      if ((await ensureSubscription(r.id)) === "active") renewed++;
    }
  }
  return { synced, renewed };
}

/** Google push: headers X-Goog-Channel-ID / X-Goog-Channel-Token / X-Goog-Resource-State. Returns calendar id to sync (or null). */
export async function resolveGoogleNotification(h: { channelId: string | null; token: string | null; resourceState: string | null }): Promise<string | null> {
  if (!h.channelId || !h.token) return null;
  const [s] = await db.select({ calendarId: calendarSyncStates.calendarId }).from(calendarSyncStates).where(eq(calendarSyncStates.channelId, h.channelId)).limit(1);
  if (!s || !safeEqual(h.token, webhookSecret(s.calendarId))) return null;
  return h.resourceState === "sync" ? null : s.calendarId; // "sync" is the handshake message
}

/** Graph push: body { value: [{ subscriptionId, clientState, ... }] }. Returns calendar ids whose clientState verified. */
export async function resolveGraphNotifications(body: unknown): Promise<string[]> {
  const items = (body as { value?: { subscriptionId?: string; clientState?: string }[] } | null)?.value ?? [];
  const out = new Set<string>();
  for (const n of items) {
    if (!n.subscriptionId || !n.clientState) continue;
    const [s] = await db.select({ calendarId: calendarSyncStates.calendarId }).from(calendarSyncStates).where(eq(calendarSyncStates.channelId, n.subscriptionId)).limit(1);
    if (s && safeEqual(n.clientState, webhookSecret(s.calendarId))) out.add(s.calendarId);
  }
  return [...out];
}

export async function calendarsNeedingFirstSync(): Promise<string[]> {
  const rows = await db.select({ id: calendars.id }).from(calendars).leftJoin(calendarSyncStates, eq(calendarSyncStates.calendarId, calendars.id))
    .where(and(eq(calendars.checkConflicts, true), or(isNull(calendarSyncStates.calendarId), isNull(calendarSyncStates.lastSyncedAt))));
  return rows.map((r) => r.id);
}
