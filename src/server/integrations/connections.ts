/** Connection management service (no HTTP/React): used by route handlers and the integrations page. */
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getProvider } from "./provider";
import { fetchIdentity, exchangeCode } from "./oauth";
import { encodeCreds, withCalendarToken } from "./tokens";
import { ProviderError } from "./http";
import { revokeBestEffort } from "./revoke";
import type { OAuthProviderName, TokenSet } from "./types";

const { connectedCalendars, calendars, calendarSyncStates, calendarBusy, videoConnections } = schema;

export async function completeOAuth(userId: string, provider: OAuthProviderName, code: string, verifier: string) {
  const tokens: TokenSet = await exchangeCode(provider, code, verifier);
  const ident = await fetchIdentity(provider, tokens.accessToken);
  if (provider === "zoom") {
    const enc = encodeCreds(tokens);
    await db.insert(videoConnections).values({ userId, provider, externalAccountId: ident.id, email: ident.email, credentialsEnc: enc })
      .onConflictDoUpdate({ target: [videoConnections.userId, videoConnections.provider], set: { externalAccountId: ident.id, email: ident.email, credentialsEnc: enc, status: "active", lastError: null } });
    return { kind: "video" as const };
  }
  if (!tokens.refreshToken) {
    // Without a refresh token the connection would silently die in an hour.
    const [existing] = await db.select({ enc: connectedCalendars.credentialsEnc }).from(connectedCalendars)
      .where(and(eq(connectedCalendars.userId, userId), eq(connectedCalendars.provider, provider), eq(connectedCalendars.externalAccountId, ident.id))).limit(1);
    if (!existing) throw new ProviderError("Provider did not return a refresh token; remove the app's access in your account and reconnect.", "auth", 400);
  }
  const enc = encodeCreds(tokens);
  const [row] = await db.insert(connectedCalendars).values({ userId, provider, externalAccountId: ident.id, email: ident.email, credentialsEnc: enc })
    .onConflictDoUpdate({ target: [connectedCalendars.userId, connectedCalendars.provider, connectedCalendars.externalAccountId], set: { credentialsEnc: enc, email: ident.email, status: "active", lastError: null } })
    .returning({ id: connectedCalendars.id });
  await refreshCalendarList(userId, row.id);
  return { kind: "calendar" as const, connectedCalendarId: row.id };
}

/** Pull the provider's calendar list and upsert rows; sensible defaults for first connection. */
export async function refreshCalendarList(userId: string, connectedCalendarId: string) {
  const [conn] = await db.select().from(connectedCalendars).where(and(eq(connectedCalendars.id, connectedCalendarId), eq(connectedCalendars.userId, userId))).limit(1);
  if (!conn) throw new ProviderError("Connection not found", "not_found", 404);
  const provider = getProvider(conn.provider);
  const remote = await withCalendarToken(conn.id, conn.provider, (t) => provider.getCalendars(t));
  const existing = await db.select().from(calendars).where(eq(calendars.connectedCalendarId, conn.id));
  const known = new Set(existing.map((c) => c.externalId));
  const userHasDestination = (await db.select({ id: calendars.id }).from(calendars)
    .innerJoin(connectedCalendars, eq(calendars.connectedCalendarId, connectedCalendars.id))
    .where(and(eq(connectedCalendars.userId, userId), eq(calendars.isDestination, true))).limit(1)).length > 0;
  let destinationAssigned = userHasDestination;
  for (const rc of remote) {
    if (known.has(rc.externalId)) {
      await db.update(calendars).set({ name: rc.name }).where(and(eq(calendars.connectedCalendarId, conn.id), eq(calendars.externalId, rc.externalId)));
      continue;
    }
    const makeDest = !destinationAssigned && rc.primary && rc.writable;
    if (makeDest) destinationAssigned = true;
    // Only the primary calendar blocks time by default; others are opt-in (avoids e.g. holiday calendars blocking everything).
    await db.insert(calendars).values({ connectedCalendarId: conn.id, externalId: rc.externalId, name: rc.name, checkConflicts: rc.primary, isDestination: makeDest });
  }
  return remote.length;
}

