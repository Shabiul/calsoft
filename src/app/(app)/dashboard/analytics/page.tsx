import { Suspense } from "react";
import Link from "next/link";
import { BarChart3, Download } from "lucide-react";
import { Button, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { AppError } from "@/server/errors";
import { getAnalytics } from "@/server/services/analytics";
import { listRoutableEventTypes } from "@/server/services/routing-forms";
import { BarChart, Panel, RankBars, StatCard } from "@/components/analytics/charts";
import { PRESETS, parseRange } from "./params";

export const metadata = { title: "Analytics" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const selectCls = "h-9 rounded-md border border-input bg-card px-3 text-sm shadow-sm";
const pctText = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(r >= 0.995 || r === 0 ? 0 : 1)}%`);

function money(minor: number, currency: string): string {
  try {
    const nf = new Intl.NumberFormat("en", { style: "currency", currency });
    const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
    return nf.format(minor / 10 ** digits);
  } catch { return `${minor} ${currency}`; }
}

export default function AnalyticsPage({ searchParams }: { searchParams: SP }) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader title="Analytics" description="Numbers computed from your real bookings, payments and page views." />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-10" /><div className="grid gap-3 sm:grid-cols-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div><Skeleton className="h-56" /></div>}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Content({ searchParams }: { searchParams: SP }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = parseRange(sp, user.timeZone);
  let report;
  try { report = await getAnalytics(user.id, q); } catch (e) {
    if (e instanceof AppError) return <EmptyState icon={<BarChart3 />} title="Invalid date range" description={e.message} action={<Button asChild variant="outline"><Link href="/dashboard/analytics">Reset</Link></Button>} />;
    throw e;
  }
  const events = await listRoutableEventTypes(user.id);
  const exportQs = new URLSearchParams({ from: q.fromStr, to: q.toStr, ...(q.eventTypeId ? { event: q.eventTypeId } : {}) }).toString();
  const t = report.totals;
  const bucketLabel = (b: string) => (report.range.bucket === "month" ? b.slice(0, 7) : b.slice(5));

  return (
    <div className="space-y-5">
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Analytics filters">
        <div>
          <label htmlFor="a-range" className="mb-1 block text-xs text-muted-foreground">Range</label>
          <select id="a-range" name="range" defaultValue={q.preset === "custom" ? "" : q.preset} className={selectCls}>
            {q.preset === "custom" && <option value="">Custom</option>}
            {PRESETS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="a-from" className="mb-1 block text-xs text-muted-foreground">From</label>
          <input id="a-from" type="date" name="from" defaultValue={q.preset === "custom" ? q.fromStr : ""} className={selectCls} />
        </div>
        <div>
          <label htmlFor="a-to" className="mb-1 block text-xs text-muted-foreground">To</label>
          <input id="a-to" type="date" name="to" defaultValue={q.preset === "custom" ? q.toStr : ""} className={selectCls} />
        </div>
        <div>
          <label htmlFor="a-event" className="mb-1 block text-xs text-muted-foreground">Event type</label>
          <select id="a-event" name="event" defaultValue={q.eventTypeId ?? ""} className={selectCls}>
            <option value="">All event types</option>
            {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
          </select>
        </div>
        <Button type="submit" variant="secondary">Apply</Button>
        <Button asChild variant="outline"><a href={`/dashboard/analytics/export?${exportQs}`} download><Download /> Export CSV</a></Button>
      </form>
      <p className="text-xs text-muted-foreground">
        {q.fromStr} to {q.toStr} in {report.range.timeZone}. Bookings are counted by meeting start time. Linked rows of collective events are counted once.
      </p>

      {t.total === 0 && report.conversion.pageViews === 0 && report.revenue.length === 0 ? (
        <EmptyState icon={<BarChart3 />} title="No data in this range" description="Once people view your booking pages and schedule meetings, real numbers show up here." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Bookings" value={t.total} hint={`${t.byStatus.confirmed} confirmed, ${t.byStatus.pending_payment} awaiting payment, ${t.byStatus.pending_confirmation} awaiting approval`} />
            <StatCard label="Completed" value={t.completed} hint={`${t.noShow} no-show`} />
            <StatCard label="Cancelled" value={t.cancelled} hint={`${t.rescheduled} rescheduled`} />
            <StatCard label="Completion rate" value={pctText(t.completionRate)} hint="completed / (completed + no-show + cancelled)" />
            <StatCard label="Cancellation rate" value={pctText(t.cancellationRate)} hint="cancelled / all except rescheduled & expired" />
            <StatCard label="Page views" value={report.conversion.pageViews} hint="raw hits, not unique visitors" estimate />
            <StatCard label="Views to bookings" value={pctText(report.conversion.rate)} estimate
              hint={`${report.conversion.bookingsMade} new bookings / ${report.conversion.pageViews} views. Views are not unique visitors, so treat as approximate.`} />
            <StatCard label="Revenue" estimate={false}
              value={report.revenue.length ? <span className="block space-y-0.5 text-lg">{report.revenue.map((r) => <span key={r.currency} className="block">{money(r.paid, r.currency)}</span>)}</span> : "None"}
              hint={report.revenue.length ? report.revenue.map((r) => `${r.payments} paid${r.refunded ? `, ${money(r.refunded, r.currency)} refunded` : ""}`).join("; ") : "Paid payments only"} />
          </div>

          <Panel title="Bookings over time" description={`Per ${report.range.bucket}, by meeting start`}>
            <BarChart ariaLabel={`Bookings per ${report.range.bucket}`} data={report.trend.map((p) => ({ label: bucketLabel(p.bucket), value: p.total }))} every={Math.max(1, Math.ceil(report.trend.length / 10))} />
          </Panel>

          <div className="grid gap-5 md:grid-cols-2">
            <Panel title="Popular weekdays" description={`Scheduled meetings, ${report.range.timeZone}`}>
              <BarChart ariaLabel="Meetings by weekday" height={140} data={report.weekdays.map((w) => ({ label: w.label, value: w.count }))} />
            </Panel>
            <Panel title="Popular hours" description={`Start hour, ${report.range.timeZone}`}>
              <BarChart ariaLabel="Meetings by start hour" height={140} every={3} data={report.hours.map((h) => ({ label: String(h.hour).padStart(2, "0"), value: h.count }))} />
            </Panel>
            <Panel title="By event type">
              <RankBars empty="No bookings in this range." rows={report.byEventType.map((e) => ({ key: e.id, label: e.title, value: e.total, color: null, sub: `${e.completed} done, ${e.cancelled} cancelled` }))} />
            </Panel>
            <Panel title="By host">
              <RankBars empty="No bookings in this range." rows={report.byHost.map((h) => ({ key: h.id, label: h.name, value: h.total, sub: `${h.completed} done, ${h.cancelled} cancelled` }))} />
            </Panel>
          </div>

          <Panel title="Page views to bookings (estimate)" description="Views are raw page loads of your public booking pages, not unique visitors. Bookings are new bookings created in the range (reschedules excluded).">
            {report.conversion.perEventType.length === 0 ? <p className="text-sm text-muted-foreground">No page views or new bookings in this range.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><th className="py-2 pr-4 font-medium">Event type</th><th className="py-2 pr-4 font-medium">Views</th><th className="py-2 pr-4 font-medium">New bookings</th><th className="py-2 font-medium">Rate</th></tr></thead>
                  <tbody>
                    {report.conversion.perEventType.map((r) => (
                      <tr key={r.id} className="border-b last:border-0"><td className="py-2 pr-4">{r.title}</td><td className="py-2 pr-4 tabular-nums">{r.views}</td><td className="py-2 pr-4 tabular-nums">{r.bookings}</td><td className="py-2 tabular-nums">{pctText(r.rate)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
