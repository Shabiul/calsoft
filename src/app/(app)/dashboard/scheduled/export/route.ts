import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { exportScheduledCsv, type ScheduledTab } from "@/server/services/scheduled";

/** GET /dashboard/scheduled/export?tab&q&event&host -> CSV of the (filtered) list the user can see. */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUserApi();
    const sp = req.nextUrl.searchParams;
    const tab = (["upcoming", "past", "cancelled"] as const).find((t) => t === sp.get("tab")) as ScheduledTab | undefined;
    const csv = await exportScheduledCsv(user.id, { tab, q: sp.get("q") ?? undefined, eventTypeId: sp.get("event") ?? undefined, hostId: sp.get("host") ?? undefined });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="scheduled-events-${tab ?? "upcoming"}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (isAppError(e)) return NextResponse.json(e.toJSON(), { status: e.status });
    console.error("[scheduled export]", e);
    return NextResponse.json({ error: { code: "INTERNAL", message: "Export failed" } }, { status: 500 });
  }
}
