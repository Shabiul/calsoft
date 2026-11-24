import { z } from "zod";
import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { db, schema } from "@/server/db";
import { isAppError } from "@/server/errors";
import { emailMaySignInWithSupabase } from "@/server/services/account-access";
import {
  passwordSignIn, passwordSignUp, sendLoginEmail, supabaseLoginEnabled, userFromAccessToken, verifyEmailCode, type SupabaseUser,
} from "@/server/services/supabase-auth";

const email = z.string().trim().toLowerCase().email().max(254);
const COMPANY_ONLY = "Use your company email address to sign in.";
const base = () => (process.env.BETTER_AUTH_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");

/** Maps a Supabase failure to an HTTP error the login form can show. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof APIError) throw e;
    if (isAppError(e)) throw new APIError(e.status === 429 ? "TOO_MANY_REQUESTS" : e.status === 503 ? "SERVICE_UNAVAILABLE" : "UNAUTHORIZED", { message: e.message });
    throw e;
  }
}

async function requireAllowed(addr: string, method: string) {
  if (await emailMaySignInWithSupabase(addr)) return;
  await db.insert(schema.auditLogs).values({ actorId: null, action: "auth.sign_in_refused", entity: "email", meta: { email: addr, method } }).catch(() => undefined);
  throw new APIError("FORBIDDEN", { message: COMPANY_ONLY });
}

/** Turns a verified Supabase identity into a MeetFlow session. Account checks and the sign-in log run in the shared session hooks. */
async function startSession(ctx: Parameters<typeof setSessionCookie>[0], sb: SupabaseUser) {
  if (!sb.emailConfirmed) throw new APIError("FORBIDDEN", { message: "Confirm your email first: check your inbox for the link." });
  await requireAllowed(sb.email, "supabase");
  const ia = ctx.context.internalAdapter;
  const found = await ia.findUserByEmail(sb.email);
  let user = found?.user;
  if (!user) user = await ia.createUser({ email: sb.email, emailVerified: true, name: sb.name || sb.email.split("@")[0]! }, { method: "supabase" });
  if (!user) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not create your account." });
  if (!found?.accounts.some((a) => a.providerId === "supabase")) {
    await ia.linkAccount({ userId: user.id, providerId: "supabase", accountId: sb.id }).catch(() => undefined);
  }
  const session = await ia.createSession(user.id);
  if (!session) throw new APIError("FORBIDDEN", { message: "This account cannot sign in." });
  await setSessionCookie(ctx, { session, user });
  return { ok: true as const };
}

/**
 * Supabase Auth sign-in for company accounts: emailed code, password, magic link. Endpoints (under /api/auth):
 *  POST /supabase/send {email}            emails a code + magic link
 *  POST /supabase/verify {email, code}    signs in with the emailed code
 *  POST /supabase/password {email, password}
 *  POST /supabase/signup {email, password} creates the login; the email must be confirmed before first use
 *  POST /supabase/exchange {accessToken}  signs in from a magic link
 */
export const supabaseSignIn = () => ({
  id: "supabase-sign-in",
  endpoints: {
    supabaseSend: createAuthEndpoint("/supabase/send", { method: "POST", body: z.object({ email }) }, async (ctx) => {
      if (!supabaseLoginEnabled()) throw new APIError("SERVICE_UNAVAILABLE", { message: "Email sign-in is not configured." });
      await requireAllowed(ctx.body.email, "supabase_send");
      await guard(() => sendLoginEmail(ctx.body.email, `${base()}/auth/supabase`));
      return ctx.json({ ok: true });
    }),
    supabaseVerify: createAuthEndpoint("/supabase/verify", { method: "POST", body: z.object({ email, code: z.string().trim().regex(/^\d{6,10}$/) }) }, async (ctx) => {
      await requireAllowed(ctx.body.email, "supabase_code");
      return ctx.json(await startSession(ctx, await guard(() => verifyEmailCode(ctx.body.email, ctx.body.code))));
    }),
    supabasePassword: createAuthEndpoint("/supabase/password", { method: "POST", body: z.object({ email, password: z.string().min(1).max(200) }) }, async (ctx) => {
      await requireAllowed(ctx.body.email, "supabase_password");
      return ctx.json(await startSession(ctx, await guard(() => passwordSignIn(ctx.body.email, ctx.body.password))));
    }),
    supabaseSignup: createAuthEndpoint("/supabase/signup", { method: "POST", body: z.object({ email, password: z.string().min(10).max(200) }) }, async (ctx) => {
      await requireAllowed(ctx.body.email, "supabase_signup");
      await guard(() => passwordSignUp(ctx.body.email, ctx.body.password, `${base()}/auth/supabase`));
      return ctx.json({ ok: true });
    }),
    supabaseExchange: createAuthEndpoint("/supabase/exchange", { method: "POST", body: z.object({ accessToken: z.string().min(20).max(4000) }) }, async (ctx) => {
      return ctx.json(await startSession(ctx, await guard(() => userFromAccessToken(ctx.body.accessToken))));
    }),
  },
});
