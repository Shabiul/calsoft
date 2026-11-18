import { NextResponse, after, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/lib/auth-session";
import { updateCalendarOptions } from "@/server/integrations/connections";
import { ensureSubscription, syncCalendar } from "@/server/integrations/sync";
import { errorResponse } from "@/server/integrations/http-errors";

const body = z.object({ checkConflicts: z.boolean().optional(), isDestination: z.boolean().optional() }).strict();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUserApi();
    const { id: raw } = await ctx.params;
    const id = z.string().uuid().safeParse(raw);
    const data = body.safeParse(await req.json().catch(() => null));
    if (!id.success || !data.success) return NextResponse.json({ error: { code: "VALIDATION", message: "Invalid request" } }, { status: 422 });
    await updateCalendarOptions(user.id, id.data, data.data);
    if (data.data.checkConflicts) after(async () => { await syncCalendar(id.data, { full: true }); await ensureSubscription(id.data); });
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
