import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { listPlans, listSubscriptions } from "@/server/admin";
import { changeSubscriptionPlanAction, savePlanAction } from "../actions";
import { Flash, Pager, fmt, inputCls, one, type SP } from "../_components";

export default async function AdminSubscriptions({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const status = one(sp.status), page = Number(one(sp.page)) || 1;
  const [plans, subs] = await Promise.all([listPlans(), listSubscriptions({ status, page })]);
  const back = `/admin/subscriptions?${new URLSearchParams({ status, page: String(page) })}`;
  const empty = { id: "", name: "", priceMonthly: 0, currency: "USD", isActive: true, limits: {} as Record<string, number | boolean> };
  return (
    <>
      <PageHeader title="Plans & subscriptions" description="Edit plan limits (JSON) and move subscriptions between plans." />
      <Flash sp={sp} />
      <section className="mb-8 space-y-4">
        <h2 className="text-lg font-semibold">Plans</h2>
        {[...plans, empty].map((p) => (
          <form key={p.id || "new"} action={savePlanAction} className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-6">
            <label className="text-xs">Id
              <input name="id" defaultValue={p.id} readOnly={!!p.id} required placeholder="pro" className={`${inputCls} mt-1 w-full`} />
            </label>
            <label className="text-xs md:col-span-2">Name
              <input name="name" defaultValue={p.name} required className={`${inputCls} mt-1 w-full`} />
            </label>
            <label className="text-xs">Price / month (minor units)
              <input name="priceMonthly" type="number" min={0} defaultValue={p.priceMonthly} className={`${inputCls} mt-1 w-full`} />
            </label>
            <label className="text-xs">Currency
              <input name="currency" defaultValue={p.currency} maxLength={3} className={`${inputCls} mt-1 w-full uppercase`} />
            </label>
            <label className="flex items-end gap-2 pb-2 text-xs"><input type="checkbox" name="isActive" defaultChecked={p.isActive} /> Active</label>
            <label className="text-xs md:col-span-5">Limits JSON (e.g. {`{"maxEventTypes": 5, "maxSchedules": 2}`})
              <textarea name="limits" defaultValue={JSON.stringify(p.limits, null, 2)} rows={4} spellCheck={false} className="mt-1 w-full rounded-md border border-input bg-background p-2 font-mono text-xs" />
            </label>
            <div className="flex items-end"><Button type="submit">{p.id ? "Save plan" : "Create plan"}</Button></div>
          </form>
        ))}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Subscriptions</h2>
        <form className="mb-4 flex gap-2" action="/admin/subscriptions">
          <select name="status" defaultValue={status} className={inputCls} aria-label="Status">
            <option value="">All statuses</option><option value="active">active</option><option value="trialing">trialing</option>
            <option value="past_due">past_due</option><option value="cancelled">cancelled</option>
          </select>
          <Button type="submit" variant="secondary">Filter</Button>
        </form>
        <DataTable
          rows={subs.rows} rowKey={(r) => r.id} empty={<p className="rounded-xl border p-6 text-sm text-muted-foreground">No subscriptions yet.</p>}
          columns={[
            { key: "s", header: "Subscriber", cell: (r) => r.orgName ?? r.userEmail ?? "-" },
            { key: "st", header: "Status", cell: (r) => <Badge variant={r.status === "active" ? "success" : "secondary"}>{r.status}</Badge> },
            { key: "pe", header: "Renews", cell: (r) => fmt(r.currentPeriodEnd) },
            {
              key: "pl", header: "Plan", cell: (r) => (
                <form action={changeSubscriptionPlanAction} className="flex items-center gap-2">
                  <input type="hidden" name="subscriptionId" value={r.id} /><input type="hidden" name="back" value={back} />
                  <select name="planId" defaultValue={r.planId} className={inputCls} aria-label="Plan">
                    {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <Button type="submit" size="sm" variant="secondary">Change</Button>
                </form>
              ),
            },
          ]}
        />
        <Pager base="/admin/subscriptions" params={{ status }} page={subs.page} pages={subs.pages} />
      </section>
    </>
  );
}

export const instant = false;
