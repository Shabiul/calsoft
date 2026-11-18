import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/auth-session";
import { getCalendarEvents } from "@/server/services/dashboard";
import { isAppError } from "@/server/errors";

/** GET /api/calendar/events?from=ISO&to=ISO  (current user's hosted bookings) */
export async function GET(req: Request) {
  try {
    const user = await requireUserApi();
    const url = new URL(req.url);
    const from = new Date(url.searchParams.get("from") ?? "");
    const to = new Date(url.searchParams.get("to") ?? "");
    if (Number.isNaN(+from) || Number.isNaN(+to) || to <= from || +to - +from > 1000 * 60 * 60 * 24 * 100) {
      return NextResponse.json({ error: { code: "VALIDATION", message: "Invalid from/to range" } }, { status: 400 });
    }
    return NextResponse.json({ events: await getCalendarEvents(user.id, from, to) });
  } catch (e) {
    if (isAppError(e)) return NextResponse.json(e.toJSON(), { status: e.status });
    console.error("[calendar/events]", e);
    return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong" } }, { status: 500 });
  }
}
