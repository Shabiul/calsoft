import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/lib/auth-session";
import { disconnectCalendar } from "@/server/integrations/connections";
import { errorResponse } from "@/server/integrations/http-errors";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUserApi();
    const { id } = await ctx.params;
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION", message: "Invalid id" } }, { status: 422 });
    await disconnectCalendar(user.id, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