export async function listConnections(userId: string) {
  const conns = await db.select({
    id: connectedCalendars.id, provider: connectedCalendars.provider, email: connectedCalendars.email,
    status: connectedCalendars.status, lastError: connectedCalendars.lastError, createdAt: connectedCalendars.createdAt,
  }).from(connectedCalendars).where(eq(connectedCalendars.userId, userId));
  const ids = conns.map((c) => c.id);
  const cals = ids.length ? await db.select().from(calendars).where(inArray(calendars.connectedCalendarId, ids)) : [];
  const states = cals.length ? await db.select().from(calendarSyncStates).where(inArray(calendarSyncStates.calendarId, cals.map((c) => c.id))) : [];
  const stateBy = new Map(states.map((s) => [s.calendarId, s]));
  const video = await db.select({ id: videoConnections.id, provider: videoConnections.provider, email: videoConnections.email, status: videoConnections.status, lastError: videoConnections.lastError })
    .from(videoConnections).where(eq(videoConnections.userId, userId));
  return {
    connections: conns.map((c) => ({
      ...c,
      calendars: cals.filter((k) => k.connectedCalendarId === c.id).map((k) => ({
        id: k.id, name: k.name, checkConflicts: k.checkConflicts, isDestination: k.isDestination,
        lastSyncedAt: stateBy.get(k.id)?.lastSyncedAt ?? null, syncError: stateBy.get(k.id)?.lastError ?? null,
        pushActive: !!stateBy.get(k.id)?.channelId && (stateBy.get(k.id)?.channelExpiresAt?.getTime() ?? 0) > Date.now(),
      })),
    })),
    video,
  };
}

export async function updateCalendarOptions(userId: string, calendarId: string, patch: { checkConflicts?: boolean; isDestination?: boolean }) {
  const [row] = await db.select({ cal: calendars, conn: connectedCalendars }).from(calendars)
    .innerJoin(connectedCalendars, eq(calendars.connectedCalendarId, connectedCalendars.id))
    .where(and(eq(calendars.id, calendarId), eq(connectedCalendars.userId, userId))).limit(1);
  if (!row) throw new ProviderError("Calendar not found", "not_found", 404);
  await db.transaction(async (tx) => {
    if (patch.isDestination === true) {
      const mine = await tx.select({ id: calendars.id }).from(calendars)
        .innerJoin(connectedCalendars, eq(calendars.connectedCalendarId, connectedCalendars.id))
        .where(and(eq(connectedCalendars.userId, userId), ne(calendars.id, calendarId)));
      if (mine.length) await tx.update(calendars).set({ isDestination: false }).where(inArray(calendars.id, mine.map((m) => m.id)));
    }
    const set: Partial<typeof calendars.$inferInsert> = {};
    if (patch.checkConflicts !== undefined) set.checkConflicts = patch.checkConflicts;
    if (patch.isDestination !== undefined) set.isDestination = patch.isDestination;
    if (Object.keys(set).length) await tx.update(calendars).set(set).where(eq(calendars.id, calendarId));
  });
  if (patch.checkConflicts === false) await db.delete(calendarBusy).where(eq(calendarBusy.calendarId, calendarId));
}

export async function disconnectCalendar(userId: string, connectedCalendarId: string) {
  const [conn] = await db.select().from(connectedCalendars).where(and(eq(connectedCalendars.id, connectedCalendarId), eq(connectedCalendars.userId, userId))).limit(1);
  if (!conn) throw new ProviderError("Connection not found", "not_found", 404);
  await revokeBestEffort(conn.id, conn.provider); // stops push channels and revokes the token; failures are tolerated
  await db.delete(connectedCalendars).where(eq(connectedCalendars.id, conn.id)); // cascades calendars, sync state, busy cache
}

export async function disconnectVideo(userId: string, provider: string) {
  const [c] = await db.select().from(videoConnections).where(and(eq(videoConnections.userId, userId), eq(videoConnections.provider, provider))).limit(1);
  if (!c) return;
  await db.delete(videoConnections).where(eq(videoConnections.id, c.id));
}

