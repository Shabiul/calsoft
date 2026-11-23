"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

const POLL_MS = 2000;
const MAX_WAIT_MS = 60_000;

/** Shown right after booking until the Google Meet link exists, so the confirmation page and emails are complete. */
export function PreparingMeeting({ manageToken, onReady }: { manageToken: string; onReady: (meetingUrl: string | null, calendarMeetingUrl: string | null) => void }) {
  const [seconds, setSeconds] = useState(0);
  const done = useRef(false);
  const onReadyRef = useRef(onReady);
  useEffect(() => { onReadyRef.current = onReady; });

  useEffect(() => {
    let live = true;
    const started = Date.now();
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    const finish = (url: string | null, calUrl: string | null = null) => { if (live && !done.current) { done.current = true; onReadyRef.current(url, calUrl); } };
    (async () => {
      while (live && Date.now() - started < MAX_WAIT_MS) {
        try {
          const r = await fetch(`/api/public/manage/${encodeURIComponent(manageToken)}`, { cache: "no-store" });
          if (r.ok) {
            const j = (await r.json()) as { booking?: { meetingUrl?: string | null; calendarMeetingUrl?: string | null } };
            if (j.booking?.meetingUrl) return finish(j.booking.meetingUrl, j.booking.calendarMeetingUrl ?? null);
          }
        } catch { /* keep trying */ }
        await new Promise((res) => setTimeout(res, POLL_MS));
      }
      finish(null); // give up waiting; the link is still added to the email and calendar invite when ready
    })();
    return () => { live = false; clearInterval(tick); };
  }, [manageToken]);

  const steps = [
    { label: "Time reserved", state: "done" as const },
    { label: "Creating your Google Meet link", state: "active" as const },
    { label: "Sending invitations to everyone", state: "wait" as const },
  ];
  return (
    <div role="status" aria-live="polite" style={{ maxWidth: 480, margin: "48px auto", textAlign: "center", display: "grid", gap: 20 }}>
      <Loader2 size={40} className="animate-spin" aria-hidden style={{ margin: "0 auto", color: "var(--mf-brand)" }} />
      <div>
        <h2 style={{ margin: 0, fontSize: 22 }}>Setting up your meeting</h2>
        <p className="mf-muted" style={{ margin: "8px 0 0" }}>Please keep this page open. This usually takes a few seconds.</p>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10, textAlign: "left", justifySelf: "center" }}>
        {steps.map((s) => (
          <li key={s.label} style={{ display: "flex", alignItems: "center", gap: 10, opacity: s.state === "wait" ? 0.5 : 1 }}>
            {s.state === "done" ? <Check size={18} aria-hidden style={{ color: "#16a34a" }} />
              : s.state === "active" ? <Loader2 size={18} className="animate-spin" aria-hidden style={{ color: "var(--mf-brand)" }} />
              : <span aria-hidden style={{ width: 18, height: 18, borderRadius: 999, border: "2px solid currentColor", opacity: 0.4, display: "inline-block" }} />}
            <span>{s.label}</span>
          </li>
        ))}
      </ul>
      {seconds >= 20 && <p className="mf-muted" style={{ fontSize: 13 }}>Still working... your booking is confirmed and the link will arrive by email too.</p>}
    </div>
  );
}
