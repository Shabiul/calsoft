import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { normalizeUsername, usernameCandidates, validateUsername } from "@/lib/username";

export type UsernameAvailability = { available: boolean; reason?: "format" | "length" | "reserved" | "taken"; message?: string };

/**
 * Usernames and organization slugs share ONE namespace (both are served at /{name}).
 * `exceptOrgId` lets an organization keep/rename its own slug.
 */
export async function isHandleTaken(handle: string, opts: { exceptUserId?: string; exceptOrgId?: string } = {}, db: Db = defaultDb): Promise<boolean> {
  const h = normalizeUsername(handle);
  const [u] = await db.select({ id: schema.users.id }).from(schema.users)
    .where(opts.exceptUserId ? and(eq(schema.users.username, h), ne(schema.users.id, opts.exceptUserId)) : eq(schema.users.username, h)).limit(1);
  if (u) return true;
  // Soft-deleted orgs keep their slug reserved (the DB unique index still covers them).
  const [o] = await db.select({ id: schema.organizations.id }).from(schema.organizations)
    .where(opts.exceptOrgId ? and(sql`lower(${schema.organizations.slug}) = ${h}`, ne(schema.organizations.id, opts.exceptOrgId)) : sql`lower(${schema.organizations.slug}) = ${h}`).limit(1);
  return !!o;
}

export async function checkUsername(raw: string, exceptUserId?: string, db: Db = defaultDb): Promise<UsernameAvailability> {
  const v = validateUsername(raw);
  if (!v.ok) return { available: false, reason: v.reason, message: v.message };
  return (await isHandleTaken(v.username, { exceptUserId }, db))
    ? { available: false, reason: "taken", message: "This username is already taken." }
    : { available: true };
}

/** Returns up to `limit` valid, currently-free usernames derived from a name/email base. */
export async function suggestUsernames(base: string, limit = 4, db: Db = defaultDb): Promise<string[]> {
  const candidates = usernameCandidates(base, 12);
  if (!candidates.length) return [];
  const [taken, takenOrgs] = await Promise.all([
    db.select({ u: schema.users.username }).from(schema.users).where(inArray(schema.users.username, candidates)),
    db.select({ u: schema.organizations.slug }).from(schema.organizations).where(inArray(schema.organizations.slug, candidates)),
  ]);
  const takenSet = new Set([...taken.map((t) => t.u), ...takenOrgs.map((t) => t.u)]);
  return candidates.filter((c) => !takenSet.has(c)).slice(0, limit);
}

/** First free username derived from base (falls back to random suffixes). */
export async function claimFreeUsername(base: string, db: Db = defaultDb): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const [first] = await suggestUsernames(i === 0 ? base : `${base}${Math.floor(Math.random() * 90000 + 10000)}`, 1, db);
    if (first) return first;
  }
  return normalizeUsername(`user${Date.now().toString(36)}`);
}
