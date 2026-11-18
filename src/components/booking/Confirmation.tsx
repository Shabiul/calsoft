"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CalendarPlus, Download, Link2 } from "lucide-react";
import type { PublicEvent } from "@/server/public/data";
import { googleCalendarUrl, outlookCalendarUrl } from "@/server/public/ics";
import { formatDateLong, formatRange, isHttpUrl, LOCATION_LABELS } from "./format";

export type Booked = {
  startsAt: string; endsAt: string; status: string; meetingUrl: string | null; manageToken: string | null;
  /** Recurring series: every booked session (first === startsAt above). */
  series?: { id: string; startsAt: string; endsAt: string; status: string }[];
};

export function Confirmation({
  event, booked, tz, hour12, embed, title = "You are scheduled",
}: { event: PublicEvent; booked: Booked; tz: string; hour12: boolean; embed?: boolean; title?: string }) {
  const [left, setLeft] = useState<number | null>(isHttpUrl(event.redirectUrl) ? 4 : null);
  const awaitingApproval = booked.status === "pending_confirmation";
  const pending = booked.status === "pending_payment" || awaitingApproval;
  const series = booked.series && booked.series.length > 1 ? booked.series : null;

  // Success redirect (host-configured URL). In embeds the parent widget performs it.
  useEffect(() => {
    if (!isHttpUrl(event.redirectUrl)) return;
    const t = setInterval(() => setLeft((n) => (n === null ? n : Math.max(0, n - 1))), 1000);
    return () => clearInterval(t);
  }, [event.redirectUrl]);
  useEffect(() => {
    if (left !== 0 || !event.redirectUrl) return;
    if (embed && window.parent !== window) window.parent.postMessage({ source: "meetflow", type: "redirect", url: event.redirectUrl }, "*");
    else window.location.assign(event.redirectUrl);
  }, [left, event.redirectUrl, embed]);

  const where = booked.meetingUrl ? "Online meeting" : event.locationAddress || LOCATION_LABELS[event.locationType] || "";
  const link = { title: `${event.title} with ${event.host.name}`, description: event.description, location: booked.meetingUrl ?? event.locationAddress ?? undefined, startsAt: booked.startsAt, endsAt: booked.endsAt };

  return (
    <div className="mf-fade" style={{ display: "grid", gap: 18, maxWidth: 560, margin: "0 auto", textAlign: "center", justifyItems: "center" }}>
      <CheckCircle2 size={52} style={{ color: "var(--mf-ok)" }} aria-hidden />
      <div>
        <h2 style={{ margin: 0, fontSize: 24 }}>{awaitingApproval ? "Request sent, awaiting approval" : pending ? "Booking reserved" : title}</h2>
        <p className="mf-muted" style={{ margin: "6px 0 0" }}>
          {event.successMessage
            ? event.successMessage
            : pending
              ? awaitingApproval ? `${event.host.name} needs to approve ${series ? "this series" : "this meeting"}. The time is held for you and you will get an email once it is approved or declined.` : "Your booking is reserved."
              : "A calendar invitation and confirmation email are on their way."}
        </p>
      </div>
      <div className="mf-card" style={{ padding: 18, textAlign: "left", width: "100%", boxShadow: "none" }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{event.title}</div>
        <div className="mf-muted" style={{ marginTop: 4 }}>with {event.host.name}</div>
        <hr className="mf-divider" style={{ margin: "12px 0", borderWidth: "1px 0 0" }} />
        <div style={{ fontWeight: 600 }}>{formatDateLong(booked.startsAt, tz)}</div>
        <div>{formatRange(booked.startsAt, booked.endsAt, tz, hour12)} <span className="mf-muted">({tz.replace(/_/g, " ")})</span></div>
        {where && <div className="mf-muted" style={{ marginTop: 6 }}>{where}</div>}
        {series && (
          <div data-testid="series-confirmation" style={{ marginTop: 12 }}>
            <div className="mf-muted" style={{ fontSize: 13, marginBottom: 4 }}>All {series.length} sessions:</div>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
              {series.map((o) => <li key={o.id}>{formatDateLong(o.startsAt, tz)}, {formatRange(o.startsAt, o.endsAt, tz, hour12)}</li>)}
            </ol>
          </div>
        )}
        {isHttpUrl(booked.meetingUrl) && (
          <a href={booked.meetingUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--mf-brand)", wordBreak: "break-all" }}>{booked.meetingUrl}</a>
        )}
      </div>
      {!pending && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
          <a className="mf-btn mf-btn-ghost" href={googleCalendarUrl(link)} target="_blank" rel="noopener noreferrer"><CalendarPlus size={16} aria-hidden /> Google Calendar</a>
          <a className="mf-btn mf-btn-ghost" href={outlookCalendarUrl(link)} target="_blank" rel="noopener noreferrer"><CalendarPlus size={16} aria-hidden /> Outlook</a>
          {booked.manageToken && <a className="mf-btn mf-btn-ghost" href={`/api/public/ics/${booked.manageToken}`}><Download size={16} aria-hidden /> Download .ics</a>}
        </div>
      )}
      {booked.manageToken && (
        <a href={`/booking/${booked.manageToken}`} target={embed ? "_blank" : undefined} rel={embed ? "noopener noreferrer" : undefined} style={{ color: "var(--mf-brand)", fontWeight: 600, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <Link2 size={15} aria-hidden /> Reschedule or cancel
        </a>
      )}
      {left !== null && left > 0 && event.redirectUrl && <p className="mf-muted" style={{ margin: 0, fontSize: 13 }} role="status">Redirecting you in {left}s...</p>}
    </div>
  );
}
