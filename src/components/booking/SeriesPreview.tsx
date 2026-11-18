"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Repeat } from "lucide-react";
import { formatDateLong, formatRange } from "./format";

type Item = { startsAt: string; endsAt: string; available: boolean };
type Preview = { recurrence: { count: number; interval: "week" | "month" } | null; timeZone?: string; occurrences: Item[] };

/**
 * "N weekly sessions" summary with every computed date, shown before submit. Dates come from the server
 * (same engine as createBooking: host time zone, calendar arithmetic across DST) and are rendered in the invitee's zone.
 */
export function SeriesPreview({
  eventTypeId, startsAt, tz, hour12, count, interval, onAvailability,
}: { eventTypeId: string; startsAt: string; tz: string; hour12: boolean; count: number; interval: "week" | "month"; onAvailability?: (allAvailable: boolean) => void }) {
  const [data, setData] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setData(null); setFailed(false);
    fetch(`/api/public/series?${new URLSearchParams({ eventTypeId, startsAt })}`, { signal: ac.signal, cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error("bad"); const p = (await r.json()) as Preview; setData(p); onAvailability?.(p.occurrences.every((o) => o.available)); })
      .catch((e) => { if ((e as Error).name !== "AbortError") setFailed(true); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventTypeId, startsAt]);

  const label = `${count} ${interval === "week" ? "weekly" : "monthly"} sessions`;
  const blocked = data?.occurrences.find((o) => !o.available);
  return (
    <section className="mf-card" style={{ padding: 14, boxShadow: "none", display: "grid", gap: 8 }} aria-label="Series dates" data-testid="series-preview">
      <div style={{ fontWeight: 700, display: "flex", gap: 8, alignItems: "center" }}><Repeat size={16} aria-hidden /> {label}</div>
      {failed && <div className="mf-muted" style={{ fontSize: 13 }}>Could not load the dates. They are checked again when you book.</div>}
      {!data && !failed && <div className="mf-muted" style={{ fontSize: 13 }}>Calculating dates...</div>}
      {data && (
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, display: "grid", gap: 2 }}>
          {data.occurrences.map((o) => (
            <li key={o.startsAt} style={o.available ? undefined : { color: "var(--mf-err, #b91c1c)" }}>
              {formatDateLong(o.startsAt, tz)}, {formatRange(o.startsAt, o.endsAt, tz, hour12)}{o.available ? "" : " (not available)"}
            </li>
          ))}
        </ol>
      )}
      {blocked && (
        <div className="mf-alert mf-alert-err" role="alert" style={{ fontSize: 13 }}>
          <AlertTriangle size={14} aria-hidden /> The session on {formatDateLong(blocked.startsAt, tz)} is not available, so this series cannot be booked from this start time. Pick another time.
        </div>
      )}
      <div className="mf-muted" style={{ fontSize: 12 }}>All sessions are booked together: if one is unavailable, none are.</div>
    </section>
  );
}
