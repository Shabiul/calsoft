"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Calendar as CalIcon, Clock, Download, MapPin, XCircle, History } from "lucide-react";
import type { BookingView } from "@/server/public/data";
import { BookingFlow } from "./BookingFlow";
import { hour12Store, useBrowserEnv } from "./client-env";
import { formatDateLong, formatDuration, formatRange, isHttpUrl, LOCATION_LABELS } from "./format";

const STATUS: Record<string, { label: string; tone: "ok" | "err" | "info" }> = {
  confirmed: { label: "Confirmed", tone: "ok" },
  pending_payment: { label: "Awaiting payment", tone: "info" },
  pending_confirmation: { label: "Awaiting approval", tone: "info" },
  cancelled: { label: "Cancelled", tone: "err" },
  rescheduled: { label: "Rescheduled", tone: "info" },
  completed: { label: "Completed", tone: "info" },
  no_show: { label: "Missed", tone: "info" },
  expired: { label: "Expired", tone: "err" },
};

export function ManageClient({ view, token }: { view: BookingView; token: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"occurrence" | "series">("occurrence");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tz = view.inviteeTimeZone;
  const env = useBrowserEnv();
  const stored = hour12Store.use();
  const hour12 = stored === "1" ? true : stored === "0" ? false : env.hour12;
  const st = STATUS[view.status] ?? { label: view.status, tone: "info" as const };
  const e = view.event;

  async function doCancel() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/public/manage/${encodeURIComponent(token)}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.trim() || undefined, scope }),
      });
      const data = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!r.ok) { setErr(data?.error?.message ?? "Could not cancel this booking."); return; }
      setMode("view");
      router.refresh();
    } catch { setErr("Network error. Please try again."); } finally { setBusy(false); }
  }

  if (mode === "reschedule") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <button type="button" className="mf-btn mf-btn-ghost" style={{ justifySelf: "start" }} onClick={() => setMode("view")}>Back to booking</button>
        <BookingFlow event={e} rescheduleToken={token} currentStartsAt={view.startsAt} prefill={{ name: view.invitee?.name, email: view.invitee?.email }} />
      </div>
    );
  }

  const active = view.status === "confirmed" || view.status === "pending_payment" || view.status === "pending_confirmation";
  const series = view.series && view.series.occurrences.length > 1 ? view.series : null;
  return (
    <div className="mf-card mf-fade" style={{ padding: "clamp(18px, 4vw, 32px)", display: "grid", gap: 18 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>{e.title}</h1>
        <span className={`mf-alert mf-alert-${st.tone}`} style={{ padding: "4px 12px", borderRadius: 999, fontWeight: 600, fontSize: 13 }}>{st.label}</span>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}><CalIcon size={16} aria-hidden /> <span style={{ fontWeight: 600 }}>{formatDateLong(view.startsAt, tz)}</span></div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}><Clock size={16} aria-hidden /> {formatRange(view.startsAt, view.endsAt, tz, hour12)} <span className="mf-muted">({tz.replace(/_/g, " ")}, {formatDuration(e.durationMinutes)})</span></div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}><MapPin size={16} aria-hidden />
          {isHttpUrl(view.meetingUrl)
            ? <a href={view.meetingUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--mf-brand)", wordBreak: "break-all" }}>{view.meetingUrl}</a>
            : <span>{e.locationAddress || LOCATION_LABELS[view.locationType ?? e.locationType] || "Online"}</span>}
        </div>
        <div className="mf-muted">Hosted by {e.host.name}{view.invitee ? ` · Booked by ${view.invitee.name}` : ""}</div>
      </div>

      {view.status === "pending_confirmation" && (
        <div className="mf-alert mf-alert-info" role="status">
          <strong>Request sent, awaiting approval.</strong> {e.host.name} needs to approve {series ? "this series" : "this meeting"}. The time is held for you and you will get an email as soon as it is approved or declined.
        </div>
      )}
      {series && (
        <section aria-label="Series" data-testid="series-list">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Recurring series: {series.occurrences.length} sessions</h2>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
            {series.occurrences.map((o) => (
              <li key={o.startsAt} style={o.current ? { fontWeight: 700 } : undefined}>
                {formatDateLong(o.startsAt, tz)}, {formatRange(o.startsAt, o.endsAt, tz, hour12)}
                {o.status !== "confirmed" && o.status !== "pending_confirmation" ? <span className="mf-muted"> ({(STATUS[o.status]?.label ?? o.status).toLowerCase()})</span> : null}
                {o.current ? <span className="mf-muted"> (this session)</span> : null}
              </li>
            ))}
          </ol>
        </section>
      )}
      {view.status === "cancelled" && (
        <div className="mf-alert mf-alert-err">
          This meeting was cancelled{view.cancelledBy ? ` by the ${view.cancelledBy === "invitee" ? "invitee" : "host"}` : ""}.
          {view.cancelReason ? <> Reason: <em style={{ overflowWrap: "anywhere" }}>{view.cancelReason}</em></> : null}
        </div>
      )}
      {view.status === "rescheduled" && <div className="mf-alert mf-alert-info">This booking was moved to a new time. Use the link in your latest confirmation email to see the current meeting.</div>}
      {view.blockedReason && active && <div className="mf-alert mf-alert-info" role="status">{view.blockedReason}</div>}
      {e.cancellationPolicy && active && (
        <details><summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 14 }}>Cancellation policy</summary><p className="mf-muted" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{e.cancellationPolicy}</p></details>
      )}

      {mode === "cancel" ? (
        <div className="mf-fade" style={{ display: "grid", gap: 12, maxWidth: 520 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>{scope === "series" ? "Cancel every remaining session of this series?" : series ? "Cancel only this session?" : "Cancel this meeting?"}</p>
          <label className="mf-label" htmlFor="mf-reason">Reason for cancelling (optional)</label>
          <textarea id="mf-reason" className="mf-input" value={reason} maxLength={500} onChange={(ev) => setReason(ev.target.value)} placeholder="Let the host know why" />
          {err && <div className="mf-alert mf-alert-err" role="alert">{err}</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="mf-btn mf-btn-danger" onClick={doCancel} disabled={busy}>{busy ? "Cancelling..." : scope === "series" ? "Yes, cancel the series" : "Yes, cancel meeting"}</button>
            <button type="button" className="mf-btn mf-btn-ghost" onClick={() => { setMode("view"); setErr(null); }} disabled={busy}>Keep meeting</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {view.canReschedule && <button type="button" className="mf-btn" onClick={() => setMode("reschedule")}>Reschedule</button>}
          {view.canCancel && <button type="button" className="mf-btn mf-btn-ghost" onClick={() => { setScope("occurrence"); setMode("cancel"); }}><XCircle size={16} aria-hidden /> {series ? "Cancel this session" : "Cancel meeting"}</button>}
          {series && view.canCancelSeries && <button type="button" className="mf-btn mf-btn-ghost" onClick={() => { setScope("series"); setMode("cancel"); }}><XCircle size={16} aria-hidden /> Cancel entire series</button>}
          {view.status !== "pending_confirmation" && active && <a className="mf-btn mf-btn-ghost" href={`/api/public/ics/${encodeURIComponent(token)}`}><Download size={16} aria-hidden /> Add to calendar (.ics)</a>}
          <a className="mf-btn mf-btn-ghost" href={e.shortCode ? `/m/${e.shortCode}` : `/${e.host.username}/${e.slug}`}>Book another time</a>
        </div>
      )}

      {view.history.length > 0 && (
        <section aria-label="Booking history">
          <h2 style={{ fontSize: 14, margin: "0 0 8px", display: "flex", gap: 6, alignItems: "center" }}><History size={15} aria-hidden /> History</h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }} className="mf-muted">
            {view.history.map((h) => (
              <li key={h.id}>Previously {formatDateLong(h.startsAt, tz)}, {formatRange(h.startsAt, h.endsAt, tz, hour12)} ({h.status.replace("_", " ")})</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
