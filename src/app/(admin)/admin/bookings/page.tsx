import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { getBookingStats } from "@/server/admin";
import { Stat } from "../_components";

export default async function AdminBookings() {
  const s = await getBookingStats(30);
  const max = Math.max(1, ...s.perDay.map((d) => d.n));
  return (
    <>
      <PageHeader title="Booking statistics" description={`Last ${s.days} days unless stated.`} />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total bookings" value={s.total} />
        <Stat label="Upcoming confirmed" value={s.upcoming} />
        {Object.entries(s.byStatus).map(([k, v]) => <Stat key={k} label={k.replace("_", " ")} value={v} />)}
      </div>
      <h2 className="mb-2 text-lg font-semibold">Bookings created per day</h2>
      {s.perDay.length === 0 ? (
        <p className="mb-6 rounded-xl border p-6 text-sm text-muted-foreground">No bookings in this period.</p>
      ) : (
        <div className="mb-6 flex h-40 items-end gap-1 rounded-xl border bg-card p-4" role="img" aria-label="Bookings per day">
          {s.perDay.map((d) => (
            <div key={d.day} className="group flex flex-1 flex-col items-center justify-end" title={`${d.day}: ${d.n}`}>
              <div className="w-full rounded-t bg-brand" style={{ height: `${(d.n / max) * 100}%`, minHeight: 2 }} />
            </div>
          ))}
        </div>
      )}
      <h2 className="mb-2 text-lg font-semibold">Top event types</h2>
      <DataTable
        rows={s.topEvents} rowKey={(r) => r.id} empty={<p className="rounded-xl border p-6 text-sm text-muted-foreground">Nothing booked yet.</p>}
        columns={[{ key: "t", header: "Event type", cell: (r) => r.title }, { key: "n", header: "Bookings", cell: (r) => r.n }]}
      />
    </>
  );
}

export const instant = false;
