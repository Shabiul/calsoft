import { allowedEmailDomains, isCompanyEmail } from "./company-email";

export type ZohoProfile = { ZUID?: string | number; Email?: string; Display_Name?: string; First_Name?: string; Last_Name?: string };

/**
 * Zoho user info -> the user better-auth should sign in, or null to refuse. Zoho sign-in is for COMPANY accounts only: an address
 * outside ALLOWED_EMAIL_DOMAINS (or no domains configured) is refused before any account is created. Google sign-in is separate and open.
 * Account identity is the immutable Zoho user id (ZUID), never the email.
 */
export function zohoProfileToUser(p: ZohoProfile, domains = allowedEmailDomains()) {
  if (p.ZUID == null || !p.Email) return null;
  const email = p.Email.toLowerCase();
  if (!isCompanyEmail(email, domains)) return null;
  const name = p.Display_Name || [p.First_Name, p.Last_Name].filter(Boolean).join(" ") || email.split("@")[0]!;
  // Zoho only lets an address onto an account after verifying it (or the org admin created the mailbox).
  return { id: String(p.ZUID), email, name, emailVerified: true };
}
