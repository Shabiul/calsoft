import type { Metadata } from "next";
import Link from "next/link";
import { CalendarCheck, CalendarClock, CalendarDays, Plus } from "lucide-react";
import { DateTime } from "luxon";
import { requireUser } from "@/lib/auth-session";
import { getDashboardStats } from "@/server/services/dashboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { BookingCalendar } from "@/components/calendar/booking-calendar";

export const metadata: Metadata = { title: "Home" };

const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed", pending_payment: "Pending payment", pending_confirmation: "Needs approval", completed: "Completed", cancelled: "Cancelled",
  no_show: "No-show", rescheduled: "Rescheduled", expired: "Expired",
};
const EVENT_LABEL: Record<string, string> = {
  created: "Booked", booked: "Booked", cancelled: "Cancelled", rescheduled: "Rescheduled", completed: "Completed", no_show: "No-show",
};

function Stat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
        </div>
        <div className="flex size-10 items-center justify-center rounded-lg bg-brand/10 text-brand [&_svg]:size-5">{icon}</div>
      </CardContent>
    </Card>
  );
}

export default async function DashboardHome() {
  const user = await requireUser();
  const stats = await getDashboardStats(user.id, user.timeZone);
  const fmt = (iso: string) => DateTime.fromISO(iso, { zone: user.timeZone }).toFormat("ccc, LLL d · h:mm a");
  const statusEntries = Object.entries(stats.byStatus).filter(([, n]) => n > 0);

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${user.name.split(" ")[0]}`}
        description="Here is what is happening with your schedule."
        actions={<Button asChild><Link href="/dashboard/event-types"><Plus />New event type</Link></Button>}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Upcoming" value={stats.upcoming} icon={<CalendarClock />} />
        <Stat label="Today" value={stats.today} icon={<CalendarDays />} />
        <Stat label="This week" value={stats.thisWeek} icon={<CalendarCheck />} />
        <Stat label="All-time bookings" value={stats.total} icon={<CalendarCheck />} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Next up</CardTitle><CardDescription>Your next scheduled meetings</CardDescription></CardHeader>
          <CardContent>
            {stats.nextBookings.length === 0 ? (
              <EmptyState icon={<CalendarClock />} title="No upcoming meetings" description="Share your booking link and new meetings will appear here."
                action={user.username ? <Button asChild variant="secondary"><Link href={`/${user.username}`} target="_blank">View my booking page</Link></Button> : undefined} />
            ) : (
              <ul className="divide-y">
                {stats.nextBookings.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: b.color ?? "var(--brand)" }} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{b.inviteeName ?? "Guest"} <span className="text-muted-foreground">· {b.title}</span></p>
                        <p className="text-xs text-muted-foreground">{fmt(b.startsAt)}</p>
                      </div>
                    </div>
                    <Badge variant={b.status === "confirmed" ? "success" : "warning"}>{STATUS_LABEL[b.status] ?? b.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Bookings by status</CardTitle></CardHeader>
          <CardContent>
            {statusEntries.length === 0 ? <p className="text-sm text-muted-foreground">No bookings yet.</p> : (
              <ul className="space-y-2.5">
                {statusEntries.map(([s, n]) => (
                  <li key={s} className="flex items-center justify-between text-sm"><span className="text-muted-foreground">{STATUS_LABEL[s] ?? s}</span><span className="font-medium tabular-nums">{n}</span></li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Calendar</CardTitle></CardHeader>
        <CardContent><BookingCalendar eventTypes={stats.eventTypes} /></CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
        <CardContent>
          {stats.recent.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : (
            <ul className="divide-y">
              {stats.recent.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span><b className="font-medium">{EVENT_LABEL[r.type] ?? r.type.replaceAll("_", " ")}</b> <span className="text-muted-foreground">· {r.inviteeName ?? "Guest"} · {r.title}</span></span>
                  <span className="shrink-0 text-xs text-muted-foreground">{fmt(r.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
