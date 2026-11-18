import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/server/db";
import { apiKeys } from "@/server/db/schema";
import { randomToken, sha256 } from "@/lib/crypto";
import { AppError } from "@/server/errors";
import { API_KEY_SCOPES } from "@/server/webhooks/events";

export const API_KEY_PREFIX = "mf_live_";

const view = (k: typeof apiKeys.$inferSelect) => ({
  id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, createdAt: k.createdAt,
});
export type ApiKeyView = ReturnType<typeof view>;

/** Plaintext key is returned once; only sha256(key) is stored. */
export async function createApiKey(userId: string, input: { name: string; scopes: string[] }) {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AppError("VALIDATION", "Name is required (max 80 chars)", 422);
  const valid = new Set<string>(API_KEY_SCOPES);
  if (!input.scopes.length || input.scopes.some((s) => !valid.has(s))) throw new AppError("VALIDATION", "Choose at least one valid scope", 422);
  const key = `${API_KEY_PREFIX}${randomToken(24)}`;
  const [row] = await db.insert(apiKeys).values({
    userId, name, prefix: key.slice(0, API_KEY_PREFIX.length + 6), keyHash: sha256(key), scopes: input.scopes,
  }).returning();
  return { apiKey: view(row), key };
}

export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt));
  return rows.map(view);
}

export async function revokeApiKey(userId: string, id: string) {
  const res = await db.update(apiKeys).set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id });
  if (!res.length) throw new AppError("NOT_FOUND", "API key not found or already revoked", 404);
}

/** For the REST API layer: resolves a bearer key to its owner + scopes (null if unknown/revoked). */
export async function verifyApiKey(key: string): Promise<{ id: string; userId: string; organizationId: string | null; scopes: string[] } | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const [row] = await db.select().from(apiKeys).where(and(eq(apiKeys.keyHash, sha256(key)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => undefined);
  return { id: row.id, userId: row.userId, organizationId: row.organizationId, scopes: row.scopes };
}
export const hasScope = (scopes: string[], needed: string) => scopes.includes(needed);
