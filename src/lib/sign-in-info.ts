/** Small, dependency-free helpers for the sign-in log: a readable browser summary and the sign-in method. */

export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

type Ctx = { path?: string; params?: Record<string, string | undefined> } | null | undefined;

/** "google" | "zoho" | ... taken from the OAuth callback route (/callback/:id, /oauth2/callback/:providerId); "unknown" otherwise. */
export function providerFromContext(ctx: Ctx): string {
  const sb = /\/supabase\/(verify|password|signup|exchange)/.exec(ctx?.path ?? "");
  if (sb) return { verify: "supabase_code", password: "supabase_password", signup: "supabase_password", exchange: "supabase_link" }[sb[1]!]!;
  const id = ctx?.params?.id ?? ctx?.params?.providerId;
  if (id) return id.toLowerCase().slice(0, 30);
  const m = /callback\/([a-z0-9_-]+)/i.exec(ctx?.path ?? "");
  return m ? m[1]!.toLowerCase() : "unknown";
}
