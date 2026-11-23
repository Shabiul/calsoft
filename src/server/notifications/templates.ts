import { DateTime } from "luxon";
import { escapeHtml, renderString, safeUrl } from "./escape";
import { generateIcs } from "./ics";
import { googleCalendarUrl, outlookCalendarUrl } from "@/server/public/ics";
import { notesUrl } from "@/server/notetaker";
import type { BookingContext, NotificationKind, RenderedEmail, RenderExtra, Role } from "./types";

const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";
const appName = () => process.env.APP_NAME ?? "MeetFlow";

export function formatWhen(d: Date, tz: string, withZone = true): string {
  const dt = DateTime.fromJSDate(d, { zone: tz });
  const base = (dt.isValid ? dt : DateTime.fromJSDate(d, { zone: "UTC" })).toFormat("cccc, LLLL d, yyyy 'at' h:mm a");
  return withZone ? `${base} (${tz})` : base;
}

/** "Wednesday, November 25, 2026 · 3:30 PM – 4:00 PM (India Standard Time)" */
export function formatRange(start: Date, end: Date, tz: string): string {
  let a = DateTime.fromJSDate(start, { zone: tz }), b = DateTime.fromJSDate(end, { zone: tz });
  if (!a.isValid) { a = a.setZone("UTC"); b = b.setZone("UTC"); }
  const t = (d: DateTime) => d.toFormat("h:mm a");
  const endPart = b.hasSame(a, "day") ? t(b) : b.toFormat("cccc, LLLL d 'at' h:mm a");
  return `${a.toFormat("cccc, LLLL d, yyyy")} · ${t(a)} – ${endPart} (${a.offsetNameLong ?? tz})`;
}

export function formatMoney(minor: number, currency: string): string {
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / 100); }
  catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
}

export function buildVars(ctx: BookingContext, role: Role, extra: RenderExtra = {}): Record<string, string> {
  const tz = role === "host" ? ctx.booking.hostTimeZone : ctx.booking.inviteeTimeZone;
  const manage = extra.manageToken ? `${appUrl()}/booking/${extra.manageToken}` : "";
  const join = ctx.booking.joinUrl ?? ctx.booking.meetingUrl;
  const location = join || ctx.eventType.locationValue || ctx.booking.locationType?.replace(/_/g, " ") || "";
  return {
    invitee_name: ctx.invitee.name, invitee_email: ctx.invitee.email,
    host_name: ctx.host.name, host_email: ctx.host.email,
    event_title: ctx.eventType.title,
    start_time: formatWhen(ctx.booking.startsAt, tz), end_time: formatWhen(ctx.booking.endsAt, tz),
    time_range: formatRange(ctx.booking.startsAt, ctx.booking.endsAt, tz),
    timezone: tz, location, meeting_url: join ?? "",
    manage_url: manage, cancel_reason: ctx.booking.cancelReason ?? "",
    previous_start_time: extra.previousStartsAt ? formatWhen(new Date(extra.previousStartsAt), tz) : "",
    dashboard_url: `${appUrl()}/dashboard/scheduled?b=${ctx.booking.id}`,
    // Meeting notes are private to the host: invitee emails never carry the link.
    notes_url: role === "host" && ["confirmed", "completed"].includes(ctx.booking.status) ? notesUrl(ctx.booking.id) : "",
    decline_reason: ctx.booking.cancelReason ?? "",
    amount: ctx.payment ? formatMoney(ctx.payment.amount, ctx.payment.currency) : "",
  };
}

