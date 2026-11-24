import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { isCompanyEmail } from "@/lib/company-email";

/**
 * May this account use the app? Yes when it is a platform superadmin, its email is on a company domain, or it signs in with Google
 * (Google sign-in is open to any Google account). Zoho-only accounts must stay on a company domain: if the domain list changes, they
 * lose access. Used at every sign-in and for API keys.
 */
export async function accountMayUseApp(userId: string, email: string, platformRole?: string | null): Promise<boolean> {
  if (platformRole === "superadmin") return true;
  if (isCompanyEmail(email)) return true;
  const [g] = await db.select({ id: schema.accounts.id }).from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, "google"))).limit(1);
  return !!g;
}

/** Emails that are always platform superadmins (SUPERADMIN_EMAILS, comma-separated). Applied at sign-in, only for addresses the sign-in method has verified. */
export const superadminEmails = (raw = process.env.SUPERADMIN_EMAILS ?? ""): string[] =>
  raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Promotes the user to platform superadmin when their (verified) email is on the SUPERADMIN_EMAILS list. Returns the resulting role. */
export async function ensureSuperadmin(userId: string, email: string, currentRole: string | null | undefined): Promise<string> {
  if (currentRole === "superadmin") return "superadmin";
  if (!superadminEmails().includes(email.trim().toLowerCase())) return currentRole ?? "user";
  await db.update(schema.users).set({ platformRole: "superadmin" }).where(eq(schema.users.id, userId));
  await db.insert(schema.auditLogs).values({ actorId: null, action: "platform.superadmin_granted", entity: "user", entityId: userId, meta: { via: "SUPERADMIN_EMAILS" } }).catch(() => undefined);
  return "superadmin";
}

/** Supabase email/password/code sign-in is for the company: a company-domain address, or an address that is a superadmin (listed or already one). */
export async function emailMaySignInWithSupabase(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (isCompanyEmail(e) || superadminEmails().includes(e)) return true;
  const [u] = await db.select({ role: schema.users.platformRole }).from(schema.users).where(eq(schema.users.email, e)).limit(1);
  return u?.role === "superadmin";
}
