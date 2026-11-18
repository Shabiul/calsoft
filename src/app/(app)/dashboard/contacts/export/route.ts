import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth-session";
import { exportContactsCsv, type ContactFilter, type ContactSort } from "@/server/services/contacts";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  const sp = req.nextUrl.searchParams;
  const filter = (["all", "upcoming", "booked", "never"] as const).find((f) => f === sp.get("filter")) as ContactFilter | undefined;
  const sort = (["recent", "name", "email", "bookings"] as const).find((s) => s === sp.get("sort")) as ContactSort | undefined;
  const csv = await exportContactsCsv(user.id, { q: sp.get("q") ?? undefined, filter, sort });
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
