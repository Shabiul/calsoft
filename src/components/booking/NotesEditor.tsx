"use client";
import { useEffect, useRef, useState } from "react";

type Status = "saved" | "dirty" | "saving" | "conflict" | "error";

/** Shared notes textarea with autosave (1s after typing stops). Last save wins unless someone saved in between (then 409). */
export function NotesEditor({ token, initial, initialUpdatedAt }: { token: string; initial: string; initialUpdatedAt: string | null }) {
  const [text, setText] = useState(initial);
  const [status, setStatus] = useState<Status>("saved");
  const base = useRef(initialUpdatedAt);
  const [latest, setLatest] = useState<{ content: string; updatedAt: string } | null>(null);

  useEffect(() => {
    if (status !== "dirty") return;
    const t = setTimeout(async () => {
      setStatus("saving");
      try {
        const r = await fetch(`/api/public/notes/${encodeURIComponent(token)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text, baseUpdatedAt: base.current }),
        });
        const j = await r.json().catch(() => null);
        if (r.ok) { base.current = j.updatedAt; setStatus((s) => (s === "saving" ? "saved" : s)); }
        else if (r.status === 409) { setLatest(j?.error?.details ?? null); setStatus("conflict"); }
        else setStatus("error");
      } catch { setStatus("error"); }
    }, 1000);
    return () => clearTimeout(t);
  }, [text, status, token]);

  const label = { saved: "All changes saved", dirty: "Unsaved changes", saving: "Saving...", conflict: "", error: "Could not save. Keep this page open and try again." }[status];
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {status === "conflict" && latest && (
        <div className="mf-alert mf-alert-err" role="alert">
          Someone else edited these notes.{" "}
          <button type="button" className="mf-btn mf-btn-ghost" onClick={() => {
            setText(latest.content); base.current = latest.updatedAt; setStatus("saved");
          }}>Load their version</button>{" "}
          <button type="button" className="mf-btn mf-btn-ghost" onClick={() => { base.current = latest.updatedAt; setStatus("dirty"); }}>Keep mine</button>
        </div>
      )}
      <textarea
        className="mf-input" aria-label="Meeting notes" value={text} rows={14} maxLength={100_000}
        placeholder="Agenda, talking points, decisions... Everyone with this link can read and edit."
        onChange={(e) => { setText(e.target.value); if (status !== "conflict") setStatus("dirty"); }}
        style={{ width: "100%", minHeight: 260, resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }}
      />
      <p className="mf-muted" aria-live="polite" style={{ margin: 0, fontSize: 13 }}>{label}</p>
    </div>
  );
}
