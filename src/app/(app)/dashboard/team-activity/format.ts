import { DateTime } from "luxon";

/** Display helpers for the team-activity pages (times shown in the VIEWER's time zone). */
export const METHOD_LABEL: Record<string, string> = { google: "Google", zoho: "Zoho", supabase_code: "Email code", supabase_password: "Email + password", supabase_link: "Magic link", unknown: "Unknown" };
export const methodLabel = (p: string | null | undefined) => (p ? METHOD_LABEL[p] ?? p : "Unknown");

export const abs = (d: Date | string | null, tz: string, fmt = "ccc d LLL, h:mm a") => (d ? DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat(fmt) : "-");
export const rel = (d: Date | string | null) => (d ? (DateTime.fromJSDate(new Date(d)).toRelative() ?? "-") : "Never");

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
