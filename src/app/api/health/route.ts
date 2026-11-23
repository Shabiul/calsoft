import { NextResponse, type NextRequest } from "next/server";
import { redisTls } from "@/server/queue/redis-tls";

/**
 * GET /api/health            -> liveness (process is up; no dependencies touched)
 * GET /api/health?ready=1    -> readiness (checks Postgres and Redis; 503 if either fails)
 * Never returns secrets or error details beyond a short reason string.
 */
export async function GET(req: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (req.nextUrl.searchParams.get("ready") !== "1") {
    return NextResponse.json({ status: "ok" }, { headers });
  }

  const withTimeout = <T,>(p: Promise<T>, ms = 3000) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

  const checks: Record<string, string> = {};

  try {
    const { pool } = await import("@/server/db");
    await withTimeout(pool.query("select 1"));
    checks.database = "ok";
  } catch (e) {
    checks.database = e instanceof Error && e.message === "timeout" ? "timeout" : "unavailable";
  }

  let redis: { connect(): Promise<void>; ping(): Promise<string>; disconnect(): void; on(e: string, f: () => void): unknown } | undefined;
  try {
    const { default: IORedis } = await import("ioredis");
    redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: () => null,
      ...redisTls(),
    });
    redis.on("error", () => {});
    await withTimeout(redis.connect());
    await withTimeout(redis.ping());
    checks.redis = "ok";
  } catch (e) {
    checks.redis = e instanceof Error && e.message === "timeout" ? "timeout" : "unavailable";
  } finally {
    redis?.disconnect();
  }

  const ok = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json({ status: ok ? "ready" : "degraded", checks }, { status: ok ? 200 : 503, headers });
}
