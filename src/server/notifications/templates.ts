import { DateTime } from "luxon";
import { escapeHtml, renderString, safeUrl } from "./escape";
import { generateIcs } from "./ics";
import type { BookingContext, NotificationKind, RenderedEmail, RenderExtra, Role } from "./types";

const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";
const appName = () => process.env.APP_NAME ?? "MeetFlow";

export function formatWhen(d: Date, tz: string, withZone = true): string {
  const dt = DateTime.fromJSDate(d, { zone: tz });
  const base = (dt.isValid ? dt : DateTime.fromJSDate(d, { zone: "UTC" })).toFormat("cccc, LLLL d, yyyy 'at' h:mm a");
  return withZone ? `${base} (${tz})` : base;
}

export function formatMoney(minor: number, currency: string): string {
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / 100); }
  catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
}

export function buildVars(ctx: BookingContext, role: Role, extra: RenderExtra = {}): Record<string, string> {
  const tz = role === "host" ? ctx.booking.hostTimeZone : ctx.booking.inviteeTimeZone;
  const manage = extra.manageToken ? `${appUrl()}/booking/${extra.manageToken}` : "";
  const location = ctx.booking.meetingUrl || ctx.eventType.locationValue || ctx.booking.locationType?.replace(/_/g, " ") || "";
  return {
    invitee_name: ctx.invitee.name, invitee_email: ctx.invitee.email,
    host_name: ctx.host.name, host_email: ctx.host.email,
    event_title: ctx.eventType.title,
    start_time: formatWhen(ctx.booking.startsAt, tz), end_time: formatWhen(ctx.booking.endsAt, tz),
    timezone: tz, location, meeting_url: ctx.booking.meetingUrl ?? "",
    manage_url: manage, cancel_reason: ctx.booking.cancelReason ?? "",
    previous_start_time: extra.previousStartsAt ? formatWhen(new Date(extra.previousStartsAt), tz) : "",
    dashboard_url: `${appUrl()}/dashboard/scheduled?b=${ctx.booking.id}`,
    decline_reason: ctx.booking.cancelReason ?? "",
    amount: ctx.payment ? formatMoney(ctx.payment.amount, ctx.payment.currency) : "",
  };
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:28px">
<tr><td><h2 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h2>${bodyHtml}
<p style="margin:24px 0 0;font-size:12px;color:#6b7280">Sent by ${escapeHtml(appName())}</p></td></tr></table></td></tr></table></body></html>`;
}

function details(v: Record<string, string>, role: Role): { html: string; text: string } {
  const rows: [string, string][] = [["What", v.event_title], ["When", v.start_time]];
  rows.push([role === "host" ? "Invitee" : "With", role === "host" ? `${v.invitee_name} <${v.invitee_email}>` : v.host_name]);
  if (v.location) rows.push(["Where", v.location]);
  const html = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0">${rows
    .map(([k, val]) => `<tr><td style="padding:4px 16px 4px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(val)}</td></tr>`).join("")}</table>`;
  return { html, text: rows.map(([k, val]) => `${k}: ${val}`).join("\n") };
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
function link(label: string, url: string): { html: string; text: string } {
  const u = safeUrl(url);
  if (!u) return { html: "", text: "" };
  return {
    html: `<p><a href="${escapeHtml(u)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${escapeHtml(label)}</a></p>`,
    text: `${label}: ${u}`,
  };
}

function icsFor(ctx: BookingContext, method: "REQUEST" | "CANCEL", v: Record<string, string>) {
  const content = generateIcs({
    uid: `${ctx.booking.id}@meetflow`, startsAt: ctx.booking.startsAt, endsAt: ctx.booking.endsAt,
    summary: `${ctx.eventType.title}: ${ctx.invitee.name} / ${ctx.host.name}`, description: ctx.eventType.description ?? undefined,
    location: v.location || undefined, organizer: ctx.host, attendee: ctx.invitee, method, sequence: method === "CANCEL" ? 1 : 0,
  });
  return [{ filename: "invite.ics", content, contentType: `text/calendar; method=${method}; charset=utf-8` }];
}

/** Render a built-in template. Workflow-provided subject/body are untrusted and escaped. */
export function renderNotification(kind: NotificationKind, ctx: BookingContext, role: Role, extra: RenderExtra = {}): RenderedEmail {
  const v = buildVars(ctx, role, extra);
  const d = details(v, role);
  const manage = link("Manage booking", v.manage_url);
  const meet = link("Join meeting", v.meeting_url);
  const compose = (
    title: string, intro: string,
    opts: { ics?: "REQUEST" | "CANCEL"; extraHtml?: string; extraText?: string; links?: boolean; series?: boolean } = {},
  ): RenderedEmail => {
    const links = opts.links !== false;
    const ser = opts.series === false ? { html: "", text: "" } : seriesBlock(ctx, role);
    const html = layout(title, `<p>${escapeHtml(intro)}</p>${d.html}${ser.html}${opts.extraHtml ?? ""}${links ? meet.html + manage.html : ""}`);
    const text = [title, "", intro, "", d.text, ser.text, opts.extraText ?? "", links ? meet.text : "", links ? manage.text : ""].filter((x) => x !== "").join("\n");
    return { subject: title.replace(/[\r\n]+/g, " ").slice(0, 200), html, text, attachments: opts.ics ? icsFor(ctx, opts.ics, v) : undefined };
  };
  const who = role === "host" ? v.invitee_name : v.host_name;

  switch (kind) {
    case "confirmation":
      return compose(`Confirmed: ${v.event_title} with ${who}`, `Hi ${v.invitee_name}, your booking is confirmed.`, { ics: "REQUEST" });
    case "host_notification":
      return compose(`New booking: ${v.event_title} with ${v.invitee_name}`, `${v.invitee_name} booked ${v.event_title} with you.`, { ics: "REQUEST", links: false });
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
    case "reschedule": {
      const prev = v.previous_start_time ? `Previously: ${v.previous_start_time}` : "";
      return compose(`Rescheduled: ${v.event_title} with ${who}`, "The booking has been moved to a new time.", { series: false,
        ics: "REQUEST", extraHtml: prev ? `<p style="color:#6b7280">${escapeHtml(prev)}</p>` : "", extraText: prev,
      });
    }
    case "reminder": {
      const m = extra.minutesBefore ?? 0;
      const when = m >= 1440 && m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}`
        : m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`;
      return compose(`Reminder: ${v.event_title} with ${who} in ${when}`, "This is a reminder about your upcoming meeting.", { series: false });
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
      return {
        subject,
        html: layout(subject, `<div>${renderString(body, v, true)}</div>`),
        text: renderString(body, v),
      };
    }
  }
}
