import type { Metadata } from "next";
import Link from "next/link";
import { DateTime } from "luxon";
import { Receipt } from "lucide-react";
import { requireUser } from "@/lib/auth-session";
import { getBillingOverview, type PaymentListItem } from "@/server/payments/billing";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CancelSubscriptionButton, UpgradeButton } from "./_components";

export const metadata: Metadata = { title: "Billing" };
export const instant = false;

function money(minor: number, currency: string) {
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
}
const LIMIT_LABEL: Record<string, string> = { maxEventTypes: "Event types", maxSchedules: "Availability schedules" };
const label = (k: string) => LIMIT_LABEL[k] ?? k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  paid: "success", refunded: "secondary", partially_refunded: "warning", failed: "destructive",
};

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ upgraded?: string }> }) {
  const user = await requireUser();
  const [o, sp] = await Promise.all([getBillingOverview(user.id), searchParams]);
  const fmt = (d: Date) => DateTime.fromJSDate(d, { zone: user.timeZone }).toFormat("LLL d, yyyy");

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Your plan, usage and payments received for paid events." />
      {sp.upgraded ? (
        <div className="rounded-lg border bg-success/10 p-3 text-sm" role="status">
          Thanks! Your plan updates as soon as the payment provider confirms the subscription (usually within a minute). Refresh to see it.
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
          <CardDescription>
            {o.plan ? <>You are on <strong>{o.plan.name}</strong>{o.plan.priceMonthly > 0 ? <> at {money(o.plan.priceMonthly, o.plan.currency)} / month</> : <> (free)</>}.</> : "No plan information is available."}
            {o.subscription?.currentPeriodEnd ? <> Renews or ends {fmt(o.subscription.currentPeriodEnd)}.</> : null}
            {o.subscription && o.subscription.status !== "active" ? <> Status: {o.subscription.status.replace("_", " ")}.</> : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {o.usage.length === 0 ? null : (
            <div className="grid gap-3 sm:grid-cols-2">
              {o.usage.map((u) => {
                const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 0;
                return (
                  <div key={u.metric} className="rounded-lg border p-3">
                    <div className="flex justify-between text-sm"><span>{u.label}</span><span className="tabular-nums">{u.used} / {u.limit ?? "Unlimited"}</span></div>
                    {u.limit ? (
                      <div className="mt-2 h-2 rounded bg-muted" role="progressbar" aria-valuenow={u.used} aria-valuemax={u.limit}>
                        <div className={`h-2 rounded ${pct >= 100 ? "bg-destructive" : "bg-brand"}`} style={{ width: `${pct}%` }} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {o.features.length ? (
            <div className="flex flex-wrap gap-2">
              {o.features.map((f) => <Badge key={f.key} variant={f.enabled ? "success" : "secondary"}>{label(f.key)}: {f.enabled ? "included" : "not included"}</Badge>)}
            </div>
          ) : null}
          {o.subscription?.canCancel ? <CancelSubscriptionButton /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Plans</CardTitle><CardDescription>Prices come from the platform plan catalog.</CardDescription></CardHeader>
        <CardContent>
          {o.plans.length === 0 ? <EmptyState title="No plans published" description="The platform has not published any subscription plans yet." /> : (
            <div className="grid gap-4 md:grid-cols-3">
              {o.plans.map((p) => (
                <div key={p.id} className={`rounded-xl border p-4 ${p.current ? "border-brand ring-1 ring-brand" : ""}`}>
                  <div className="flex items-center justify-between"><h4 className="font-semibold">{p.name}</h4>{p.current ? <Badge>Current</Badge> : null}</div>
                  <p className="mt-1 text-2xl font-semibold">
                    {p.priceMonthly > 0 ? money(p.priceMonthly, p.currency) : "Free"}
                    {p.priceMonthly > 0 ? <span className="text-sm font-normal text-muted-foreground"> / month</span> : null}
                  </p>
                  <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                    {Object.entries(p.limits).map(([k, v]) => <li key={k}>{label(k)}: {typeof v === "boolean" ? (v ? "Yes" : "No") : v < 0 ? "Unlimited" : v}</li>)}
                  </ul>
                  <div className="mt-4">
                    {p.current || p.priceMonthly <= 0 ? null : p.providers.length ? (
                      <UpgradeButton planId={p.id} provider={p.providers[0]} label={`Upgrade to ${p.name}`} />
                    ) : (
                      <p className="text-sm text-muted-foreground" role="status">Online checkout is not configured for this plan yet.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {o.providersConfigured.length === 0 && o.plans.length > 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No payment provider (Razorpay or Stripe) is configured on this server, so upgrades are disabled.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payments received</CardTitle>
          <CardDescription>
            {o.totals.length ? o.totals.map((t) => `${money(t.collected, t.currency)} collected, ${money(t.refunded, t.currency)} refunded`).join(" | ") : "Payments from invitees booking your paid events."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable<PaymentListItem>
            rows={o.payments} rowKey={(r) => r.id}
            empty={<EmptyState icon={<Receipt />} title="No payments yet" description="When invitees pay for your paid event types, they appear here with receipts." />}
            columns={[
              { key: "date", header: "Date", cell: (r) => fmt(r.createdAt) },
              { key: "event", header: "Event", cell: (r) => <div><div>{r.eventTitle}</div><div className="text-xs text-muted-foreground">{r.inviteeName ?? r.inviteeEmail ?? ""}</div></div> },
              { key: "amount", header: "Amount", className: "tabular-nums", cell: (r) => <>{money(r.amount, r.currency)}{r.refunded ? <div className="text-xs text-muted-foreground">-{money(r.refunded, r.currency)} refunded</div> : null}</> },
              { key: "status", header: "Status", cell: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "secondary"}>{r.status.replace("_", " ")}</Badge> },
              { key: "receipt", header: "", cell: (r) => r.status === "failed" ? null : <Link className="text-brand underline-offset-2 hover:underline" href={`/dashboard/billing/receipt/${r.id}`}>Receipt</Link> },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
