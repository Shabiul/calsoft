/**
 * Thin server-side client for Supabase Auth (GoTrue). Supabase proves who someone is (emailed code, password, magic link);
 * MeetFlow then issues its own session, so every sign-in and sign-out goes through the same checks and the same log.
 * Only the publishable key is used here: it is what the browser would use too, and users are never created through it by an admin API.
 */
import { AppError } from "../errors";

const url = () => (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const key = () => process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
export const supabaseLoginEnabled = () => Boolean(url() && key());

export interface SupabaseUser { id: string; email: string; emailConfirmed: boolean; name: string | null }
interface Raw { id?: string; email?: string; email_confirmed_at?: string | null; confirmed_at?: string | null; user_metadata?: { full_name?: string; name?: string } }
const toUser = (r: Raw | undefined | null): SupabaseUser | null =>
  r?.id && r.email ? { id: r.id, email: r.email.trim().toLowerCase(), emailConfirmed: Boolean(r.email_confirmed_at ?? r.confirmed_at), name: r.user_metadata?.full_name ?? r.user_metadata?.name ?? null } : null;

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  if (!supabaseLoginEnabled()) throw new AppError("NOT_CONFIGURED", "Supabase sign-in is not configured", 503);
  const r = await fetch(`${url()}/auth/v1${path}`, {
    method: init.method ?? "POST",
    headers: { apikey: key(), Authorization: `Bearer ${init.token ?? key()}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, data };
}
const message = (d: Record<string, unknown>, fallback: string) => String(d.msg ?? d.error_description ?? d.message ?? fallback);
const refuse = (d: Record<string, unknown>, status: number, fallback: string): never => {
  throw new AppError(status === 429 ? "RATE_LIMITED" : "UNAUTHORIZED", message(d, fallback), status === 429 ? 429 : 401);
};

/** Emails a 6-digit code (and a magic link, depending on the Supabase email template). `redirectTo` must be on Supabase's redirect allow-list. */
export async function sendLoginEmail(email: string, redirectTo: string): Promise<void> {
  const r = await call(`/otp?redirect_to=${encodeURIComponent(redirectTo)}`, { body: { email, create_user: true } });
  if (!r.ok) refuse(r.data, r.status, "Could not send the sign-in email");
}

export async function verifyEmailCode(email: string, code: string): Promise<SupabaseUser> {
  const r = await call("/verify", { body: { type: "email", email, token: code } });
  const u = r.ok ? toUser(r.data.user as Raw) : null;
  if (!u) return refuse(r.data, r.status, "That code is wrong or has expired");
  return u;
}

export async function passwordSignIn(email: string, password: string): Promise<SupabaseUser> {
  const r = await call("/token?grant_type=password", { body: { email, password } });
  const u = r.ok ? toUser(r.data.user as Raw) : null;
  if (!u) return refuse(r.data, r.status, "Wrong email or password");
  return u;
}

/** Creates the Supabase login; Supabase emails a confirmation link, and the account is only usable once the email is confirmed. */
export async function passwordSignUp(email: string, password: string, redirectTo: string): Promise<void> {
  const r = await call(`/signup?redirect_to=${encodeURIComponent(redirectTo)}`, { body: { email, password } });
  if (!r.ok) refuse(r.data, r.status, "Could not create the account");
}

/** Resolves an access token (from a magic link) to the Supabase user it belongs to. Supabase itself validates the token. */
export async function userFromAccessToken(accessToken: string): Promise<SupabaseUser> {
  const r = await call("/user", { method: "GET", token: accessToken });
  const u = r.ok ? toUser(r.data as Raw) : null;
  if (!u) return refuse(r.data, r.status, "This sign-in link is invalid or has expired");
  return u;
}
