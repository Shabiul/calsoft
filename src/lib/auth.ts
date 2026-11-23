import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { db, schema } from "@/server/db";
import { APP_NAME } from "./brand";
import { isCompanyEmail } from "./company-email";
import { zohoHost } from "@/server/integrations/config";
import { checkUsername, claimFreeUsername } from "@/server/services/username";
import { slugifyUsername, validateUsername } from "./username";

const baseURL = process.env.BETTER_AUTH_URL || process.env.APP_URL || "http://localhost:3000";
/**
 * Sign-in is ONLY "Continue with Zoho" with a company email (ALLOWED_EMAIL_DOMAINS). There is no sign-up form and no password
 * login: an employee's first Zoho sign-in creates their account; anyone else is refused. Existing accounts are linked by email.
 * Zoho redirect URI to register: <APP_URL>/api/auth/callback/zoho (same Zoho client as the calendar integration).
 */
const zohoClient = process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET
  ? { clientId: process.env.ZOHO_CLIENT_ID, clientSecret: process.env.ZOHO_CLIENT_SECRET } : null;
export const zohoLoginEnabled = Boolean(zohoClient);
const NOT_COMPANY = "Only company Zoho accounts can sign in. Use your work email.";

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
  emailAndPassword: { enabled: false }, // no password sign-up / sign-in / reset: Zoho only
  account: { accountLinking: { enabled: true, trustedProviders: ["zoho"] } },
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
          if (!isCompanyEmail(user.email)) throw new APIError("FORBIDDEN", { message: NOT_COMPANY });
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
          // Every sign-in, not only the first: an account whose email is (no longer) on a company domain is refused.
          // Platform superadmins are exempt so the operator cannot be locked out by a domain change.
          if (u.role !== "superadmin" && !isCompanyEmail(u.email)) throw new APIError("FORBIDDEN", { message: NOT_COMPANY });
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
      "/sign-in/social": { window: 60, max: 20 },
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
          const p = (await r.json()) as { ZUID?: string | number; Email?: string; Display_Name?: string; First_Name?: string; Last_Name?: string };
          if (p.ZUID == null || !p.Email) return null;
          const name = p.Display_Name || [p.First_Name, p.Last_Name].filter(Boolean).join(" ") || p.Email.split("@")[0]!;
          // Zoho only lets an address onto an account after verifying it (or the org admin created the mailbox).
          return { id: String(p.ZUID), email: p.Email.toLowerCase(), name, emailVerified: true };
        },
      }],
    })] : []),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
