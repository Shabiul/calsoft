import { createHash } from "node:crypto";
import { randomToken, encrypt, decrypt, hmacSign, safeEqual } from "@/lib/crypto";
import { credentialsFor, redirectUri, zohoHost } from "./config";
import { http, ProviderError } from "./http";
import type { OAuthProviderName, TokenSet } from "./types";

interface Spec { authUrl: string; tokenUrl: string; scopes: string[]; extra: Record<string, string>; pkce: boolean; basicAuth: boolean; scopeSep?: string }

/**
 * Zoho: accounts/token hosts depend on the account's data center (ZOHO_DC), so authUrl/tokenUrl are getters. Scopes are comma-separated.
 * A refresh token needs access_type=offline (+ prompt=consent to get one on re-authorization). Calendar, Meeting and the profile scope
 * share one grant.
 */
export const ZOHO_SCOPES = [
  "ZohoCalendar.calendar.ALL", "ZohoCalendar.event.ALL", "ZohoCalendar.freebusy.READ",
  "ZohoMeeting.meeting.ALL", "ZohoMeeting.manageOrg.READ", "AaaServer.profile.READ",
];

export const SPECS: Record<OAuthProviderName, Spec> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"],
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" }, pkce: true, basicAuth: false,
  },
  microsoft: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "openid", "email", "User.Read", "Calendars.ReadWrite"],
    extra: { prompt: "select_account", response_mode: "query" }, pkce: true, basicAuth: false,
  },
  zoom: {
    authUrl: "https://zoom.us/oauth/authorize", tokenUrl: "https://zoom.us/oauth/token",
    scopes: [], // Zoom scopes are configured on the app in the Marketplace, not requested per authorization.
    extra: {}, pkce: true, basicAuth: true,
  },
  zoho: {
    get authUrl() { return `${zohoHost("accounts")}/oauth/v2/auth`; },
    get tokenUrl() { return `${zohoHost("accounts")}/oauth/v2/token`; },
    scopes: ZOHO_SCOPES, scopeSep: ",",
    extra: { access_type: "offline", prompt: "consent" }, pkce: false, basicAuth: false,
  },
};

export const challengeFor = (verifier: string) => createHash("sha256").update(verifier).digest().toString("base64url");

/** Cookie payload (encrypted) + signed state value binding the browser, user and PKCE verifier. */
export function createOAuthState(userId: string, provider: OAuthProviderName, returnTo = "/dashboard/integrations") {
  const nonce = randomToken(16);
  const verifier = randomToken(48);
  const state = `${nonce}.${hmacSign(`${nonce}:${provider}:${userId}`, "oauth-state")}`;
  const cookie = encrypt(JSON.stringify({ nonce, verifier, userId, provider, returnTo, exp: Date.now() + 10 * 60_000 }));
  return { state, verifier, cookie };
}

export function verifyOAuthState(args: { state: string | null; cookie: string | undefined; userId: string; provider: OAuthProviderName }):
  { verifier: string; returnTo: string } {
  const bad = (m: string) => new ProviderError(`Invalid OAuth state: ${m}`, "other", 400);
  if (!args.state || !args.cookie) throw bad("missing");
  let c: { nonce: string; verifier: string; userId: string; provider: string; returnTo: string; exp: number };
  try { c = JSON.parse(decrypt(args.cookie)); } catch { throw bad("cookie"); }
  const [nonce, sig] = args.state.split(".");
  if (!nonce || !sig || nonce !== c.nonce) throw bad("nonce");
  if (!safeEqual(sig, hmacSign(`${nonce}:${args.provider}:${args.userId}`, "oauth-state"))) throw bad("signature");
  if (c.userId !== args.userId || c.provider !== args.provider) throw bad("user");
  if (c.exp < Date.now()) throw bad("expired");
  const returnTo = c.returnTo.startsWith("/") && !c.returnTo.startsWith("//") ? c.returnTo : "/dashboard/integrations";
  return { verifier: c.verifier, returnTo };
}

