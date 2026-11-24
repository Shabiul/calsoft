import "server-only";
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/server/db";

const { signInLogs, users } = schema;
export const SIGNIN_PAGE_SIZE = 50;
export interface SignInFilter { q?: string; event?: string; from?: string; to?: string; page?: number }

/** Platform-wide sign-in / sign-out history for superadmins (who, how, from which browser, when). */
export async function listSignInLog(f: SignInFilter) {
  const conds: SQL[] = [];
  if (f.event === "sign_in" || f.event === "sign_out") conds.push(eq(signInLogs.event, f.event));
  const q = f.q?.trim();
  if (q) { const like = `%${q.replace(/[\%_]/g, "\$&")}%`; conds.push(or(ilike(users.email, like), ilike(users.name, like))!); }
  const from = f.from ? new Date(f.from) : null, to = f.to ? new Date(f.to) : null;
  if (from && !Number.isNaN(from.getTime())) conds.push(gte(signInLogs.createdAt, from));
  if (to && !Number.isNaN(to.getTime())) conds.push(lte(signInLogs.createdAt, new Date(to.getTime() + 86_400_000 - 1)));
  const where = conds.length ? and(...conds) : undefined;
  const page = Math.max(1, f.page ?? 1);
  const [rows, [{ n }]] = await Promise.all([
    db.select({ id: signInLogs.id, event: signInLogs.event, provider: signInLogs.provider, device: signInLogs.device, at: signInLogs.createdAt, userId: users.id, name: users.name, email: users.email })
      .from(signInLogs).innerJoin(users, eq(users.id, signInLogs.userId)).where(where)
      .orderBy(desc(signInLogs.createdAt), desc(signInLogs.id)).limit(SIGNIN_PAGE_SIZE).offset((page - 1) * SIGNIN_PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(signInLogs).innerJoin(users, eq(users.id, signInLogs.userId)).where(where),
  ]);
  return { rows, total: n, page, pages: Math.max(1, Math.ceil(n / SIGNIN_PAGE_SIZE)) };
}
