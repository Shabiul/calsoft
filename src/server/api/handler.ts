/**
 * Shared REST API wrapper: bearer API-key auth, scope check, per-key rate limiting (X-RateLimit-*),
 * Zod validation helpers, structured error envelope, request ids and audit logging of mutations.
 */
import { randomUUID } from "node:crypto";
import { accountMayUseApp } from "@/server/services/account-access";
import { eq } from "drizzle-orm";
import { z, type ZodType } from "zod";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { verifyApiKey, hasScope } from "@/server/api-keys";
import { AppError, isAppError } from "@/server/errors";
import { rateLimit, clientIp } from "@/server/ratelimit";
import { audit } from "@/server/audit";

export interface ApiKeyContext { id: string; userId: string; organizationId: string | null; scopes: string[] }
export interface ApiContext<P = Record<string, string>> {
  req: Request;
  requestId: string;
  key: ApiKeyContext;
  params: P;
  url: URL;
  /** Validates the query string. Throws a 422 VALIDATION error with per-field details. */
  query<T>(schema: ZodType<T>): T;
  /** Parses + validates the JSON body (422 on invalid JSON or schema mismatch). */
  body<T>(schema: ZodType<T>): Promise<T>;
  /** Set the audited entity for mutating requests. */
  setAudit(action: string, entity: { type: string; id?: string | null }, meta?: Record<string, unknown>): void;
}

export interface RouteOptions {
  /** Required scope (any one of the listed). */
  scope: string | string[];
  /** Requests per window for this key. Default API_RATE_LIMIT (env) or 120. */
  limit?: number;
  windowSec?: number;
}

export const DEFAULT_LIMIT = 120;
export const DEFAULT_WINDOW_SEC = 60;
const envLimit = () => Number(process.env.API_RATE_LIMIT) || DEFAULT_LIMIT;

export function errorBody(code: string, message: string, details?: unknown, requestId?: string) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}), ...(requestId ? { request_id: requestId } : {}) } };
}

export function zodDetails(e: z.ZodError) {
  return e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Cursor pagination envelope: { data, has_more, next_cursor }. */
export function page<T>(data: T[], hasMore: boolean, nextCursor: string | null) {
  return { data, has_more: hasMore, next_cursor: nextCursor };
}

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});

export function encodeCursor(t: Date | string, id: string): string {
  const iso = t instanceof Date ? t.toISOString() : t;
  return Buffer.from(JSON.stringify([iso, id])).toString("base64url");
}
export function decodeCursor(c: string | undefined): { t: string; id: string } | null {
  if (!c) return null;
  try {
    const [t, id] = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as [string, string];
    if (typeof t !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(t))) throw new Error("bad");
    return { t, id };
  } catch {
    throw new AppError("VALIDATION", "Invalid cursor", 422, [{ path: "cursor", message: "Invalid cursor" }]);
  }
}

/** Keyset-paginates an in-memory list already sorted by (time desc, id desc). */
export function paginateSorted<T>(rows: T[], q: { limit: number; cursor?: string }, key: (r: T) => [Date | string, string]) {
  const cur = decodeCursor(q.cursor);
  let start = 0;
  if (cur) {
    const ct = Date.parse(cur.t);
    start = rows.findIndex((r) => {
      const [t, id] = key(r);
      const rt = new Date(t).getTime();
      return rt < ct || (rt === ct && id < cur.id);
    });
    if (start < 0) start = rows.length;
  }
  const slice = rows.slice(start, start + q.limit);
  const hasMore = start + q.limit < rows.length;
  const last = slice[slice.length - 1];
  return page(slice, hasMore, hasMore && last ? encodeCursor(...key(last)) : null);
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function rateHeaders(limit: number, remaining: number, resetSec: number): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(Math.max(0, remaining)),
    "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + resetSec),
  };
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Handler<P> = (ctx: ApiContext<P>) => Promise<Response | unknown>;
type AuditInfo = { action: string; entity: { type: string; id?: string | null }; meta?: Record<string, unknown> };

