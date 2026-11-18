import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { ProviderError } from "./http";
import { refreshTokens } from "./oauth";
import type { OAuthProviderName, TokenSet } from "./types";

const { connectedCalendars, videoConnections } = schema;

interface Store {
  provider: OAuthProviderName;
  load(): Promise<{ credentialsEnc: string; status: string } | undefined>;
  save(enc: string): Promise<void>;
  setStatus(status: "active" | "needs_reauth" | "error", error: string | null): Promise<void>;
}

const inflight = new Map<string, Promise<TokenSet>>();
const SKEW_MS = 60_000;

export const encodeCreds = (t: TokenSet) => encrypt(JSON.stringify(t));
export const decodeCreds = (enc: string) => JSON.parse(decrypt(enc)) as TokenSet;

async function refresh(key: string, store: Store, current: TokenSet): Promise<TokenSet> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const next = await refreshTokens(store.provider, current);
      await store.save(encodeCreds(next));
      return next;
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "auth") {
        await store.setStatus("needs_reauth", e.message.slice(0, 500));
      }
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function withToken<T>(key: string, store: Store, fn: (accessToken: string) => Promise<T>): Promise<T> {
  const row = await store.load();
  if (!row) throw new ProviderError("Connection not found", "not_found", 404);
  if (row.status === "needs_reauth") throw new ProviderError("Connection needs to be re-authorized", "auth", 401);
  let creds = decodeCreds(row.credentialsEnc);
  if (creds.expiresAt - SKEW_MS <= Date.now()) creds = await refresh(key, store, creds);
  try {
    return await fn(creds.accessToken);
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "auth") {
      // Token might have been revoked or invalidated early: force one refresh and retry once.
      const fresh = await refresh(key, store, creds); // marks needs_reauth on invalid_grant
      try {
        return await fn(fresh.accessToken);
      } catch (e2) {
        if (e2 instanceof ProviderError && e2.kind === "auth") {
          await store.setStatus("needs_reauth", e2.message.slice(0, 500));
        }
        throw e2;
      }
    }
    throw e;
  }
}

export function withCalendarToken<T>(connectedCalendarId: string, provider: "google" | "microsoft", fn: (accessToken: string) => Promise<T>): Promise<T> {
  const where = eq(connectedCalendars.id, connectedCalendarId);
  return withToken(`cal:${connectedCalendarId}`, {
    provider,
    load: async () => (await db.select({ credentialsEnc: connectedCalendars.credentialsEnc, status: connectedCalendars.status }).from(connectedCalendars).where(where).limit(1))[0],
    save: async (enc) => { await db.update(connectedCalendars).set({ credentialsEnc: enc, status: "active", lastError: null }).where(where); },
    setStatus: async (status, error) => { await db.update(connectedCalendars).set({ status, lastError: error }).where(where); },
  }, fn);
}

export function withVideoToken<T>(videoConnectionId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
  const where = eq(videoConnections.id, videoConnectionId);
  return withToken(`video:${videoConnectionId}`, {
    provider: "zoom",
    load: async () => (await db.select({ credentialsEnc: videoConnections.credentialsEnc, status: videoConnections.status }).from(videoConnections).where(where).limit(1))[0],
    save: async (enc) => { await db.update(videoConnections).set({ credentialsEnc: enc, status: "active", lastError: null }).where(where); },
    setStatus: async (status, error) => { await db.update(videoConnections).set({ status, lastError: error }).where(where); },
  }, fn);
}
