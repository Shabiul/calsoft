/** Server-side ICS (RFC 5545) generation and "add to calendar" links. Pure functions. */

export type IcsInput = {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date | string;
  endsAt: Date | string;
  url?: string | null;
  organizerName?: string | null;
  attendeeEmail?: string | null;
  cancelled?: boolean;
  sequence?: number;
  now?: Date;
};

export function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** Strip CR/LF, quotes and control chars from parameter values (prevents property injection). */
function paramSafe(s: string): string {
  return s.replace(/[\r\n"]/g, " ").replace(/[\u0000-\u001f]/g, "");
}

export function icsDate(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Fold to 75 octets per line (UTF-8 aware); continuation lines start with a space. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) { out.push(cur); cur = ""; curBytes = 0; limit = 74; }
    cur += ch; curBytes += b;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

export function generateIcs(i: IcsInput): string {
  const stamp = icsDate(i.now ?? new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MeetFlow//Booking//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${i.cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${icsEscape(i.uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsDate(i.startsAt)}`,
    `DTEND:${icsDate(i.endsAt)}`,
    `SEQUENCE:${i.sequence ?? 0}`,
    `SUMMARY:${icsEscape(i.title)}`,
    `STATUS:${i.cancelled ? "CANCELLED" : "CONFIRMED"}`,
  ];
  const desc = [i.description?.trim(), i.url ? `Manage booking: ${i.url}` : ""].filter(Boolean).join("\n\n");
  if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
  if (i.location) lines.push(`LOCATION:${icsEscape(i.location)}`);
  if (i.url) lines.push(`URL:${icsEscape(i.url)}`);
  if (i.organizerName) lines.push(`ORGANIZER;CN="${paramSafe(i.organizerName)}":mailto:noreply@meetflow.invalid`);
  if (i.attendeeEmail) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${paramSafe(i.attendeeEmail)}`);
  lines.push("BEGIN:VALARM", "TRIGGER:-PT15M", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM");
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

type LinkInput = Pick<IcsInput, "title" | "description" | "location" | "startsAt" | "endsAt">;

export function googleCalendarUrl(i: LinkInput): string {
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: i.title,
    dates: `${icsDate(i.startsAt)}/${icsDate(i.endsAt)}`,
  });
  if (i.description) p.set("details", i.description);
  if (i.location) p.set("location", i.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function outlookCalendarUrl(i: LinkInput): string {
  const iso = (d: Date | string) => (typeof d === "string" ? new Date(d) : d).toISOString();
  const p = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: i.title,
    startdt: iso(i.startsAt),
    enddt: iso(i.endsAt),
  });
  if (i.description) p.set("body", i.description);
  if (i.location) p.set("location", i.location);
  return `https://outlook.live.com/calendar/0/action/compose?${p.toString()}`;
}
