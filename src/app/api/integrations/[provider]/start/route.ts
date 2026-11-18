import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/lib/auth-session";
import { appUrl, isConfigured } from "@/server/integrations/config";
import { buildAuthUrl, createOAuthState } from "@/server/integrations/oauth";
import { errorResponse } from "@/server/integrations/http-errors";
import type { OAuthProviderName } from "@/server/integrations/types";

const PROVIDERS = ["google", "microsoft", "zoom"] as const;
const OAUTH_COOKIE = (p: string) => `mf_oauth_${p}`;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await ctx.params;
    if (!(PROVIDERS as readonly string[]).includes(provider)) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Unknown provider" } }, { status: 404 });
    const p = provider as OAuthProviderName;
    const user = await requireUserApi();
    const back = (q: string) => NextResponse.redirect(`${appUrl()}/dashboard/integrations?${q}`);
    if (!isConfigured(p)) return back(`error=${p}_not_configured`);
    const { state, verifier, cookie } = createOAuthState(user.id, p);
    const res = NextResponse.redirect(buildAuthUrl(p, state, verifier));
    res.cookies.set(OAUTH_COOKIE(p), cookie, {
      httpOnly: true, secure: appUrl().startsWith("https://"), sameSite: "lax", path: "/api/integrations", maxAge: 600,
    });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
