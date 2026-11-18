import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/crypto";
import { syncAllDue } from "@/server/integrations/sync";

/** Cron/worker hook: POST with header `x-cron-secret: $CRON_SECRET`. Disabled (404) when CRON_SECRET is unset. */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(given, secret)) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  return NextResponse.json(await syncAllDue());
}
