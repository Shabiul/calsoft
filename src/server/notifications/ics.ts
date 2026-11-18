function esc(t: string): string {
  return t.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** RFC 5545 line folding at 75 octets. */
export function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curLen = 0;
  let limit = 75;
  for (const ch of line) {
    const l = Buffer.byteLength(ch);
    if (curLen + l > limit) { parts.push(cur); cur = ""; curLen = 0; limit = 74; }
    cur += ch; curLen += l;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

export interface IcsInput {
  uid: string; startsAt: Date; endsAt: Date; summary: string; description?: string; location?: string;
  organizer?: { name: string; email: string }; attendee?: { name: string; email: string };
  method?: "REQUEST" | "CANCEL"; sequence?: number;
}
export function generateIcs(i: IcsInput): string {
  const method = i.method ?? "REQUEST";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MeetFlow//EN", "CALSCALE:GREGORIAN", `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${i.uid}`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(i.startsAt)}`, `DTEND:${stamp(i.endsAt)}`,
    `SEQUENCE:${i.sequence ?? 0}`, `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    `SUMMARY:${esc(i.summary)}`,
  ];
  if (i.description) lines.push(`DESCRIPTION:${esc(i.description)}`);
  if (i.location) lines.push(`LOCATION:${esc(i.location)}`);
  if (i.organizer) lines.push(`ORGANIZER;CN="${i.organizer.name.replace(/["\r\n]/g, "")}":mailto:${i.organizer.email}`);
  if (i.attendee) lines.push(`ATTENDEE;CN="${i.attendee.name.replace(/["\r\n]/g, "")}";RSVP=FALSE:mailto:${i.attendee.email}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