export function buildAuthUrl(provider: OAuthProviderName, state: string, verifier: string): string {
  const creds = credentialsFor(provider);
  if (!creds) throw new ProviderError(`${provider} credentials are not configured`, "other", 501);
  const s = SPECS[provider];
  const p = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri(provider), response_type: "code", state, ...s.extra });
  if (s.scopes.length) p.set("scope", s.scopes.join(s.scopeSep ?? " "));
  if (s.pkce) { p.set("code_challenge", challengeFor(verifier)); p.set("code_challenge_method", "S256"); }
  return `${s.authUrl}?${p}`;
}

const REAUTH_ERRORS = ["invalid_code", "invalid_grant", "invalid_token", "interaction_required", "consent_required", "login_required", "unauthorized_client", "invalid_client"];

async function tokenRequest(provider: OAuthProviderName, form: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const creds = credentialsFor(provider);
  if (!creds) throw new ProviderError(`${provider} credentials are not configured`, "other", 501);
  const s = SPECS[provider];
  const headers: Record<string, string> = {};
  const body = { ...form };
  if (s.basicAuth) headers.Authorization = `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`;
  else { body.client_id = creds.clientId; body.client_secret = creds.clientSecret; }
  try {
    const r = await http<{ access_token: string; refresh_token?: string; expires_in?: number; error?: string }>(s.tokenUrl, { form: body, headers });
    // Zoho answers token failures with HTTP 200 and { error: "invalid_code" | "invalid_client" | ... }.
    if (!r?.access_token && typeof r?.error === "string") {
      throw new ProviderError(`Token request failed (${r.error})`, REAUTH_ERRORS.includes(r.error) ? "auth" : "other", 400, r);
    }
    if (!r?.access_token) throw new ProviderError("Token endpoint returned no access_token", "other");
    return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresIn: r.expires_in ?? 3600 };
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 400 || e.status === 401)) {
      const b = e.body as { error?: string } | undefined;
      const code = typeof b?.error === "string" ? b.error : "";
      if (REAUTH_ERRORS.includes(code) || e.status === 401) throw new ProviderError(`Authorization revoked or expired (${code || e.status})`, "auth", e.status, e.body);
    }
    throw e;
  }
}

export async function exchangeCode(provider: OAuthProviderName, code: string, verifier: string): Promise<TokenSet> {
  const t = await tokenRequest(provider, { grant_type: "authorization_code", code, redirect_uri: redirectUri(provider), ...(SPECS[provider].pkce ? { code_verifier: verifier } : {}) });
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: Date.now() + t.expiresIn * 1000 };
}

export async function refreshTokens(provider: OAuthProviderName, current: TokenSet): Promise<TokenSet> {
  if (!current.refreshToken) throw new ProviderError("No refresh token stored; reconnect required", "auth", 401);
  const t = await tokenRequest(provider, { grant_type: "refresh_token", refresh_token: current.refreshToken });
  // Zoom and Microsoft rotate refresh tokens; Google usually does not.
  return { accessToken: t.accessToken, refreshToken: t.refreshToken ?? current.refreshToken, expiresAt: Date.now() + t.expiresIn * 1000 };
}

export async function fetchIdentity(provider: OAuthProviderName, accessToken: string): Promise<{ id: string; email: string | null }> {
  if (provider === "google") {
    const r = await http<{ sub: string; email?: string }>("https://openidconnect.googleapis.com/v1/userinfo", { token: accessToken });
    return { id: r.sub, email: r.email ?? null };
  }
  if (provider === "microsoft") {
    const r = await http<{ id: string; mail?: string | null; userPrincipalName?: string }>("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName", { token: accessToken });
    return { id: r.id, email: r.mail ?? r.userPrincipalName ?? null };
  }
  if (provider === "zoho") {
    const r = await http<{ ZUID?: string | number; Email?: string; email?: string }>(`${zohoHost("accounts")}/oauth/user/info`, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    const id = r?.ZUID != null ? String(r.ZUID) : null;
    const email = r?.Email ?? r?.email ?? null;
    if (!id && !email) throw new ProviderError("Zoho did not return an account id", "other", 502);
    return { id: id ?? email!.toLowerCase(), email };
  }
  const r = await http<{ id: string; email?: string }>("https://api.zoom.us/v2/users/me", { token: accessToken });
  return { id: r.id, email: r.email ?? null };
}
