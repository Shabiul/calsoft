import { Suspense } from "react";
import Link from "next/link";
import { Activity } from "lucide-react";
import { Avatar, Badge, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { roleLabel } from "@/lib/org-roles";
import { getTeamOverview, listOversightOrgs } from "@/server/services/team-oversight";
import { abs, methodLabel, rel } from "./format";

export const metadata = { title: "Team activity" };
type SP = Promise<{ org?: string }>;

export default function TeamActivityPage({ searchParams }: { searchParams: SP }) {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader title="Team activity" description="Who signed in, who is meeting whom, and each person's working hours. View only." />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Content({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const user = await requireUser();
  const orgs = await listOversightOrgs(user.id);
  if (!orgs.length) {
    return <EmptyState icon={<Activity />} title="No teams to oversee" description="Team activity is for managers, team leads, admins and owners. Ask a team owner or admin to give you one of those roles." />;
  }
  const org = orgs.find((o) => o.id === sp.org) ?? orgs[0]!;
  const data = await getTeamOverview(user.id, org.id);
  const tz = user.timeZone;

  return (
    <div className="space-y-6">
      {orgs.length > 1 && (
        <nav aria-label="Teams" className="flex flex-wrap gap-2">
          {orgs.map((o) => (
            <Link key={o.id} href={`/dashboard/team-activity?org=${o.id}`} aria-current={o.id === org.id ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${o.id === org.id ? "border-brand bg-brand/10 text-brand" : "text-muted-foreground hover:text-foreground"}`}>{o.name}</Link>
          ))}
        </nav>
      )}
      <p className="text-sm text-muted-foreground">
        {org.name}: {data.members.length} {data.members.length === 1 ? "person" : "people"}. You are viewing as <strong>{roleLabel(data.viewerRole)}</strong>. Times are in {tz}. <a href={`/dashboard/team-activity/export?org=${org.id}`} className="underline">Download CSV</a>
      </p>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              {["Person", "Last sign-in", "Sign-ins (30 days)", "Last active", "Meetings (24h / 7 days)", "Next meeting", ""].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.members.map((m) => (
              <tr key={m.userId} className="align-top">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar src={m.image} name={m.name} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                      <div className="mt-1 flex gap-1">
                        <Badge variant={m.role === "owner" ? "default" : "secondary"}>{roleLabel(m.role)}</Badge>
                        {m.status !== "active" && <Badge variant="destructive">{m.status}</Badge>}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {m.lastSignInAt ? <><div>{rel(m.lastSignInAt)}</div><div className="text-xs text-muted-foreground" title={abs(m.lastSignInAt, tz)}>{methodLabel(m.lastSignInMethod)} · {abs(m.lastSignInAt, tz, "d LLL, h:mm a")}</div></>
                    : <span className="text-muted-foreground">Never</span>}
                </td>
                <td className="px-4 py-3">{m.signIns30d}</td>
                <td className="px-4 py-3">{rel(m.lastActiveAt)}</td>
                <td className="px-4 py-3">{m.meetingsNext24h} / {m.meetingsNext7d}</td>
                <td className="px-4 py-3">{m.nextMeetingAt ? abs(m.nextMeetingAt, tz) : <span className="text-muted-foreground">None this week</span>}</td>
                <td className="px-4 py-3 text-right"><Link className="text-brand underline-offset-2 hover:underline" href={`/dashboard/team-activity/${org.id}/${m.userId}`}>View details</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <section aria-labelledby="recent-h" className="space-y-2">
        <h2 id="recent-h" className="text-base font-semibold">Recent sign-ins</h2>
        {data.recentSignIns.length === 0 ? <p className="text-sm text-muted-foreground">No sign-ins recorded yet. New sign-ins appear here as they happen.</p> : (
          <Card className="divide-y">
            {data.recentSignIns.map((s, i) => (
              <div key={`${s.userId}-${i}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span><Link className="font-medium hover:underline" href={`/dashboard/team-activity/${org.id}/${s.userId}`}>{s.name}</Link> signed in with {methodLabel(s.provider)}</span>
                <span className="text-xs text-muted-foreground">{s.device ?? "Unknown device"} · {abs(s.at, tz, "d LLL, h:mm a")} ({rel(s.at)})</span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
