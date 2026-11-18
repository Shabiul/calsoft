import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { getHealth } from "@/server/admin";
import { Stat, StatusBadge, fmt } from "../_components";

export default async function AdminHealth() {
  const h = await getHealth();
  const w = h.queues?.worker;
  const failedJobs = h.queues?.queues.flatMap((q) => q.recentFailed.map((f) => ({ ...f, queue: q.name, key: `${q.name}:${f.id}` }))) ?? [];
  return (
    <>
      <PageHeader title="System health" description={`Checked ${fmt(h.checkedAt)}. Reload to refresh.`} />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Database" value={<StatusBadge ok={h.database.ok} />} hint={h.database.ok ? `${h.database.latencyMs} ms` : h.database.error} />
        <Stat label="Redis" value={<StatusBadge ok={h.redis.ok} />} hint={h.redis.ok ? `${h.redis.latencyMs} ms` : h.redis.error} />
        <Stat label="Worker" value={<StatusBadge ok={!!w?.alive} label={w?.alive ? "Alive" : "No heartbeat"} />} hint={w?.lastHeartbeat ? `Last heartbeat ${fmt(w.lastHeartbeat)}` : undefined} />
        <Stat label="Webhook failures" value={h.webhookFailures.failed + h.webhookFailures.dead} hint={`${h.webhookFailures.failed} failed, ${h.webhookFailures.dead} dead`} />
      </div>
      {h.queueError ? <p className="mb-4 text-sm text-destructive">Queue stats unavailable: {h.queueError}</p> : null}

      <h2 className="mb-2 text-lg font-semibold">Queues</h2>
      <div className="mb-6">
        <DataTable
          rows={h.queues?.queues ?? []} rowKey={(r) => r.name}
          empty={<p className="rounded-xl border p-6 text-sm text-muted-foreground">Queue statistics unavailable (Redis down?).</p>}
          columns={[
            { key: "n", header: "Queue", cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: "w", header: "Waiting", cell: (r) => r.counts.waiting ?? 0 },
            { key: "a", header: "Active", cell: (r) => r.counts.active ?? 0 },
            { key: "d", header: "Delayed", cell: (r) => r.counts.delayed ?? 0 },
            { key: "f", header: "Failed", cell: (r) => <Badge variant={(r.counts.failed ?? 0) > 0 ? "destructive" : "secondary"}>{r.counts.failed ?? 0}</Badge> },
            { key: "p", header: "Paused", cell: (r) => (r.isPaused ? "yes" : "no") },
          ]}
        />
      </div>

      <h2 className="mb-2 text-lg font-semibold">Recent failed jobs</h2>
      <div className="mb-6">
        <DataTable
          rows={failedJobs} rowKey={(r) => r.key} empty={<p className="rounded-xl border p-6 text-sm text-muted-foreground">No failed jobs.</p>}
          columns={[
            { key: "q", header: "Queue", cell: (r) => r.queue }, { key: "j", header: "Job", cell: (r) => r.name },
            { key: "at", header: "Attempts", cell: (r) => r.attemptsMade },
            { key: "e", header: "Reason", cell: (r) => <span className="line-clamp-2 break-all text-xs">{r.failedReason}</span> },
          ]}
        />
      </div>

      <h2 className="mb-2 text-lg font-semibold">Recent webhook delivery failures</h2>
      <DataTable
        rows={h.webhookFailures.recent} rowKey={(r) => r.id} empty={<p className="rounded-xl border p-6 text-sm text-muted-foreground">No failed deliveries.</p>}
        columns={[
          { key: "e", header: "Event", cell: (r) => r.event }, { key: "s", header: "Status", cell: (r) => <Badge variant="destructive">{r.status}</Badge> },
          { key: "c", header: "HTTP", cell: (r) => r.responseCode ?? "-" },
          { key: "er", header: "Error", cell: (r) => <span className="line-clamp-2 break-all text-xs">{r.error ?? "-"}</span> },
          { key: "t", header: "When", cell: (r) => fmt(r.createdAt) },
        ]}
      />
    </>
  );
}

export const instant = false;
