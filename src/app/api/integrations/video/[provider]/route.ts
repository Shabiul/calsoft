import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/lib/auth-session";
import { disconnectVideo } from "@/server/integrations/connections";
import { errorResponse } from "@/server/integrations/http-errors";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const user = await requireUserApi();
    const { provider } = await ctx.params;
    if (provider !== "zoom") return NextResponse.json({ error: { code: "NOT_FOUND", message: "Unknown provider" } }, { status: 404 });
    await disconnectVideo(user.id, provider);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
