import { resolveMx as dnsResolveMx } from "node:dns/promises";
import type { OAuthProviderName } from "./types";

export type MailProviderId = "google" | "microsoft" | "zoho" | "other" | "unknown";

export interface MailDetection {
  email: string;
  domain: string;
  kind: "personal" | "business" | "unknown";
  provider: MailProviderId;
  label: string;
  recommended: OAuthProviderName[];
  reason: string;
}

type Opts = { resolveMx?: (domain: string) => Promise<string[]> };

const LOOKUP_TIMEOUT_MS = 2500;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 60 * 60 * 1000;

const EMAIL_RE = /^[a-z0-9._%+'!#$&*/=?^`{|}~-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

const cache = new Map<string, { at: number; value: Omit<MailDetection, "email"> }>();

function build(
  email: string,
  domain: string,
  kind: MailDetection["kind"],
  provider: MailProviderId,
  label: string,
  reason: string,
): MailDetection {
  const recommended: OAuthProviderName[] =
    provider === "google" ? ["google"] : provider === "microsoft" ? ["microsoft"] : provider === "zoho" ? ["zoho"] : [];
  return { email, domain, kind, provider, label, recommended, reason };
}

const MS_PERSONAL = /^(outlook|hotmail|live|msn|passport)\.[a-z.]+$/;
const ZOHO_PERSONAL = /^(zoho\.[a-z.]+|zohomail\.[a-z.]+)$/;
const OTHER_PERSONAL = new Set([
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "gmx.de", "mail.com", "yandex.com", "yandex.ru", "fastmail.com",
  "tutanota.com", "tuta.io", "hey.com", "qq.com", "163.com", "126.com", "zoho.eu.invalid",
]);
const YAHOO = /^(yahoo|ymail|rocketmail)\.[a-z.]+$/;

function staticLookup(email: string, domain: string): MailDetection | null {
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return build(email, domain, "personal", "google", "Gmail", "Your Gmail account works best with Google Calendar and Google Meet.");
  }
  if (MS_PERSONAL.test(domain)) {
    return build(email, domain, "personal", "microsoft", "Outlook.com", "Your Outlook.com account works best with Microsoft Calendar and Teams.");
  }
  if (ZOHO_PERSONAL.test(domain)) {
    return build(email, domain, "personal", "zoho", "Zoho Mail", "Your Zoho Mail account works best with Zoho Calendar and Zoho Meeting.");
  }
  if (YAHOO.test(domain) || OTHER_PERSONAL.has(domain)) {
    return build(email, domain, "personal", "other", "Other email provider", "We could not match your email provider to a calendar service, so all options are shown.");
  }
  return null;
}

export function classifyMxHosts(hosts: string[]): MailProviderId {
  const hs = hosts.map((h) => h.toLowerCase().replace(/\.$/, ""));
  if (hs.some((h) => h === "google.com" || h.endsWith(".google.com") || h === "googlemail.com" || h.endsWith(".googlemail.com"))) {
    return "google";
  }
  if (hs.some((h) => h.endsWith(".mail.protection.outlook.com") || h.endsWith(".protection.outlook.com"))) {
    return "microsoft";
  }
  if (hs.some((h) => /^mx[0-9]*\.zoho\.(com|in|eu|com\.au|jp|sa|ca|com\.cn)$/.test(h))) {
    return "zoho";
  }
  return "other";
}

async function defaultResolve(domain: string): Promise<string[]> {
  const records = await dnsResolveMx(domain);
  return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function businessResult(email: string, domain: string, provider: MailProviderId): MailDetection {
  switch (provider) {
    case "google":
      return build(email, domain, "business", "google", "Google Workspace", "Your work email is hosted on Google Workspace.");
    case "microsoft":
      return build(email, domain, "business", "microsoft", "Microsoft 365", "Your work email is hosted on Microsoft 365.");
    case "zoho":
      return build(email, domain, "business", "zoho", "Zoho Mail", "Your work email is hosted on Zoho Mail.");
    case "unknown":
      return build(email, domain, "unknown", "unknown", "Other email provider", "We could not check your email provider, so all options are shown.");
    default:
      return build(email, domain, "business", "other", "Other email provider", "We could not match your email host to a calendar service, so all options are shown.");
  }
}

export async function detectMailProvider(email: string, opts?: Opts): Promise<MailDetection> {
  const norm = String(email ?? "").trim().toLowerCase();
  const m = EMAIL_RE.exec(norm);
  if (!m || norm.length > 254) {
    return build(norm, "", "unknown", "unknown", "Other email provider", "Enter a valid email address to get a recommendation.");
  }
  const domain = m[1];

  const fixed = staticLookup(norm, domain);
  if (fixed) return fixed;

  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { email: norm, ...hit.value };
  }

  let provider: MailProviderId;
  try {
    const resolver = opts?.resolveMx ?? defaultResolve;
    const hosts = await withTimeout(Promise.resolve().then(() => resolver(domain)), LOOKUP_TIMEOUT_MS);
    provider = hosts.length ? classifyMxHosts(hosts) : "other";
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // No MX / nonexistent domain is a definite answer; anything else is undeterminable.
    provider = code === "ENODATA" || code === "ENOTFOUND" ? "other" : "unknown";
  }

  const result = businessResult(norm, domain, provider);
  if (provider !== "unknown") {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const { email: _e, ...rest } = result;
    void _e;
    cache.set(domain, { at: Date.now(), value: rest });
  }
  return result;
}
