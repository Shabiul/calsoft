import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth-session";
import { AppError } from "@/server/errors";
import { exportAnalyticsCsv } from "@/server/services/analytics";
import { parseRange } from "../params";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  try {
    const q = parseRange(Object.fromEntries(req.nextUrl.searchParams), user.timeZone);
    const csv = await exportAnalyticsCsv(user.id, q);
    return new Response("﻿" + csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="analytics-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    throw e;
  }
}
