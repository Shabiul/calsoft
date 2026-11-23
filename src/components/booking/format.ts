import { DateTime } from "luxon";

export function readableOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return L > 0.45 ? "#111827" : "#ffffff";
}

export function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function formatTime(iso: string, tz: string, hour12: boolean): string {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(tz).toFormat(hour12 ? "h:mm a" : "HH:mm").toLowerCase();
}

export function formatDateLong(iso: string, tz: string): string {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(tz).toFormat("cccc, LLLL d, yyyy");
}

export function formatRange(startIso: string, endIso: string, tz: string, hour12: boolean): string {
  return `${formatTime(startIso, tz, hour12)} - ${formatTime(endIso, tz, hour12)}`;
}

export function detectTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export function detectHour12(): boolean {
  try { return Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 ?? true; } catch { return true; }
}

let tzCache: string[] | null = null;
export function allTimeZones(): string[] {
  if (tzCache) return tzCache;
  let list: string[] = [];
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (f) list = f("timeZone");
  } catch { /* ignore */ }
  if (!list.includes("UTC")) list = ["UTC", ...list];
  return (tzCache = list);
}

export function tzOffsetLabel(tz: string): string {
  const dt = DateTime.now().setZone(tz);
  return dt.isValid ? `GMT${dt.toFormat("ZZ")}` : "";
}

export const LOCATION_LABELS: Record<string, string> = {
  google_meet: "Google Meet", zoom: "Zoom", teams: "Microsoft Teams", zoho_meeting: "Zoho Meeting", custom_url: "Online meeting",
  in_person: "In person", phone: "Phone call", invitee_phone: "Phone call (host calls you)",
};

/** Client-side safe URL check before navigating/rendering as href. */
export function isHttpUrl(u: string | null | undefined): u is string {
  if (!u) return false;
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:"; } catch { return false; }
}
