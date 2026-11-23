/**
 * Who may sign in: only Zoho accounts whose email is on one of the company domains in ALLOWED_EMAIL_DOMAINS
 * (comma-separated, e.g. "acme.com,acme.in"). Unset = nobody new can get in (fail closed).
 */
export const allowedEmailDomains = (raw = process.env.ALLOWED_EMAIL_DOMAINS ?? ""): string[] =>
  raw.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);

export function isCompanyEmail(email: string | null | undefined, domains = allowedEmailDomains()): boolean {
  const at = (email ?? "").trim().toLowerCase().lastIndexOf("@");
  if (at < 1) return false;
  const domain = (email ?? "").trim().toLowerCase().slice(at + 1);
  return domains.includes(domain); // exact match: "evil-acme.com" or "acme.com.evil.io" never pass for "acme.com"
}
