import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { supabaseSignIn } from "./supabase-plugin";
import { supabaseLoginEnabled } from "@/server/services/supabase-auth";
import { db, schema } from "@/server/db";
import { APP_NAME } from "./brand";
import { alertOnNewBrowser } from "@/server/services/my-privacy";
import { accountMayUseApp, ensureSuperadmin } from "@/server/services/account-access";
import { zohoProfileToUser, type ZohoProfile } from "./zoho-profile";
import { describeDevice, providerFromContext } from "./sign-in-info";
import { zohoHost } from "@/server/integrations/config";
import { checkUsername, claimFreeUsername } from "@/server/services/username";
import { slugifyUsername, validateUsername } from "./username";

const baseURL = process.env.BETTER_AUTH_URL || process.env.APP_URL || "http://localhost:3000";
/**
 * Two ways in, no passwords:
 *  - "Continue with Google": any Google account (creates the account on first sign-in).
 *  - "Continue with Zoho": company accounts only (ALLOWED_EMAIL_DOMAINS), creates the account on first sign-in; anyone else is refused.
 * Redirect URIs to register: <APP_URL>/api/auth/callback/google and <APP_URL>/api/auth/callback/zoho (same Zoho client as the calendar integration).
 */
const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : null;
export const googleLoginEnabled = Boolean(google);
const zohoClient = process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET
  ? { clientId: process.env.ZOHO_CLIENT_ID, clientSecret: process.env.ZOHO_CLIENT_SECRET } : null;
export const zohoLoginEnabled = Boolean(zohoClient);
export const supabaseSignInEnabled = supabaseLoginEnabled();
const NOT_ALLOWED = "This account cannot sign in. Use Google, or your company Zoho account.";

export const auth = betterAuth({
  appName: APP_NAME,
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  // dev: Next falls back to another port when 3000 is busy, so trust any localhost port; production trusts only the configured origin
  trustedOrigins: [baseURL, ...(process.env.NODE_ENV !== "production" ? ["http://localhost:*", "http://127.0.0.1:*"] : [])],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users, session: schema.sessions, account: schema.accounts,
      verification: schema.verifications, twoFactor: schema.twoFactors,
    },
  }),
  emailAndPassword: { enabled: false }, // no password sign-up / sign-in / reset
  socialProviders: google ? { google } : {},
  account: { accountLinking: { enabled: true, trustedProviders: ["google", "zoho"] } },
  user: {
    additionalFields: {
      username: { type: "string", required: false, input: true },
      phone: { type: "string", required: false, input: true },
      bio: { type: "string", required: false, input: true },
      country: { type: "string", required: false, input: true },
      language: { type: "string", required: false, input: true },
      timeZone: { type: "string", required: false, input: true },
      dateFormat: { type: "string", required: false, input: true },
      timeFormat: { type: "string", required: false, input: true },
      platformRole: { type: "string", required: false, input: false },
      status: { type: "string", required: false, input: false },
      deletedAt: { type: "date", required: false, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // No domain rule here: Zoho accounts are restricted to company domains in getUserInfo (before any user is created) and Google is open.
          const raw = (user as { username?: string | null }).username;
          let username: string;
          if (raw) {
            const v = validateUsername(raw);
            if (!v.ok) throw new APIError("BAD_REQUEST", { message: v.message });
            const avail = await checkUsername(v.username);
            if (!avail.available) throw new APIError("BAD_REQUEST", { message: avail.message ?? "Username unavailable." });
            username = v.username;
          } else {
            // OAuth sign-ups: auto-claim a free username derived from the name / email.
            username = await claimFreeUsername(slugifyUsername(user.name || user.email.split("@")[0]!));
          }
          return { data: { ...user, username } };
        },
        // Give every new account a working default (Mon–Fri 9–5) so its booking page has slots immediately.
        after: async (user) => {
          try {
            const tz = (user as { timeZone?: string | null }).timeZone || "UTC";
            await db.transaction(async (tx) => {
              const [sch] = await tx.insert(schema.availabilitySchedules)
                .values({ userId: user.id, name: "Working hours", timeZone: tz, isDefault: true }).returning({ id: schema.availabilitySchedules.id });
              await tx.insert(schema.availabilityRules).values([1, 2, 3, 4, 5].map((weekday) => ({ scheduleId: sch.id, weekday, startTime: "09:00", endTime: "17:00" })));
            });
          } catch (err) {
            console.error("[auth] default availability schedule failed:", (err as Error).message);
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const [u] = await db.select({ status: schema.users.status, deletedAt: schema.users.deletedAt, email: schema.users.email, role: schema.users.platformRole })
            .from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
          if (!u || u.deletedAt || u.status === "suspended") {
            throw new APIError("FORBIDDEN", { message: "This account is disabled." });
          }
          // Every sign-in, not only the first: a Zoho-only account whose email is (no longer) on a company domain is refused.
          // Google accounts and platform superadmins are exempt (see accountMayUseApp).
          const role = await ensureSuperadmin(session.userId, u.email, u.role); // SUPERADMIN_EMAILS
          if (!(await accountMayUseApp(session.userId, u.email, role))) throw new APIError("FORBIDDEN", { message: NOT_ALLOWED });
        },
        // Durable sign-in history for managers (the session table loses rows on sign-out). Never blocks a sign-in.
        after: async (session, context) => {
          try {
            const provider = providerFromContext(context as never);
            const device = describeDevice((session as { userAgent?: string | null }).userAgent);
            await alertOnNewBrowser(session.userId, device, provider); // before this sign-in is logged, so "new" means never seen before
            await db.insert(schema.signInLogs).values({ userId: session.userId, provider, device });
          } catch (err) {
            console.error("[auth] sign-in log failed:", (err as Error).message);
          }
        },
      },
    },
  },
  hooks: {
    // Sign-outs go in the same durable log as sign-ins.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-out") return;
      try {
        const s = await getSessionFromCtx(ctx);
        if (s?.user) await db.insert(schema.signInLogs).values({ userId: s.user.id, event: "sign_out", provider: null, device: describeDevice(ctx.headers?.get("user-agent")) });
      } catch (err) {
        console.error("[auth] sign-out log failed:", (err as Error).message);
      }
    }),
  },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      "/sign-in/social": { window: 60, max: 20 },
      "/supabase/send": { window: 60, max: 6 },
      "/supabase/verify": { window: 60, max: 10 },
      "/supabase/password": { window: 60, max: 10 },
      "/supabase/signup": { window: 60, max: 5 },
    },
  },
  plugins: [
    ...(zohoClient ? [genericOAuth({
      config: [{
        providerId: "zoho", name: "Zoho",
        ...zohoClient,
        // Hosts follow the account's data center (ZOHO_DC), like the calendar integration.
        authorizationUrl: `${zohoHost("accounts")}/oauth/v2/auth`,
        tokenUrl: `${zohoHost("accounts")}/oauth/v2/token`,
        scopes: ["AaaServer.profile.READ"],
        authentication: "post",
        pkce: false,
        // Account identity is the immutable Zoho user id (ZUID), not the email.
        getUserInfo: async (tokens) => {
          const r = await fetch(`${zohoHost("accounts")}/oauth/user/info`, { headers: { Authorization: `Zoho-oauthtoken ${tokens.accessToken}` } });
          if (!r.ok) return null;
          return zohoProfileToUser((await r.json()) as ZohoProfile); // null (refused) for non-company addresses
        },
      }],
    })] : []),
    supabaseSignIn(),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
