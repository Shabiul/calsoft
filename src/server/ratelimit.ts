/**
 * Small fixed-window rate limiter. Uses Redis (INCR + EXPIRE) when REDIS_URL is reachable and
 * always keeps an in-process fallback so a Redis outage never blocks (or fully un-protects) public endpoints.
 */
import Redis from "ioredis";
import { redisTls } from "@/server/queue/redis-tls";

type Entry = { count: number; resetAt: number };
const mem = new Map<string, Entry>();
let lastSweep = 0;

const g = globalThis as unknown as { __rlRedis?: Redis | null };
function redis(): Redis | null {
  if (g.__rlRedis !== undefined) return g.__rlRedis;
  const url = process.env.REDIS_URL;
  if (!url) return (g.__rlRedis = null);
  try {
    const r = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false, connectTimeout: 1500, ...redisTls() });
    r.on("error", () => { /* fall back to memory */ });
    return (g.__rlRedis = r);
  } catch {
    return (g.__rlRedis = null);
  }
}

export type RateResult = { ok: boolean; remaining: number; retryAfterSec: number };

function memHit(key: string, limit: number, windowSec: number, now: number): RateResult {
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, v] of mem) if (v.resetAt <= now) mem.delete(k);
  }
  let e = mem.get(key);
  if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowSec * 1000 }; mem.set(key, e); }
  e.count += 1;
  return { ok: e.count <= limit, remaining: Math.max(0, limit - e.count), retryAfterSec: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
}

export async function rateLimit(bucket: string, id: string, limit: number, windowSec: number): Promise<RateResult> {
  const key = `rl:${bucket}:${id}`;
  const now = Date.now();
  // In-process check always runs (cheap, protects when Redis is down).
  const local = memHit(key, limit, windowSec, now);
  const r = redis();
  if (r && r.status === "ready") {
    try {
      const win = Math.floor(now / (windowSec * 1000));
      const rk = `${key}:${win}`;
      const n = await r.incr(rk);
      if (n === 1) await r.expire(rk, windowSec + 1);
      const retry = Math.max(1, windowSec - Math.floor((now % (windowSec * 1000)) / 1000));
      return { ok: n <= limit && local.ok, remaining: Math.max(0, limit - n), retryAfterSec: retry };
    } catch { /* fall through to local */ }
  }
  return local;
}

export function clientIp(req: Request): string {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  return (xff?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown").slice(0, 64);
}

/** Helper: returns a 429 Response when over the limit, else null. */
export async function limitOr429(req: Request, bucket: string, limit: number, windowSec: number): Promise<Response | null> {
  const res = await rateLimit(bucket, clientIp(req), limit, windowSec);
  if (res.ok) return null;
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } },
    { status: 429, headers: { "Retry-After": String(res.retryAfterSec) } },
  );
}