export function apiRoute<P = Record<string, string>>(opts: RouteOptions, handler: Handler<P>) {
  return async (req: Request, routeCtx?: { params?: Promise<P> | P }): Promise<Response> => {
    const incoming = req.headers.get("x-request-id");
    const requestId = incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : `req_${randomUUID()}`;
    const base: Record<string, string> = { "X-Request-Id": requestId, "Cache-Control": "no-store" };
    const fail = (status: number, code: string, message: string, details?: unknown, extra: Record<string, string> = {}) =>
      Response.json(errorBody(code, message, details, requestId), { status, headers: { ...base, ...extra } });

    let rate: Record<string, string> = {};
    let key: ApiKeyContext | null = null;
    const auditBox: { v: AuditInfo | null } = { v: null };
    let res: Response;
    try {
      const token = bearer(req);
      if (!token) return fail(401, "UNAUTHORIZED", "Missing or malformed Authorization header. Use 'Authorization: Bearer <api key>'.", undefined, { "WWW-Authenticate": "Bearer" });
      key = await verifyApiKey(token);
      if (!key) {
        // Throttle brute-force of invalid keys by IP.
        const r = await rateLimit("api-badkey", clientIp(req), 30, 60);
        if (!r.ok) return fail(429, "RATE_LIMITED", "Too many failed authentication attempts.", undefined, { "Retry-After": String(r.retryAfterSec) });
        return fail(401, "UNAUTHORIZED", "Invalid or revoked API key.", undefined, { "WWW-Authenticate": "Bearer" });
      }
      const k = key;
      const limit = opts.limit ?? envLimit();
      const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;
      const rl = await rateLimit("api-key", k.id, limit, windowSec);
      rate = rateHeaders(limit, rl.remaining, rl.retryAfterSec);
      if (!rl.ok) return fail(429, "RATE_LIMITED", "Rate limit exceeded.", undefined, { ...rate, "Retry-After": String(rl.retryAfterSec) });

      const needed = Array.isArray(opts.scope) ? opts.scope : [opts.scope];
      if (!needed.some((s) => hasScope(k.scopes, s))) {
        return fail(403, "INSUFFICIENT_SCOPE", `This API key lacks the required scope: ${needed.join(" or ")}.`, { required: needed }, rate);
      }
      const [owner] = await db.select({ status: users.status, deletedAt: users.deletedAt, email: users.email, role: users.platformRole }).from(users).where(eq(users.id, k.userId)).limit(1);
      // Only active accounts: a suspended, deleted or BENCHED owner (inactive member who may have left) cannot use their keys.
      // Same gate as sign-in: keys of a Zoho-only account that left the company domains stop working too (Google accounts are unaffected).
      if (!owner || owner.deletedAt || owner.status !== "active" || !(await accountMayUseApp(k.userId, owner.email, owner.role))) return fail(403, "ACCOUNT_SUSPENDED", "The account that owns this API key is not active.", undefined, rate);

      const url = new URL(req.url);
      const params = (await routeCtx?.params) ?? ({} as P);
      const ctx: ApiContext<P> = {
        req, requestId, key: k, params, url,
        query: (schema) => {
          const r = schema.safeParse(Object.fromEntries(url.searchParams));
          if (!r.success) throw new AppError("VALIDATION", "Invalid query parameters", 422, zodDetails(r.error));
          return r.data;
        },
        body: async (schema) => {
          let raw: unknown;
          try { raw = await req.json(); } catch { throw new AppError("VALIDATION", "Request body must be valid JSON", 422, [{ path: "", message: "Invalid JSON" }]); }
          const r = schema.safeParse(raw);
          if (!r.success) throw new AppError("VALIDATION", "Invalid request body", 422, zodDetails(r.error));
          return r.data;
        },
        setAudit: (action, entity, meta) => { auditBox.v = { action, entity, meta }; },
      };
      const out = await handler(ctx);
      res = out instanceof Response ? out : Response.json(out === undefined ? { ok: true } : out);
    } catch (e) {
      if (isAppError(e)) {
        const status = e.status >= 400 && e.status < 600 ? e.status : 400;
        // Services sometimes use 400 for validation; normalise to 422 per the API contract.
        const norm = e.code === "VALIDATION" && status === 400 ? 422 : status;
        res = Response.json(errorBody(e.code, e.message, e.details, requestId), { status: norm });
      } else {
        console.error(`[api ${requestId}]`, e);
        res = Response.json(errorBody("INTERNAL", "Internal server error", undefined, requestId), { status: 500 });
      }
    }
    for (const [k, v] of Object.entries({ ...base, ...rate })) res.headers.set(k, v);

    if (key && MUTATING.has(req.method) && res.status < 500) {
      const path = new URL(req.url).pathname;
      const a: AuditInfo = auditBox.v ?? { action: `api.${req.method.toLowerCase()}`, entity: { type: path } };
      await audit({ id: key.userId, organizationId: key.organizationId, ip: clientIp(req) }, a.action, a.entity, {
        ...a.meta, apiKeyId: key.id, requestId, method: req.method, path, status: res.status,
      });
    }
    return res;
  };
}

export const created = (data: unknown) => Response.json(data, { status: 201 });
export const uuidParam = z.string().uuid();

/** 404 instead of 403 for cross-tenant access so existence is never leaked. */
export async function hideForbidden<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    if (isAppError(e) && e.status === 403) throw new AppError("NOT_FOUND", "Resource not found", 404);
    throw e;
  }
}
export function requireUuid(id: string, what = "Resource"): string {
  if (!uuidParam.safeParse(id).success) throw new AppError("NOT_FOUND", `${what} not found`, 404);
  return id;
}
