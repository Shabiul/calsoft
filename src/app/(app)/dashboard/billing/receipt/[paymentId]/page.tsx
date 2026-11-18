import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { listHostPayments } from "@/server/payments/billing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Receipt" };
export const instant = false;

const money = (minor: number, currency: string) => {
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
};

/** Receipt for a payment on one of the signed-in user's events (scoped by host ownership in the query). */
export default async function ReceiptPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const user = await requireUser();
  const { paymentId } = await params;
  if (!z.string().uuid().safeParse(paymentId).success) notFound();
  const [p] = await listHostPayments(user.id, 1, paymentId);
  if (!p || p.status === "failed") notFound();
  const rows: [string, string][] = [
    ["Receipt number", p.id.slice(0, 8).toUpperCase()],
    ["Date", DateTime.fromJSDate(p.createdAt, { zone: user.timeZone }).toFormat("LLL d, yyyy h:mm a ZZZZ")],
    ["Event", p.eventTitle],
    ["Paid by", [p.inviteeName, p.inviteeEmail].filter(Boolean).join(" - ")],
    ["Processor", p.provider === "stripe" ? "Stripe" : "Razorpay"],
    ["Amount", money(p.amount, p.currency)],
    ...(p.refunded ? ([["Refunded", money(p.refunded, p.currency)], ["Net", money(p.amount - p.refunded, p.currency)]] as [string, string][]) : []),
    ["Status", p.status.replace("_", " ")],
  ];
  return (
    <div className="max-w-xl">
      <PageHeader title="Receipt" actions={<Link className="text-sm text-brand hover:underline" href="/dashboard/billing">Back to billing</Link>} />
      <Card>
        <CardHeader><CardTitle>{p.eventTitle}</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="text-right">{v}</dd></div>)}
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">Print this page (Ctrl/Cmd+P) to save a PDF copy.</p>
        </CardContent>
      </Card>
    </div>
  );
}
