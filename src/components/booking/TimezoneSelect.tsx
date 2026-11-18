"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { Globe, Search } from "lucide-react";
import { allTimeZones, tzOffsetLabel } from "./format";

export function TimezoneSelect({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const zones = useMemo(() => (open ? allTimeZones() : []), [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const needle = q.trim().toLowerCase().replace(/ /g, "_");
  const list = useMemo(() => (needle ? zones.filter((z) => z.toLowerCase().includes(needle)) : zones).slice(0, 80), [zones, needle]);
  const now = DateTime.now().setZone(value);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="mf-chip" style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 38, maxWidth: "100%" }}
        onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={`Time zone: ${value}. Change`}>
        <Globe size={15} aria-hidden />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value.replace(/_/g, " ")}</span>
        <span className="mf-muted" style={{ fontSize: 12 }}>{now.isValid ? now.toFormat("t") : ""}</span>
      </button>
      {open && (
        <div className="mf-card mf-fade" style={{ position: "absolute", zIndex: 30, top: 44, left: 0, width: "min(340px, 86vw)", padding: 10 }}>
          <div style={{ position: "relative", marginBottom: 8 }}>
            <Search size={15} aria-hidden style={{ position: "absolute", left: 11, top: 13, opacity: .6 }} />
            <input autoFocus className="mf-input" style={{ paddingLeft: 32 }} placeholder="Search time zone (e.g. Kolkata)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search time zones" />
          </div>
          <ul role="listbox" className="mf-scroll" style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 260, overflowY: "auto" }}>
            {list.length === 0 && <li className="mf-muted" style={{ padding: 10, fontSize: 13 }}>No matching time zones</li>}
            {list.map((z) => (
              <li key={z} role="option" aria-selected={z === value}>
                <button type="button" onClick={() => { onChange(z); setOpen(false); setQ(""); }}
                  style={{ width: "100%", textAlign: "left", background: z === value ? "var(--mf-surface-2)" : "transparent", color: "inherit", border: 0, borderRadius: 8, padding: "8px 10px", cursor: "pointer", fontSize: 13.5, display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>{z.replace(/_/g, " ")}</span><span className="mf-muted">{tzOffsetLabel(z)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
