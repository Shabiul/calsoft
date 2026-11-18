import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { listOrganizations } from "@/server/admin";
import { Pager, fmt, inputCls, one, type SP } from "../_components";

export default async function AdminOrganizations({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = one(sp.q).trim(), page = Number(one(sp.page)) || 1;
  const { rows, total, pages } = await listOrganizations({ q, page });
  return (
    <>
      <PageHeader title="Organizations" description={`${total} matching`} />
      <form className="mb-4 flex gap-2" action="/admin/organizations">
        <input name="q" defaultValue={q} placeholder="Search name or slug" className={`${inputCls} w-72`} aria-label="Search organizations" />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <DataTable
        rows={rows} rowKey={(r) => r.id} empty={<p className="rounded-xl border p-6 text-sm text-muted-foreground">No organizations yet.</p>}
        columns={[
          { key: "n", header: "Organization", cell: (r) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">/{r.slug}</div></div> },
          { key: "m", header: "Members", cell: (r) => r.members },
          { key: "p", header: "Plan", cell: (r) => <Badge variant="secondary">{r.planId}</Badge> },
          { key: "c", header: "Created", cell: (r) => fmt(r.createdAt) },
        ]}
      />
      <Pager base="/admin/organizations" params={{ q }} page={page} pages={pages} />
    </>
  );
}

export const instant = false;
