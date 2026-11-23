import type { OAuthProviderName } from "./types";

export const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

const ENV: Record<OAuthProviderName, [string, string]> = {
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  microsoft: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  zoom: ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"],
  zoho: ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET"],
};

const isReal = (v: string | undefined) => !!v && v.trim() !== "" && !/^(changeme|your[-_]|xxx|placeholder|todo)/i.test(v.trim());

export function credentialsFor(p: OAuthProviderName): { clientId: string; clientSecret: string } | null {
  const [i, s] = ENV[p];
  const clientId = process.env[i], clientSecret = process.env[s];
  return isReal(clientId) && isReal(clientSecret) ? { clientId: clientId!, clientSecret: clientSecret! } : null;
}
export const isConfigured = (p: OAuthProviderName) => credentialsFor(p) !== null;
export const missingEnv = (p: OAuthProviderName) => ENV[p].filter((k) => !isReal(process.env[k]));
export const redirectUri = (p: OAuthProviderName) => `${appUrl()}/api/integrations/${p}/callback`;
export const webhookUrl = (p: "google" | "microsoft" | "zoho") =>
  `${appUrl()}/api/webhooks/${p === "google" ? "google-calendar" : "microsoft-graph"}`;
/** Google and Microsoft only deliver push notifications to public HTTPS urls. */
export const canReceiveWebhooks = () => appUrl().startsWith("https://");
export const PROVIDER_LABEL: Record<OAuthProviderName, string> = { google: "Google Calendar", microsoft: "Microsoft Outlook / Teams", zoom: "Zoom", zoho: "Zoho Calendar / Meeting" };

/** Zoho runs separate data centers (com, in, eu, com.au, jp, ca, sa, uk). Accounts, Calendar and Meeting live on matching hosts. Set ZOHO_DC to the account's region. */
export const zohoDc = () => (process.env.ZOHO_DC ?? "com").trim().toLowerCase().replace(/^\.|^zoho\./, "") || "com";
export const zohoHost = (kind: "accounts" | "calendar" | "meeting") => `https://${kind}.zoho.${zohoDc()}`;
