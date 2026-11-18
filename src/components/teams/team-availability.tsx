import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DateTime } from "luxon";
import { Avatar, Badge, Card, EmptyState } from "@/components/ui";

export type AvailabilityMember = { userId: string; name: string; image: string | null; freeNow: boolean; freeMinutes: number; free: { start: string; end: string }[] };

const fmtH = (m: number) => `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;

/** Day view: one timeline bar per member; filled segments are free time (working hours minus bookings/blocks). */
export function TeamAvailability({ orgId, date, timeZone, fromMs, toMs, isToday, members }: {
  orgId: string; date: string; timeZone: string; fromMs: number; toMs: number; isToday: boolean; members: AvailabilityMember[];
}) {
  const d = DateTime.fromISO(date, { zone: timeZone });
  const href = (x: string) => `/dashboard/teams/${orgId}?tab=availability&date=${x}`;
  const span = toMs - fromMs;
  if (!members.length) return <EmptyState title="No members" description="Invite teammates to see their availability." />;
  const hours = [0, 6, 12, 18, 24];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href={href(d.minus({ days: 1 }).toISODate()!)} aria-label="Previous day" className="rounded-md border p-1.5 hover:bg-accent"><ChevronLeft className="size-4" /></Link>
        <div className="min-w-40 text-center text-sm font-medium">{d.toFormat("cccc, LLL d")}</div>
        <Link href={href(d.plus({ days: 1 }).toISODate()!)} aria-label="Next day" className="rounded-md border p-1.5 hover:bg-accent"><ChevronRight className="size-4" /></Link>
        {!isToday && <Link href={`/dashboard/teams/${orgId}?tab=availability`} className="ml-2 text-sm text-brand hover:underline">Today</Link>}
        <span className="ml-auto text-xs text-muted-foreground">Times in {timeZone}</span>
      </div>
      <Card className="divide-y">
        <div className="relative hidden h-6 sm:block" aria-hidden>
          {hours.map((h) => <span key={h} className="absolute top-1 -translate-x-1/2 text-[10px] text-muted-foreground" style={{ left: `calc(14rem + (100% - 14rem - 1rem) * ${h / 24})` }}>{h}:00</span>)}
        </div>
        {members.map((m) => (
          <div key={m.userId} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
            <div className="flex w-full items-center gap-2 sm:w-56">
              <Avatar src={m.image} name={m.name} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{m.name}</div>
                <div className="text-xs text-muted-foreground">{m.freeMinutes ? `${fmtH(m.freeMinutes)} free` : "No free time"}</div>
              </div>
              {isToday && <Badge variant={m.freeNow ? "success" : "secondary"}>{m.freeNow ? "Free now" : "Busy"}</Badge>}
            </div>
            <div className="relative h-5 flex-1 rounded bg-muted" role="img"
              aria-label={`${m.name}: ${m.free.length ? m.free.map((f) => `${DateTime.fromISO(f.start, { zone: timeZone }).toFormat("h:mm a")} to ${DateTime.fromISO(f.end, { zone: timeZone }).toFormat("h:mm a")}`).join(", ") : "not free"}`}>
              {m.free.map((f) => {
                const s = DateTime.fromISO(f.start).toMillis(), e = DateTime.fromISO(f.end).toMillis();
                return <div key={f.start} className="absolute inset-y-0 rounded bg-success/70" style={{ left: `${((s - fromMs) / span) * 100}%`, width: `${Math.max(((e - s) / span) * 100, 0.5)}%` }} />;
              })}
            </div>
          </div>
        ))}
      </Card>
      <p className="text-xs text-muted-foreground">Green is time inside working hours without bookings or blocked time. Connected external calendars are checked when someone books.</p>
    </div>
  );
}
