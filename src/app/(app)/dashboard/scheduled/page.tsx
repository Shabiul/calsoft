import { Suspense } from "react";
import Link from "next/link";
import { CalendarX } from "lucide-react";
import { DateTime } from "luxon";
import { Badge, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { countScheduled, getBookingDetail, getFilterOptions, listScheduled, type ScheduledTab } from "@/server/services/scheduled";
import { ScheduledFilters } from "@/components/scheduled/filters";
import { BookingDrawer } from "@/components/scheduled/booking-drawer";

export const metadata = { title: "Scheduled events" };

type SP = Promise<{ tab?: string; q?: string; event?: string; host?: string; page?: string; b?: string }>;
const TABS: { key: ScheduledTab; label: string }[] = [
  { key: "upcoming", label: "Upcoming" }, { key: "past", label: "Past" }, { key: "cancelled", label: "Cancelled" },
];
const VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary" | "default"> = {
  confirmed: "success", pending_payment: "warning", pending_confirmation: "warning", cancelled: "destructive", completed: "default", no_show: "warning", rescheduled: "secondary", expired: "secondary",
};

export default function ScheduledPage({ searchParams }: { searchParams: SP }) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader title="Scheduled events" description="Meetings booked with you and your teams." />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Content({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const user = await requireUser();
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "upcoming";
  const page = Math.max(Number.parseInt(sp.page ?? "1", 10) || 1, 1);
  const filters = { q: sp.q, eventTypeId: sp.event, hostId: sp.host };
  const [list, counts, options] = await Promise.all([
    listScheduled(user.id, { ...filters, tab, page }),
    countScheduled(user.id, filters),
    getFilterOptions(user.id),
  ]);
  const tz = user.timeZone;
  const href = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, q: sp.q, event: sp.event, host: sp.host, ...o })) if (v) p.set(k, v);
    const s = p.toString();
    return `/dashboard/scheduled${s ? `?${s}` : ""}`;
  };
  const pages = Math.max(Math.ceil(list.total / list.pageSize), 1);

  let d: Awaited<ReturnType<typeof getBookingDetail>> | null = null;
  if (sp.b) {
    try { d = await getBookingDetail(user.id, sp.b); } catch (e) { if (!isAppError(e)) throw e; }
  }
  const drawer = d ? (
    <BookingDrawer timeZone={tz} detail={{
      id: d.id, status: d.status, startsAt: d.startsAt.toISOString(), endsAt: d.endsAt.toISOString(), eventTitle: d.eventTitle, hostNames: d.hostNames,
      organizationName: d.organizationName, inviteeTimeZone: d.inviteeTimeZone, meetingUrl: d.meetingUrl, hostNotes: d.hostNotes,
      cancelReason: d.cancelReason, cancelledBy: d.cancelledBy, invitees: d.invitees, answers: d.answers,
      timeline: d.timeline.map((t) => ({ ...t, at: t.at.toISOString() })),
      canCancel: d.canCancel, canReschedule: d.canReschedule, canMark: d.canMark, rescheduledFromId: d.rescheduledFromId, canDecide: d.canDecide, series: d.series,
    }} />
  ) : null;

  return (
    <>
      <nav aria-label="Scheduled events tabs" className="mb-4 flex gap-1 border-b">
        {TABS.map((t) => (
          <Link key={t.key} href={href({ tab: t.key, page: undefined, b: undefined })} aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${tab === t.key ? "border-brand font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t.label}<span className="rounded-full bg-muted px-1.5 text-xs">{counts[t.key]}</span>
          </Link>
        ))}
      </nav>
      <ScheduledFilters events={options.events} hosts={options.hosts} />
      {list.rows.length === 0 ? (
        <EmptyState icon={<CalendarX />} title={sp.q || sp.event || sp.host ? "No matching events" : `No ${tab} events`}
          description={sp.q || sp.event || sp.host ? "Try clearing the search or filters." : tab === "upcoming" ? "When someone books a time with you, it will show up here." : undefined} />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {list.rows.map((r) => {
            const s = DateTime.fromJSDate(r.startsAt, { zone: tz }), e = DateTime.fromJSDate(r.endsAt, { zone: tz });
            return (
              <li key={r.id}>
                <Link href={href({ b: r.id })} scroll={false} className="flex flex-wrap items-center gap-x-6 gap-y-1 p-4 hover:bg-accent/50">
                  <div className="w-44 shrink-0 text-sm">
                    <div className="font-medium">{s.toFormat("ccc, LLL d")}</div>
                    <div className="text-muted-foreground">{s.toFormat("h:mm a")} - {e.toFormat("h:mm a")}</div>
                  </div>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: r.eventColor ?? "var(--brand, #4f46e5)" }} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r.inviteeName || r.inviteeEmail}{r.inviteeCount > 1 ? ` +${r.inviteeCount - 1}` : ""}</div>
                    <div className="truncate text-xs text-muted-foreground">{r.eventTitle} · with {r.hostNames.join(", ")}{r.organizationName ? ` · ${r.organizationName}` : ""}</div>
                  </div>
                  <Badge variant={VARIANT[r.status] ?? "secondary"} className="capitalize">{r.status === "pending_confirmation" ? "Needs approval" : r.status.replace("_", " ")}</Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {pages > 1 && (
        <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
          {page > 1 ? <Link href={href({ page: String(page - 1) })} className="text-brand hover:underline">Previous</Link> : <span />}
          <span className="text-muted-foreground">Page {page} of {pages}</span>
          {page < pages ? <Link href={href({ page: String(page + 1) })} className="text-brand hover:underline">Next</Link> : <span />}
        </nav>
      )}
      {drawer}
    </>
  );
}
