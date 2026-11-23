import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { db, schema } from "@/server/db";
import { APP_NAME } from "./brand";
import { authEmailTemplate, emailConfigured, sendAuthEmail } from "./auth-email";
import { checkUsername, claimFreeUsername } from "@/server/services/username";
import { slugifyUsername, validateUsername } from "./username";

const baseURL = process.env.BETTER_AUTH_URL || process.env.APP_URL || "http://localhost:3000";
const verificationRequired = emailConfigured(); // dev without a mail provider: sign-in works, links are logged to console

const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : undefined;
const microsoft = process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
  ? { clientId: process.env.MICROSOFT_CLIENT_ID, clientSecret: process.env.MICROSOFT_CLIENT_SECRET, tenantId: process.env.MICROSOFT_TENANT_ID || "common" } : undefined;

export const enabledSocialProviders = { google: Boolean(google), microsoft: Boolean(microsoft) };

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
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    requireEmailVerification: verificationRequired,
    autoSignIn: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      await sendAuthEmail({
        to: user.email, subject: `Reset your ${APP_NAME} password`,
        ...authEmailTemplate({ heading: "Reset your password", body: "We received a request to reset your password. This link expires in 1 hour. If you did not request it, you can ignore this email.", cta: "Reset password", url }),
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: async ({ user, url }) => {
      await sendAuthEmail({
        to: user.email, subject: `Verify your ${APP_NAME} email`,
        ...authEmailTemplate({ heading: "Confirm your email", body: `Welcome to ${APP_NAME}! Confirm your email address to finish setting up your account.`, cta: "Verify email", url }),
      });
    },
  },
  socialProviders: {
    ...(google ? { google } : {}),
    ...(microsoft ? { microsoft } : {}),
  },
  account: { accountLinking: { enabled: true, trustedProviders: ["google", "microsoft"] } },
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
          const [u] = await db.select({ status: schema.users.status, deletedAt: schema.users.deletedAt })
            .from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
          if (u && (u.deletedAt || u.status === "suspended")) {
            throw new APIError("FORBIDDEN", { message: "This account is disabled." });
          }
        },
      },
    },
  },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 10 },
      "/request-password-reset": { window: 60, max: 5 },
      "/forget-password": { window: 60, max: 5 },
      "/send-verification-email": { window: 60, max: 5 },
      "/two-factor/verify-totp": { window: 60, max: 10 },
    },
  },
  plugins: [twoFactor({ issuer: APP_NAME }), nextCookies()],
});

export type Auth = typeof auth;
