import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { roleLabel } from "@/lib/org-roles";
import { listOversightOrgs } from "@/server/services/team-oversight";
import { getTeamInsights } from "@/server/services/team-insights";
import { WEEKDAYS } from "../format";

export const metadata = { title: "Team insights" };
type SP = Promise<{ org?: string }>;

export default function InsightsPage({ searchParams }: { searchParams: SP }) {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-72" /></div>}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Content({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const user = await requireUser();
  const orgs = await listOversightOrgs(user.id);
  if (!orgs.length) return <EmptyState title="No teams to oversee" description="Insights are for managers, team leads, admins and owners." />;
  const org = orgs.find((o) => o.id === sp.org) ?? orgs[0]!;
  const d = await getTeamInsights(user.id, org.id, user.timeZone);
  const max = Math.max(1, ...d.heatmap.flat());
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first

  return (
    <div className="space-y-6">
      <Link href={`/dashboard/team-activity?org=${org.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Team activity</Link>
      <PageHeader title="Team insights" description={`${org.name}: ${d.people} ${d.people === 1 ? "person" : "people"}, viewing as ${roleLabel(d.viewerRole)}. Times are in ${d.viewerZone}.`} />

      <section className="space-y-2" aria-label="Availability heatmap">
        <h2 className="text-base font-semibold">Who is available when</h2>
        <p className="text-xs text-muted-foreground">Darker means more people are available that hour, based on each person&apos;s default working hours converted to your time zone.</p>
        <Card className="overflow-x-auto p-4">
          <table className="border-separate border-spacing-0.5 text-xs" role="grid">
            <thead><tr><th className="w-12" />{hours.map((h) => <th key={h} className="w-7 font-normal text-muted-foreground">{h % 3 === 0 ? h : ""}</th>)}</tr></thead>
            <tbody>
              {order.map((wd) => (
                <tr key={wd}>
                  <th scope="row" className="pr-2 text-left font-normal text-muted-foreground">{WEEKDAYS[wd]!.slice(0, 3)}</th>
                  {hours.map((h) => {
                    const n = d.heatmap[wd]![h]!;
                    return (
                      <td key={h} title={`${WEEKDAYS[wd]} ${String(h).padStart(2, "0")}:00: ${n} available`} aria-label={`${WEEKDAYS[wd]} ${h}:00, ${n} available`}
                        className="h-6 w-7 rounded-sm border border-border/50 text-center"
                        style={{ background: n ? `color-mix(in oklab, var(--color-brand, #2563eb) ${Math.round(15 + (n / max) * 75)}%, transparent)` : undefined }}>
                        {n || ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      <section className="space-y-2" aria-label="Workload">
        <h2 className="text-base font-semibold">Workload, last {d.windowDays} days</h2>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Person</th><th className="px-2 font-medium">Meetings</th><th className="px-2 font-medium">Per week</th>
              <th className="px-2 font-medium">Completed</th><th className="px-2 font-medium">Cancelled</th><th className="px-2 font-medium">No-shows</th><th className="px-2 font-medium">Next 7 days</th>
            </tr></thead>
            <tbody className="divide-y">
              {d.workload.map((w) => (
                <tr key={w.userId}>
                  <td className="px-4 py-2"><Link href={`/dashboard/team-activity/${org.id}/${w.userId}`} className="font-medium hover:underline">{w.name}</Link><div className="text-xs text-muted-foreground">{roleLabel(w.role as never)}</div></td>
                  <td className="px-2">{w.total}</td><td className="px-2">{w.perWeek}</td><td className="px-2">{w.completed}</td>
                  <td className="px-2">{w.cancelled}</td><td className="px-2">{w.noShow}</td><td className="px-2">{w.next7d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  );
}
