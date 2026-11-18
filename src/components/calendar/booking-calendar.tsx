"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Calendar, type EventInput } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import { ExternalLink, Video } from "lucide-react";
import { DateTime } from "luxon";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface ApiEvent {
  id: string; title: string; start: string; end: string; status: string; eventTypeId: string; color: string | null;
  inviteeName: string | null; inviteeEmail: string | null; meetingUrl: string | null;
}
export interface CalendarEventType { id: string; title: string; color: string | null }

const STATUS_STYLE: Record<string, { label: string; variant: "success" | "warning" | "destructive" | "secondary" | "default" }> = {
  confirmed: { label: "Confirmed", variant: "success" },
  pending_payment: { label: "Pending payment", variant: "warning" },
  pending_confirmation: { label: "Needs approval", variant: "warning" },
  completed: { label: "Completed", variant: "secondary" },
  cancelled: { label: "Cancelled", variant: "destructive" },
  no_show: { label: "No-show", variant: "warning" },
  rescheduled: { label: "Rescheduled", variant: "secondary" },
  expired: { label: "Expired", variant: "secondary" },
};

/**
 * FullCalendar (v6 core API) with day / week / month / agenda views.
 * Events come from /api/calendar/events (real bookings). Times render in the browser's local time zone
 * (named zones would need the @fullcalendar/luxon3 plugin).
 */
export function BookingCalendar({ eventTypes }: { eventTypes: CalendarEventType[] }) {
  const host = useRef<HTMLDivElement>(null);
  const calRef = useRef<Calendar | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [showCancelled, setShowCancelled] = useState(false);
  const filterRef = useRef({ typeFilter, showCancelled });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ApiEvent | null>(null);
  const cache = useRef(new Map<string, ApiEvent>());

  useEffect(() => { filterRef.current = { typeFilter, showCancelled }; calRef.current?.refetchEvents(); }, [typeFilter, showCancelled]);

  const load = useCallback(async (from: Date, to: Date): Promise<EventInput[]> => {
    const res = await fetch(`/api/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`);
    if (!res.ok) throw new Error("Could not load events");
    const { events } = (await res.json()) as { events: ApiEvent[] };
    const { typeFilter: tf, showCancelled: sc } = filterRef.current;
    return events
      .filter((e) => (tf === "all" || e.eventTypeId === tf) && (sc || !["cancelled", "rescheduled", "expired"].includes(e.status)))
      .map((e) => {
        cache.current.set(e.id, e);
        const dim = ["cancelled", "no_show", "expired", "rescheduled"].includes(e.status);
        return {
          id: e.id, start: e.start, end: e.end,
          title: `${e.inviteeName ?? "Booking"} · ${e.title}`,
          backgroundColor: e.color ?? "var(--brand)", borderColor: "transparent",
          classNames: dim ? ["opacity-50", "line-through"] : [],
        };
      });
  }, []);

  useEffect(() => {
    if (!host.current) return;
    const cal = new Calendar(host.current, {
      plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
      initialView: typeof window !== "undefined" && window.innerWidth < 640 ? "listWeek" : "timeGridWeek",
      height: "auto",
      nowIndicator: true,
      navLinks: true,
      slotMinTime: "06:00:00",
      slotMaxTime: "22:00:00",
      scrollTime: "08:00:00",
      headerToolbar: { left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth,listMonth" },
      buttonText: { today: "Today", day: "Day", week: "Week", month: "Month", list: "Agenda" },
      views: { listMonth: { buttonText: "Agenda" } },
      events: (info, ok, fail) => { load(info.start, info.end).then(ok).catch((e: Error) => { setError(e.message); fail(e); }); },
      eventClick: (arg) => { const ev = cache.current.get(arg.event.id); if (ev) setSelected(ev); },
      eventDidMount: () => setError(null),
    });
    cal.render();
    calRef.current = cal;
    return () => { cal.destroy(); calRef.current = null; };
  }, [load]);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmt = (iso: string) => DateTime.fromISO(iso).toFormat("ccc, LLL d · h:mm a");

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="w-52">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger aria-label="Filter by event type"><SelectValue placeholder="All event types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All event types</SelectItem>
              {eventTypes.map((t) => <SelectItem key={t.id} value={t.id}>{t.title}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled
        </label>
        {error && <span role="alert" className="text-sm text-destructive">{error}</span>}
      </div>
      <div ref={host} className="mf-calendar" />
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent>
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>{selected.title}</DialogTitle>
                <DialogDescription>{fmt(selected.start)} – {DateTime.fromISO(selected.end).toFormat("h:mm a")} ({tz})</DialogDescription>
              </DialogHeader>
              <div className="grid gap-2 text-sm">
                <div className="flex items-center gap-2"><Badge variant={STATUS_STYLE[selected.status]?.variant ?? "secondary"}>{STATUS_STYLE[selected.status]?.label ?? selected.status}</Badge></div>
                {selected.inviteeName && <div><span className="text-muted-foreground">Invitee: </span>{selected.inviteeName}{selected.inviteeEmail ? ` (${selected.inviteeEmail})` : ""}</div>}
                {selected.meetingUrl && (
                  <Button asChild variant="outline" size="sm" className="w-fit"><a href={selected.meetingUrl} target="_blank" rel="noreferrer"><Video />Join meeting</a></Button>
                )}
                <Button asChild variant="ghost" size="sm" className="w-fit"><a href="/dashboard/scheduled-events"><ExternalLink />All scheduled events</a></Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
