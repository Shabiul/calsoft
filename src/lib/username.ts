/** Pure username rules (no DB). Public routes live at /[username], so anything that collides with an app route is reserved. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "login", "logout", "signin", "sign-in", "signup", "sign-up", "register", "dashboard", "api", "booking", "bookings",
  "admin", "administrator", "superadmin", "embed", "app", "auth", "forgot-password", "reset-password", "verify-email",
  "verify", "settings", "account", "profile", "billing", "pricing", "about", "contact", "contacts", "help", "support",
  "docs", "blog", "legal", "terms", "privacy", "security", "status", "team", "teams", "org", "organization", "organizations",
  "workflows", "routing", "routing-forms", "integrations", "analytics", "availability", "event-types", "events",
  "scheduled-events", "booking-links", "r", "s", "u", "www", "mail", "email", "root", "system", "null", "undefined",
  "public", "static", "assets", "_next", "favicon.ico", "robots.txt", "sitemap.xml", "webhooks", "webhook", "oauth",
  "callback", "cancel", "reschedule", "confirm", "invite", "invitation", "invitations", "home", "index", "new", "me",
  "meetflow", "calendly", "cal", "demo", "test",
]);

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export type UsernameCheck = { ok: true; username: string } | { ok: false; reason: "format" | "length" | "reserved"; message: string };

export function validateUsername(input: string): UsernameCheck {
  const username = normalizeUsername(input);
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX)
    return { ok: false, reason: "length", message: `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters.` };
  if (!USERNAME_RE.test(username) || /[-_]{2}/.test(username))
    return { ok: false, reason: "format", message: "Use lowercase letters, numbers, hyphens and underscores; start and end with a letter or number." };
  if (RESERVED_USERNAMES.has(username))
    return { ok: false, reason: "reserved", message: "This username is reserved. Please choose another." };
  return { ok: true, username };
}

/** Turn an arbitrary name/email local-part into a valid username base (may still be taken). */
export function slugifyUsername(input: string): string {
  let s = input.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > USERNAME_MAX - 5) s = s.slice(0, USERNAME_MAX - 5).replace(/-+$/g, "");
  if (s.length < USERNAME_MIN) s = (s + "user").slice(0, USERNAME_MAX);
  if (RESERVED_USERNAMES.has(s)) s = `${s}-1`;
  return s;
}

/** Candidate list in preference order for the suggestion UI / auto-claim. */
export function usernameCandidates(base: string, count = 6, rand: () => number = Math.random): string[] {
  const b = slugifyUsername(base);
  const out = [b];
  for (let i = 1; out.length < Math.ceil(count / 2); i++) out.push(`${b}${i + 1}`.slice(0, USERNAME_MAX));
  while (out.length < count) out.push(`${b}${Math.floor(rand() * 9000 + 1000)}`.slice(0, USERNAME_MAX));
  return [...new Set(out)].filter((c) => validateUsername(c).ok);
}
