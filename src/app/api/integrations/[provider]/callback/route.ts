import { NextResponse, after, type NextRequest } from "next/server";
import { requireUserApi } from "@/lib/auth-session";
import { appUrl } from "@/server/integrations/config";
import { verifyOAuthState } from "@/server/integrations/oauth";
import { completeOAuth } from "@/server/integrations/connections";
import { syncConnection } from "@/server/integrations/sync";
import { ProviderError } from "@/server/integrations/http";
import type { OAuthProviderName } from "@/server/integrations/types";

const PROVIDERS = ["google", "microsoft", "zoom"];

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const done = (q: string, to = "/dashboard/integrations") => {
    const res = NextResponse.redirect(`${appUrl()}${to}?${q}`);
    res.cookies.delete({ name: `mf_oauth_${provider}`, path: "/api/integrations" });
    return res;
  };
  if (!PROVIDERS.includes(provider)) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Unknown provider" } }, { status: 404 });
  const p = provider as OAuthProviderName;
  try {
    const user = await requireUserApi();
    const url = req.nextUrl;
    const providerError = url.searchParams.get("error");
    if (providerError) return done(`error=${encodeURIComponent(providerError === "access_denied" ? "access_denied" : "oauth_failed")}`);
    const code = url.searchParams.get("code");
    if (!code) return done("error=oauth_failed");
    const { verifier, returnTo } = verifyOAuthState({ state: url.searchParams.get("state"), cookie: req.cookies.get(`mf_oauth_${p}`)?.value, userId: user.id, provider: p });
    const result = await completeOAuth(user.id, p, code, verifier);
    if (result.kind === "calendar") {
      const id = result.connectedCalendarId;
      after(() => syncConnection(id, { full: true })); // first busy sync + push subscription, off the request path
    }
    return done(`connected=${p}`, returnTo);
  } catch (e) {
    console.error("[integrations] oauth callback failed", p, e instanceof Error ? e.message : e);
    const code = e instanceof ProviderError && e.status === 400 && /state/i.test(e.message) ? "invalid_state" : "oauth_failed";
    return done(`error=${code}`);
  }
}
