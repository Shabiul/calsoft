import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { listSignInLog } from "@/server/admin/sign-ins";
import { methodLabel } from "@/app/(app)/dashboard/team-activity/format";
import { Pager, fmt, inputCls, one, type SP } from "../_components";

export default async function AdminSignIns({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const f = { q: one(sp.q).trim(), event: one(sp.event), from: one(sp.from), to: one(sp.to) };
  const page = Number(one(sp.page)) || 1;
  const { rows, total, pages } = await listSignInLog({ ...f, page });
  return (
    <>
      <PageHeader title="Sign-in activity" description={`${total} sign-ins and sign-outs. Only when, how and which browser are recorded, never an IP address.`} />
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/admin/sign-ins">
        <input name="q" defaultValue={f.q} placeholder="Name or email" className={`${inputCls} w-56`} aria-label="Name or email" />
        <select name="event" defaultValue={f.event} className={inputCls} aria-label="Event">
          <option value="">Sign-ins and sign-outs</option><option value="sign_in">Sign-ins</option><option value="sign_out">Sign-outs</option>
        </select>
        <label className="text-xs">From <input type="date" name="from" defaultValue={f.from} className={inputCls} /></label>
        <label className="text-xs">To <input type="date" name="to" defaultValue={f.to} className={inputCls} /></label>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>
      <DataTable
        rows={rows} rowKey={(r) => r.id} empty={<p className="rounded-xl border p-6 text-sm text-muted-foreground">No sign-ins match.</p>}
        columns={[
          { key: "t", header: "When", cell: (r) => <span className="whitespace-nowrap">{fmt(r.at)}</span> },
          { key: "u", header: "Person", cell: (r) => <><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.email}</div></> },
          { key: "e", header: "Event", cell: (r) => <Badge variant={r.event === "sign_out" ? "secondary" : "success"}>{r.event === "sign_out" ? "Signed out" : "Signed in"}</Badge> },
          { key: "m", header: "Method", cell: (r) => (r.event === "sign_out" ? "-" : methodLabel(r.provider)) },
          { key: "d", header: "Browser", cell: (r) => r.device ?? "-" },
        ]}
      />
      <Pager base="/admin/sign-ins" params={f} page={page} pages={pages} />
    </>
  );
}

export const instant = false;
