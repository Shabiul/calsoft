import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { listAudit } from "@/server/admin";
import { Pager, fmt, inputCls, one, type SP } from "../_components";

export default async function AdminAudit({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const f = { actor: one(sp.actor).trim(), action: one(sp.action).trim(), entity: one(sp.entity).trim(), from: one(sp.from), to: one(sp.to) };
  const page = Number(one(sp.page)) || 1;
  const { rows, total, pages } = await listAudit({ ...f, page });
  return (
    <>
      <PageHeader title="Audit log" description={`${total} entries`} />
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/admin/audit">
        <input name="actor" defaultValue={f.actor} placeholder="Actor user id" className={`${inputCls} w-56`} aria-label="Actor id" />
        <input name="action" defaultValue={f.action} placeholder="Action contains" className={`${inputCls} w-48`} aria-label="Action" />
        <input name="entity" defaultValue={f.entity} placeholder="Entity (e.g. booking)" className={`${inputCls} w-44`} aria-label="Entity" />
        <label className="text-xs">From <input type="date" name="from" defaultValue={f.from} className={inputCls} /></label>
        <label className="text-xs">To <input type="date" name="to" defaultValue={f.to} className={inputCls} /></label>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>
      <DataTable
        rows={rows} rowKey={(r) => r.id} empty={<p className="rounded-xl border p-6 text-sm text-muted-foreground">No audit entries match.</p>}
        columns={[
          { key: "t", header: "When", cell: (r) => <span className="whitespace-nowrap">{fmt(r.createdAt)}</span> },
          { key: "a", header: "Actor", cell: (r) => r.actorEmail ?? r.actorId ?? "system" },
          { key: "ac", header: "Action", cell: (r) => <code className="text-xs">{r.action}</code> },
          { key: "e", header: "Entity", cell: (r) => (r.entity ? `${r.entity}${r.entityId ? ` / ${r.entityId.slice(0, 8)}` : ""}` : "-") },
          { key: "m", header: "Details", cell: (r) => <code className="line-clamp-2 break-all text-xs text-muted-foreground">{r.meta ? JSON.stringify(r.meta) : ""}</code> },
          { key: "ip", header: "IP", cell: (r) => r.ip ?? "-" },
        ]}
      />
      <Pager base="/admin/audit" params={f} page={page} pages={pages} />
    </>
  );
}

export const instant = false;
