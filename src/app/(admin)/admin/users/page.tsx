import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { listUsers } from "@/server/admin";
import { setUserStatusAction } from "../actions";
import { Flash, Pager, fmt, inputCls, one, type SP } from "../_components";

export default async function AdminUsers({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = one(sp.q).trim(), status = one(sp.status), page = Number(one(sp.page)) || 1;
  const { rows, total, pages } = await listUsers({ q, status, page });
  const back = `/admin/users?${new URLSearchParams({ q, status, page: String(page) })}`;
  return (
    <>
      <PageHeader title="Users" description={`${total} matching`} />
      <Flash sp={sp} />
      <form className="mb-4 flex flex-wrap gap-2" action="/admin/users">
        <input name="q" defaultValue={q} placeholder="Search name, email or username" className={`${inputCls} w-72`} aria-label="Search users" />
        <select name="status" defaultValue={status} className={inputCls} aria-label="Status">
          <option value="">All</option><option value="active">Active</option><option value="suspended">Suspended</option>
        </select>
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <DataTable
        rows={rows} rowKey={(r) => r.id} empty={<p className="rounded-xl border p-6 text-sm text-muted-foreground">No users match.</p>}
        columns={[
          { key: "u", header: "User", cell: (r) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.email}</div></div> },
          { key: "role", header: "Role", cell: (r) => (r.platformRole === "superadmin" ? <Badge>superadmin</Badge> : "user") },
          { key: "status", header: "Status", cell: (r) => (r.deletedAt ? <Badge variant="secondary">deleted</Badge> : <Badge variant={r.status === "suspended" ? "destructive" : "success"}>{r.status}</Badge>) },
          { key: "c", header: "Joined", cell: (r) => fmt(r.createdAt) },
          {
            key: "a", header: "", className: "text-right", cell: (r) => (r.platformRole === "superadmin" || r.deletedAt ? null : (
              <form action={setUserStatusAction}>
                <input type="hidden" name="userId" value={r.id} /><input type="hidden" name="back" value={back} />
                <input type="hidden" name="status" value={r.status === "suspended" ? "active" : "suspended"} />
                <Button type="submit" size="sm" variant={r.status === "suspended" ? "secondary" : "destructive"}>{r.status === "suspended" ? "Reactivate" : "Suspend"}</Button>
              </form>
            )),
          },
        ]}
      />
      <Pager base="/admin/users" params={{ q, status }} page={page} pages={pages} />
    </>
  );
}

export const instant = false;
