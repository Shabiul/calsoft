import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/lib/auth-session";
import { refreshCalendarList } from "@/server/integrations/connections";
import { syncConnection } from "@/server/integrations/sync";
import { errorResponse } from "@/server/integrations/http-errors";

/** Re-read the provider's calendar list and force a full busy re-sync. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUserApi();
    const { id } = await ctx.params;
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION", message: "Invalid id" } }, { status: 422 });
    const count = await refreshCalendarList(user.id, parsed.data);
    await syncConnection(parsed.data, { full: true });
    return NextResponse.json({ ok: true, calendars: count });
  } catch (e) { return errorResponse(e); }
}
