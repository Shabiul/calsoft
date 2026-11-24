import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Avatar, Badge, Card, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { roleLabel } from "@/lib/org-roles";
import { isAppError } from "@/server/errors";
import { getMemberDetail, type MemberMeeting } from "@/server/services/team-oversight";
import { abs, methodLabel, rel, WEEKDAYS } from "../../format";

export const metadata = { title: "Team member" };
type P = { params: Promise<{ orgId: string; memberId: string }> };

export default function MemberPage({ params }: P) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  confirmed: "success", pending_confirmation: "warning", pending_payment: "warning", cancelled: "destructive", completed: "secondary", no_show: "warning",
};

function Meetings({ title, list, tz, empty }: { title: string; list: MemberMeeting[]; tz: string; empty: string }) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h2 className="text-base font-semibold">{title}</h2>
      {list.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : (
        <Card className="divide-y">
          {list.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{b.eventTitle}</div>
                <div className="text-xs text-muted-foreground">with {b.inviteeName ?? "someone"}{b.inviteeEmail ? ` (${b.inviteeEmail})` : ""}</div>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{abs(b.startsAt, tz)} to {abs(b.endsAt, tz, "h:mm a")}</span>
                <Badge variant={STATUS_VARIANT[b.status] ?? "secondary"}>{b.status.replace(/_/g, " ")}</Badge>
              </div>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

async function Content({ params }: P) {
  const { orgId, memberId } = await params;
  const user = await requireUser();
  let d: Awaited<ReturnType<typeof getMemberDetail>>;
  try { d = await getMemberDetail(user.id, orgId, memberId); } catch (e) { if (isAppError(e) && (e.status === 404 || e.status === 403)) notFound(); throw e; }
  const tz = user.timeZone;
  const m = d.member;

  return (
    <div className="space-y-6">
      <Link href={`/dashboard/team-activity?org=${orgId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> All of {d.orgName}</Link>
      <PageHeader title={m.name} description={`${m.email} · ${roleLabel(m.role)} · time zone ${m.timeZone}`} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Avatar src={m.image} name={m.name} />
        {m.status !== "active" && <Badge variant="destructive">{m.status}</Badge>}
        <span className="text-muted-foreground">Last active {rel(m.lastActiveAt)}</span>
        {m.managerName && <span className="text-muted-foreground">· Reports to {m.managerName}</span>}
        <span className="text-muted-foreground">· Signs in with {m.loginMethods.length ? m.loginMethods.map(methodLabel).join(", ") : "unknown"}</span>
      </div>
      <p className="text-xs text-muted-foreground">Viewing as {roleLabel(d.viewerRole)} (read only). Your view of this page is recorded. Times are shown in {tz}.</p>

      <Meetings title="Upcoming meetings (next 30 days)" list={d.upcoming} tz={tz} empty="No upcoming meetings." />
      <Meetings title="Last 7 days" list={d.recent} tz={tz} empty="No meetings in the last 7 days." />

      <section className="space-y-2" aria-label="Working hours">
        <h2 className="text-base font-semibold">Working hours</h2>
        {d.schedules.length === 0 ? <p className="text-sm text-muted-foreground">No availability schedule set.</p> : d.schedules.map((s) => (
          <Card key={s.name} className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">{s.name}{s.isDefault && <Badge variant="secondary">Default</Badge>}<span className="text-xs font-normal text-muted-foreground">{s.timeZone}</span></div>
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {WEEKDAYS.map((day, i) => {
                const slots = s.weekly.filter((w) => w.weekday === i);
                return <li key={day} className="flex justify-between gap-3"><span className="text-muted-foreground">{day}</span><span>{slots.length ? slots.map((w) => `${w.startTime}-${w.endTime}`).join(", ") : "Off"}</span></li>;
              })}
            </ul>
            {s.overrides.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground">Upcoming date changes</div>
                <ul className="mt-1 space-y-0.5 text-sm">{s.overrides.map((o, i) => <li key={`${o.date}-${i}`}>{o.date}: {o.isUnavailable ? "Unavailable" : `${o.startTime}-${o.endTime}`}</li>)}</ul>
              </div>
            )}
          </Card>
        ))}
      </section>

      <section className="space-y-2" aria-label="Calendars">
        <h2 className="text-base font-semibold">Connected calendars</h2>
        {d.calendars.length === 0 ? <p className="text-sm text-muted-foreground">No calendar connected.</p> : (
          <Card className="divide-y">{d.calendars.map((c, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2 text-sm"><span>{methodLabel(c.provider)}{c.email ? ` · ${c.email}` : ""}</span>
              <Badge variant={c.status === "active" ? "success" : "warning"}>{c.status === "active" ? "Connected" : "Needs reconnecting"}</Badge></div>
          ))}</Card>
        )}
      </section>

      <section className="space-y-2" aria-label="Sign-in history">
        <h2 className="text-base font-semibold">Sign-in history</h2>
        {d.signIns.length === 0 ? <p className="text-sm text-muted-foreground">No sign-ins recorded.</p> : (
          <Card className="divide-y">{d.signIns.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <span>{abs(s.at, tz, "ccc d LLL yyyy, h:mm a")} <Badge variant={s.event === "sign_out" ? "secondary" : "success"}>{s.event === "sign_out" ? "Signed out" : "Signed in"}</Badge></span>
              <span className="text-xs text-muted-foreground">{s.event === "sign_out" ? "" : `${methodLabel(s.provider)} · `}{s.device ?? "Unknown device"}</span>
            </div>
          ))}</Card>
        )}
      </section>
    </div>
  );
}
