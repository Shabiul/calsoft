"use client";

import { DateTime } from "luxon";
import { ChevronLeft, ChevronRight } from "lucide-react";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Props = {
  /** First day of the displayed month, in the invitee's zone. */
  month: DateTime;
  tz: string;
  /** yyyy-MM-dd keys that have at least one bookable slot. */
  available: Set<string>;
  selected: string | null;
  loading: boolean;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (key: string) => void;
};

export function Calendar({ month, tz, available, selected, loading, canPrev, canNext, onPrev, onNext, onSelect }: Props) {
  const today = DateTime.now().setZone(tz).toFormat("yyyy-MM-dd");
  const lead = month.weekday % 7; // Luxon: Mon=1..Sun=7 -> Sunday-first offset
  const days = month.daysInMonth ?? 30;
  const cells: (DateTime | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => month.plus({ days: i })),
  ];

  return (
    <div aria-busy={loading}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }} aria-live="polite">{month.toFormat("LLLL yyyy")}</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="mf-btn mf-btn-ghost" style={{ width: 36, height: 36, padding: 0 }} onClick={onPrev} disabled={!canPrev} aria-label="Previous month"><ChevronLeft size={18} /></button>
          <button type="button" className="mf-btn mf-btn-ghost" style={{ width: 36, height: 36, padding: 0 }} onClick={onNext} disabled={!canNext} aria-label="Next month"><ChevronRight size={18} /></button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, rowGap: 6 }}>
        {WEEKDAYS.map((d) => (
          <div key={d} className="mf-muted" style={{ textAlign: "center", fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", paddingBottom: 4 }}>{d}</div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={`b${i}`} />;
          const key = c.toFormat("yyyy-MM-dd");
          const isAvail = available.has(key);
          return (
            <button
              key={key} type="button" className="mf-day"
              data-avail={isAvail} data-today={key === today}
              aria-pressed={selected === key}
              aria-label={`${c.toFormat("cccc, LLLL d")}${isAvail ? ", times available" : ", unavailable"}`}
              disabled={!isAvail}
              onClick={() => onSelect(key)}
            >
              {c.day}
            </button>
          );
        })}
      </div>
      {loading && <div className="mf-skel" style={{ height: 6, marginTop: 14 }} aria-hidden />}
    </div>
  );
}