const DEFAULT_BRAND = "#4f46e5"; // matches the app mark in public/email-logo.png
const brandOf = (ctx: BookingContext) => (/^#[0-9a-f]{6}$/i.test(ctx.branding?.brandColor ?? "") ? ctx.branding!.brandColor! : DEFAULT_BRAND);

const isImageUrl = (u?: string | null) => !!u && /^https:\/\/[^\s]+\.(png|jpe?g|gif|webp)(\?[^\s]*)?$/i.test(u) && !!safeUrl(u);

function layout(title: string, bodyHtml: string, brand = DEFAULT_BRAND, logoUrl?: string | null): string {
  const logo = isImageUrl(logoUrl)
    ? `<img src="${escapeHtml(logoUrl!)}" alt="${escapeHtml(appName())}" height="36" style="display:block;max-height:36px;max-width:180px;border:0">`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:10px"><img src="${escapeHtml(appUrl())}/email-logo.png" width="32" height="32" alt="" style="display:block;border:0;border-radius:8px"></td><td style="font-size:18px;font-weight:700;color:#111827">${escapeHtml(appName())}</td></tr></table>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:12px;border-top:4px solid ${brand};box-shadow:0 1px 3px rgba(0,0,0,.08)">
<tr><td style="padding:24px 32px 8px">${logo}</td></tr>
<tr><td style="padding:8px 32px 0"><h1 style="margin:0;font-size:22px;line-height:30px;font-weight:700;color:#111827">${escapeHtml(title)}</h1></td></tr>
<tr><td style="padding:12px 32px 28px;font-size:15px;line-height:24px;color:#374151">${bodyHtml}</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e5e7eb;font-size:12px;line-height:18px;color:#6b7280">Sent by ${escapeHtml(appName())}. You are receiving this because of a meeting booked through ${escapeHtml(appName())}.</td></tr>
</table></td></tr></table></body></html>`;
}

type Person = { name: string; email: string };
type DetailRow = { k: string; val: string; href?: string; people?: Person[] };
function durationLabel(min?: number): string {
  if (!min) return "";
  const h = Math.floor(min / 60), m = min % 60;
  return [h ? `${h} hour${h === 1 ? "" : "s"}` : "", m ? `${m} minute${m === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ");
}
function details(v: Record<string, string>, role: Role, brand = DEFAULT_BRAND, ctx?: BookingContext): { html: string; text: string } {
  const rows: DetailRow[] = [{ k: "Agenda", val: v.event_title }, { k: "When", val: v.time_range }];
  const dur = durationLabel(ctx?.eventType.durationMinutes);
  if (dur) rows.push({ k: "Duration", val: dur });
  rows.push({ k: "Host", val: "", people: [{ name: v.host_name, email: v.host_email }] });
  const attendees = ctx?.attendees?.length ? ctx.attendees : [{ name: v.invitee_name, email: v.invitee_email }];
  rows.push({ k: attendees.length > 1 ? "Attendees" : role === "host" ? "Invitee" : "Attendee", val: "", people: attendees });
  const meetUrl = safeUrl(v.meeting_url);
  if (meetUrl) rows.push({ k: "Where", val: ({ google_meet: "Google Meet", zoom: "Zoom", teams: "Microsoft Teams", zoho_meeting: "Zoho Meeting" } as Record<string, string>)[ctx?.booking.locationType ?? ""] ?? "Online meeting", href: meetUrl });
  else if (v.location) rows.push({ k: "Where", val: v.location });
  const notes = safeUrl(v.notes_url);
  if (notes) rows.push({ k: "Notes", val: "Meeting notes (only you)", href: notes });
  if (ctx?.eventType.description?.trim()) rows.push({ k: "About", val: ctx.eventType.description.trim().slice(0, 600) });
  if (role === "host") for (const a of ctx?.answers ?? []) rows.push({ k: a.question.slice(0, 60), val: a.answer.slice(0, 500) });
  // Internal meeting context written by the salesperson: host emails only.
  if (role === "host" && ctx?.booking.hostNotes?.trim()) rows.push({ k: "Context", val: ctx.booking.hostNotes.trim().slice(0, 2000) });
  const person = (p: Person) => `<div style="margin:0 0 6px"><div style="font-size:15px;color:#111827">${escapeHtml(p.name)}</div><a href="mailto:${escapeHtml(p.email)}" style="font-size:13px;color:#6b7280;text-decoration:none">${escapeHtml(p.email)}</a></div>`;
  const cell = ({ k, val, href, people }: DetailRow) => {
    const body = href
      ? `<a href="${escapeHtml(href)}" style="color:${brand};text-decoration:none;font-weight:600">${escapeHtml(val)}</a><br><span style="font-size:12px;color:#6b7280;word-break:break-all">${escapeHtml(href)}</span>`
      : people ? people.map(person).join("") : escapeHtml(val).replace(/\n/g, "<br>");
    return `<tr><td style="padding:8px 20px 8px 0;color:#6b7280;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;vertical-align:top;white-space:nowrap;padding-top:11px">${escapeHtml(k)}</td><td style="padding:8px 0;font-size:15px;color:#111827;vertical-align:top">${body}</td></tr>`;
  };
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px"><tr><td style="padding:8px 16px"><table role="presentation" cellpadding="0" cellspacing="0">${rows.map(cell).join("")}</table></td></tr></table>`;
  const text = rows.map(({ k, val, href, people }) => people ? `${k}:\n${people.map((p) => `  ${p.name} - ${p.email}`).join("\n")}` : `${k}: ${href ? `${val} (${href})` : val}`).join("\n");
  return { html, text };
}
function seriesBlock(ctx: BookingContext, role: Role): { html: string; text: string } {
  const live = (ctx.series ?? []).filter((s) => s.status !== "cancelled" && s.status !== "expired");
  if (live.length < 2) return { html: "", text: "" };
  const tz = role === "host" ? ctx.booking.hostTimeZone : ctx.booking.inviteeTimeZone;
  const dates = live.map((s) => formatWhen(s.startsAt, tz, false));
  const head = `This is a recurring series of ${live.length} sessions (${tz}):`;
  return {
    html: `<p style="margin:12px 0 4px">${escapeHtml(head)}</p><ol style="margin:0;padding-left:20px">${dates.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ol>`,
    text: [head, ...dates.map((l, i) => `${i + 1}. ${l}`)].join("\n"),
  };
}
type Btn = { a: string; text: string };
function btn(label: string, url: string, brand = DEFAULT_BRAND, variant: "primary" | "outline" = "primary"): Btn {
  const u = safeUrl(url);
  if (!u) return { a: "", text: "" };
  const style = variant === "primary"
    ? `background:${brand};color:#ffffff;border:2px solid ${brand}`
    : `background:#ffffff;color:${brand};border:2px solid ${brand}`;
  return {
    a: `<a href="${escapeHtml(u)}" style="display:inline-block;${style};padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin:0 8px 8px 0">${escapeHtml(label)}</a>`,
    text: `${label}: ${u}`,
  };
}
function link(label: string, url: string, brand = DEFAULT_BRAND): { html: string; text: string } {
  const b = btn(label, url, brand);
  return { html: b.a ? `<p style="margin:20px 0 8px">${b.a}</p>` : "", text: b.text };
}

function icsFor(ctx: BookingContext, method: "REQUEST" | "CANCEL", v: Record<string, string>) {
  const content = generateIcs({
    uid: `${ctx.booking.id}@meetflow`, startsAt: ctx.booking.startsAt, endsAt: ctx.booking.endsAt,
    summary: `${ctx.eventType.title}: ${ctx.invitee.name} / ${ctx.host.name}`,
    description: [ctx.eventType.description?.trim(), safeUrl(ctx.booking.meetingUrl ?? "") ? `Join the meeting: ${safeUrl(ctx.booking.meetingUrl ?? "")}` : ""].filter(Boolean).join("\n\n") || undefined,
    // Calendar invite: real meeting URL (emails only display the masked link).
    location: safeUrl(ctx.booking.meetingUrl ?? "") || v.location || undefined, organizer: ctx.host, attendee: ctx.invitee, method, sequence: method === "CANCEL" ? 1 : 0,
  });
  return [{ filename: "invite.ics", content, contentType: `text/calendar; method=${method}; charset=utf-8` }];
}

/** Render a built-in template. Workflow-provided subject/body are untrusted and escaped. */
export function renderNotification(kind: NotificationKind, ctx: BookingContext, role: Role, extra: RenderExtra = {}): RenderedEmail {
  const v = buildVars(ctx, role, extra);
  const brand = brandOf(ctx);
  const d = details(v, role, brand, ctx);
  // Invitees and extra attendees get an "Accept" button that opens their calendar with the event and Meet link prefilled.
  const acceptable = role === "invitee" && ["confirmation", "approved", "reschedule"].includes(kind) && ctx.booking.status === "confirmed";
  // The event added to the attendee's calendar carries the REAL meeting URL; emails only display the masked /j/ link.
  const meetUrl = safeUrl(ctx.booking.meetingUrl ?? "");
  const calEvent = {
    title: `${v.event_title} with ${v.host_name}`,
    description: [ctx.eventType.description?.trim(), meetUrl ? `Join the meeting: ${meetUrl}` : ""].filter(Boolean).join("\n\n"),
    location: meetUrl || v.location || undefined, startsAt: ctx.booking.startsAt, endsAt: ctx.booking.endsAt,
  };
  const googleUrl = googleCalendarUrl(calEvent), outlookUrl = outlookCalendarUrl(calEvent);
  const accept = acceptable ? btn("Accept & add to calendar", googleUrl, brand, "primary") : { a: "", text: "" };
  const acceptNote = acceptable
    ? `<p style="margin:0 0 8px;font-size:13px;color:#6b7280">Opens your Google Calendar with the event and meeting link filled in. Using Outlook? <a href="${escapeHtml(outlookUrl)}" style="color:${brand}">Add to Outlook</a>. The invite file (.ics) is also attached.</p>` : "";
  const meet = btn("Join meeting", v.meeting_url, brand, acceptable ? "outline" : "primary");
  const manage = btn("Manage booking", v.manage_url, brand, "outline");
  // The event's "confirmation message" (booking page settings) is shown to the invitee/attendees in confirmation emails.
  const msg = (kind === "confirmation" || kind === "approved") && role === "invitee" ? ctx.branding?.successMessage?.trim() : "";
  const compose = (
    title: string, intro: string,
    opts: { ics?: "REQUEST" | "CANCEL"; extraHtml?: string; extraText?: string; links?: boolean; meetOnly?: boolean; series?: boolean } = {},
  ): RenderedEmail => {
    const links = opts.links !== false;
    const ser = opts.series === false ? { html: "", text: "" } : seriesBlock(ctx, role);
    const msgHtml = msg ? `<p style="margin:12px 0;padding:12px;background:#f3f4f6;border-radius:8px;white-space:pre-wrap">${escapeHtml(msg)}</p>` : "";
    const row = links ? [accept.a, meet.a, manage.a] : opts.meetOnly ? [meet.a] : [];
    const buttonsHtml = row.some(Boolean) ? `<p style="margin:20px 0 8px">${row.join("")}</p>${links ? acceptNote : ""}` : "";
    const html = layout(title, `<p>${escapeHtml(intro)}</p>${d.html}${ser.html}${msgHtml}${opts.extraHtml ?? ""}${buttonsHtml}`, brand, ctx.branding?.logoUrl);
    const text = [title, "", intro, "", d.text, ser.text, msg ?? "", opts.extraText ?? "", links ? accept.text : "", links || opts.meetOnly ? meet.text : "", links ? manage.text : ""].filter((x) => x !== "").join("\n");
    return { subject: title.replace(/[\r\n]+/g, " ").slice(0, 200), html, text, // The host already has the event on their own calendar; attaching an invite for it makes Gmail show "Unable to load event".
    attachments: opts.ics && role !== "host" ? icsFor(ctx, opts.ics, v) : undefined };
  };
  const who = role === "host" ? v.invitee_name : v.host_name;

  switch (kind) {
    case "confirmation":
      return compose(`Confirmed: ${v.event_title} with ${who}`, `Hi ${v.invitee_name}, your booking is confirmed.`, { ics: "REQUEST" });
    case "host_notification":
      return compose(`New booking: ${v.event_title} with ${v.invitee_name}`, `${v.invitee_name} booked ${v.event_title} with you.`, { links: false, meetOnly: true });
    case "request_received":
      return compose(`Request sent: ${v.event_title} with ${who}`,
        `Hi ${v.invitee_name}, your request was sent to ${v.host_name} and is awaiting approval. The time is held for you; you will get an email as soon as it is approved or declined.`);
    case "approval_request": {
      const open = link("Review request", v.dashboard_url);
      return compose(`Approval needed: ${v.event_title} with ${v.invitee_name}`,
        `${v.invitee_name} requested ${v.event_title}. The time is held until you approve or decline it.`,
        { links: false, extraHtml: open.html, extraText: open.text });
    }
    case "approved":
      return compose(`Approved: ${v.event_title} with ${who}`, `Hi ${v.invitee_name}, ${v.host_name} approved your request. Your booking is confirmed.`, { ics: "REQUEST" });
    case "declined": {
      const why = v.decline_reason ? `Reason: ${v.decline_reason}` : "";
      return compose(`Declined: ${v.event_title} with ${who}`, `Hi ${v.invitee_name}, unfortunately ${v.host_name} could not accept your request. The time has been released.`, {
        links: false, extraHtml: why ? `<p>${escapeHtml(why)}</p>` : "", extraText: why,
      });
    }
    case "cancellation": {
      const why = v.cancel_reason ? `Reason: ${v.cancel_reason}` : "";
      const intro = extra.seriesCount && extra.seriesCount > 1 ? `All ${extra.seriesCount} remaining sessions of this series have been cancelled.` : "The following booking has been cancelled.";
      return compose(`Cancelled: ${v.event_title} with ${who}`, intro, {
        ics: "CANCEL", links: false, extraHtml: why ? `<p>${escapeHtml(why)}</p>` : "", extraText: why,
      });
    }
    case "host_changed":
      return compose(`New host: ${v.event_title} with ${v.host_name}`,
        `Your meeting now takes place with ${v.host_name}. The time and your join link stay the same.`, { series: false, ics: "REQUEST" });
    case "reschedule": {
      const prev = v.previous_start_time ? `Previously: ${v.previous_start_time}` : "";
      return compose(`Rescheduled: ${v.event_title} with ${who}`, "The booking has been moved to a new time.", { series: false,
        ics: "REQUEST", extraHtml: prev ? `<p style="color:#6b7280">${escapeHtml(prev)}</p>` : "", extraText: prev,
      });
    }
    case "reminder": {
      const m = extra.minutesBefore ?? 0;
      if (m === 0) return compose(`Today: ${v.event_title} with ${who} at ${v.start_time}`, `This is a reminder that you have a meeting today at ${v.start_time}.`, { series: false });
      const when = m >= 1440 && m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}`
        : m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`;
      return compose(`Reminder: ${v.event_title} with ${who} in ${when}`, "This is a reminder about your upcoming meeting.", { series: false });
    }
    case "notes_ready": {
      const sum = extra.summary?.trim().slice(0, 8000) ?? "";
      const open = btn("Open meeting notes", v.notes_url, brand);
      return compose(`Meeting notes: ${v.event_title} with ${who}`,
        sum ? "Here is the summary of your meeting. The full transcript and shared notes are on the notes page." : "The notes and transcript from your meeting are ready.",
        { links: false, series: false,
          extraHtml: (sum ? `<div style="margin:12px 0;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;white-space:pre-wrap;font-size:14px;line-height:22px">${escapeHtml(sum)}</div>` : "") + (open.a ? `<p style="margin:20px 0 8px">${open.a}</p>` : ""),
          extraText: [sum, open.text].filter(Boolean).join("\n\n") });
    }
    case "action_items": {
      const items = (extra.actionItems ?? []).slice(0, 50);
      const open = btn("Open meeting notes", v.notes_url, brand);
      const li = items.map((i) => `<li style="margin:0 0 8px">${escapeHtml(i.task)}${i.due ? ` <span style="color:#6b7280">(${escapeHtml(i.due)})</span>` : ""}</li>`).join("");
      return compose(`Your action items: ${v.event_title}`, `Here are the tasks assigned to you in ${v.event_title}.`, {
        links: false, series: false,
        extraHtml: `<ul style="margin:12px 0;padding-left:20px">${li}</ul>` + (open.a ? `<p style="margin:20px 0 8px">${open.a}</p>` : ""),
        extraText: [...items.map((i) => `- ${i.task}${i.due ? ` (${i.due})` : ""}`), open.text].filter(Boolean).join("\n"),
      });
    }
    case "follow_up":
      return compose(`Thanks for meeting: ${v.event_title}`, `Thanks for taking the time to meet, ${v.invitee_name}.`, { links: false });
    case "payment_confirmation":
      return compose(`Payment received for ${v.event_title}`, `We received your payment${v.amount ? ` of ${v.amount}` : ""}. Thank you!`);
    case "payment_failed":
      return compose(`Payment failed for ${v.event_title}`, `Your payment${v.amount ? ` of ${v.amount}` : ""} could not be processed, so the booking is not confirmed yet. Please try again.`);
    case "workflow": {
      const subject = renderString(extra.subject ?? v.event_title, v).replace(/[\r\n]+/g, " ").slice(0, 200);
      const body = extra.body ?? "";
      // The invite goes to the invitee only (the host already has the event on their own calendar; attaching it makes Gmail show
      // "Unable to load event"). A cancelled booking gets a cancellation invite that removes the event from their calendar.
      const attach = extra.attachIcs && role === "invitee" ? icsFor(ctx, ctx.booking.status === "cancelled" ? "CANCEL" : "REQUEST", v) : undefined;
      return {
        subject,
        html: layout(subject, `<div style="white-space:pre-wrap">${renderString(body, v, true)}</div>`, brand, ctx.branding?.logoUrl),
        text: renderString(body, v),
        attachments: attach,
      };
    }
  }
}
