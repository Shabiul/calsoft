"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { Check, ChevronDown, Globe, Search } from "lucide-react";
import { allTimeZones, tzOffsetLabel } from "./format";
import { useHydrated } from "./client-env";
import { zoneCountry } from "./tz-countries";

/** Old IANA names some browsers still report, shown under their current city name. */
const RENAMED: Record<string, string> = {
  Calcutta: "Kolkata", Saigon: "Ho Chi Minh", Kiev: "Kyiv", Rangoon: "Yangon", Katmandu: "Kathmandu", Godthab: "Nuuk",
  Asmera: "Asmara", Faeroe: "Faroe", Ponape: "Pohnpei", Truk: "Chuuk", Enderbury: "Kanton", "Coral Harbour": "Atikokan",
};
/** Everyday names people search for that differ from the official country name. */
const NICKNAMES: Record<string, string> = { GB: "uk britain england scotland wales", US: "usa america", AE: "uae emirates", NL: "holland", CZ: "czech republic", KR: "korea", KP: "korea" };

let regionNames: Intl.DisplayNames | null | undefined;
function countryName(code: string): string {
  if (!code) return "";
  if (regionNames === undefined) { try { regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch { regionNames = null; } }
  return regionNames?.of(code) ?? code;
}

type Zone = { id: string; city: string; place: string; name: string; offset: string; minutes: number; hay: string };

export function describeZone(id: string): Zone {
  const parts = id.split("/");
  const last = parts[parts.length - 1]!.replace(/_/g, " ");
  const city = RENAMED[last] ?? last;
  const code = zoneCountry(id);
  const country = countryName(code);
  const place = country || (parts.length > 1 ? parts[0]!.replace(/_/g, " ") : ""); // "Germany", else "Etc"/region
  let name = "";
  try { name = new Intl.DateTimeFormat("en-US", { timeZone: id, timeZoneName: "longGeneric" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? ""; } catch { /* ignore */ }
  const dt = DateTime.now().setZone(id);
  const hay = [id, last, city, place, parts[0], name, code, NICKNAMES[code] ?? ""].join(" ").toLowerCase().replace(/_/g, " ");
  return { id, city, place, name, offset: tzOffsetLabel(id), minutes: dt.isValid ? dt.offset : 0, hay };
}

export function TimezoneSelect({ value, onChange, hour12 = true }: { value: string; onChange: (tz: string) => void; hour12?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const hydrated = useHydrated();
  const current = useMemo(() => describeZone(value), [value]);
  const zones = useMemo(() => (open ? allTimeZones().map(describeZone).sort((a, b) => a.minutes - b.minutes || a.city.localeCompare(b.city)) : []), [open]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true }); // autoFocus would scroll the card
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const list = useMemo(() => {
    // No search: the selected zone first, then everything by UTC offset.
    const hits = needle ? zones.filter((z) => z.hay.includes(needle)) : [current, ...zones.filter((z) => z.id !== value)];
    return hits; // ~420 rows; no cap, or zones past the cap could never be reached by scrolling
  }, [zones, needle, current, value]);

  // Rendered only in the browser: server and browser format "am/pm" differently, and the time would be stale anyway.
  const now = hydrated ? DateTime.now().setZone(value) : null;
  const clock = now?.isValid ? now.toFormat(hour12 ? "h:mm a" : "HH:mm") : "";
  const pick = (id: string) => { onChange(id); setOpen(false); setQ(""); };

  return (
    <div ref={ref} style={{ position: "relative", minWidth: 0, maxWidth: "100%" }}>
      <button type="button" className="mf-chip" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`Time zone: ${current.name || current.city}. Change`}
        style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 40, maxWidth: "100%", paddingInline: 12 }}>
        <Globe size={16} aria-hidden style={{ flexShrink: 0 }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{current.name || current.city}</span>
        <span className="mf-muted" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{current.offset}{clock ? ` · ${clock}` : ""}</span>
        <ChevronDown size={15} aria-hidden style={{ flexShrink: 0, opacity: 0.6, transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s" }} />
      </button>
      {open && (
        // Opens upward: the picker sits at the bottom of the card, which clips anything below it.
        <div className="mf-card mf-fade" style={{ position: "absolute", zIndex: 30, bottom: 48, left: 0, width: "min(380px, calc(100vw - 80px))" /* stays inside the card on phones */, padding: 8 }}>
          <div style={{ position: "relative", marginBottom: 6 }}>
            <Search size={15} aria-hidden style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", opacity: 0.6 }} />
            <input ref={input} className="mf-input" style={{ paddingLeft: 32 }} placeholder="Search city, country or zone" value={q}
              onChange={(e) => setQ(e.target.value)} aria-label="Search time zones"
              onKeyDown={(e) => { if (e.key === "Enter" && list[0]) { e.preventDefault(); pick(list[0].id); } }} />
          </div>
          <ul role="listbox" aria-label="Time zones" className="mf-scroll" style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 300, overflowY: "auto" }}>
            {list.length === 0 && <li className="mf-muted" style={{ padding: 12, fontSize: 13 }}>No matching time zones</li>}
            {list.map((z) => {
              const sel = z.id === value;
              return (
                <li key={z.id} role="option" aria-selected={sel}>
                  <button type="button" onClick={() => pick(z.id)}
                    style={{ width: "100%", textAlign: "left", background: sel ? "var(--mf-surface-2)" : "transparent", color: "inherit", border: 0, borderRadius: 8, padding: "8px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontSize: 14, fontWeight: sel ? 600 : 500 }}>{z.city}{z.place ? <span className="mf-muted" style={{ fontWeight: 400 }}> · {z.place}</span> : null}</span>
                      {z.name && <span className="mf-muted" style={{ display: "block", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{z.name}</span>}
                    </span>
                    <span className="mf-muted" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{z.offset}</span>
                    <Check size={15} aria-hidden style={{ flexShrink: 0, color: "var(--mf-brand)", visibility: sel ? "visible" : "hidden" }} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
