import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { DateTime } from "luxon";
import { Badge, Button, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import {
  getOrganization, getTeamAvailability, listInvitations, listMembers,
} from "@/server/services/organizations";
import { MembersPanel } from "@/components/teams/members-panel";
import { InvitePanel } from "@/components/teams/invite-panel";
import { OrgSettingsForm } from "@/components/teams/org-settings-form";
import { TeamAvailability } from "@/components/teams/team-availability";

export const metadata = { title: "Team" };

type P = { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; date?: string; tz?: string }> };
const TABS = [
  { key: "members", label: "Members" },
  { key: "availability", label: "Availability" },
  { key: "settings", label: "Settings" },
] as const;

export default function TeamPage(props: P) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-64" /></div>}>
        <Content {...props} />
      </Suspense>
    </div>
  );
}

async function Content({ params, searchParams }: P) {
  const [{ id }, sp, user] = await Promise.all([params, searchParams, requireUser()]);
  let org;
  try { org = await getOrganization(user.id, id); } catch (e) { if (isAppError(e)) notFound(); throw e; }
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "members";
  const isAdmin = org.role !== "member";
  const origin = (process.env.APP_URL ?? "").replace(/\/$/, "");

  return (
    <>
      <PageHeader
        title={org.name}
        description={`/${org.slug}`}
        actions={
          <>
            <Badge variant="secondary" className="capitalize">{org.role}</Badge>
            <Button asChild variant="outline" size="sm"><Link href={`/dashboard/event-types?org=${org.id}`}>Team event types</Link></Button>
            <Button asChild variant="outline" size="sm"><a href={`/${org.slug}`} target="_blank" rel="noreferrer"><ExternalLink /> Public page</a></Button>
          </>
        }
      />
      <nav aria-label="Team sections" className="mb-5 flex gap-1 border-b">
        {TABS.map((t) => (
          <Link key={t.key} href={`/dashboard/teams/${id}?tab=${t.key}`} aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.key ? "border-brand font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "members" && <MembersTab orgId={id} userId={user.id} role={org.role} permissions={org.permissions} isAdmin={isAdmin} />}
      {tab === "availability" && <AvailabilityTab orgId={id} userId={user.id} date={sp.date} tz={user.timeZone} />}
      {tab === "settings" && (
        <OrgSettingsForm
          org={{ id, name: org.name, slug: org.slug, logoUrl: org.logoUrl, brandColor: org.brandColor }}
          role={org.role} canBrand={isAdmin || org.permissions.includes("branding.manage")} origin={origin}
        />
      )}
    </>
  );
}

async function MembersTab({ orgId, userId, role, permissions, isAdmin }: { orgId: string; userId: string; role: "owner" | "admin" | "member"; permissions: string[]; isAdmin: boolean }) {
  const [members, invites] = await Promise.all([listMembers(userId, orgId), isAdmin ? listInvitations(userId, orgId) : Promise.resolve([])]);
  const canInvite = isAdmin || permissions.includes("members.invite");
  return (
    <div className="space-y-6">
      {canInvite && <InvitePanel orgId={orgId} actorRole={role} invites={invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString(), expired: i.expired, invitedBy: i.invitedByName }))} canSeeInvites={isAdmin} />}
      <MembersPanel
        orgId={orgId} currentUserId={userId} actorRole={role}
        members={members.map((m) => ({
          userId: m.userId, name: m.name, email: m.email, image: m.image, role: m.role, permissions: m.permissions, joinedAt: m.joinedAt.toISOString(),
          status: m.status, lastActiveAt: m.lastActiveAt.toISOString(), managerUserId: m.managerUserId,
        }))}
      />
    </div>
  );
}

async function AvailabilityTab({ orgId, userId, date, tz }: { orgId: string; userId: string; date?: string; tz: string }) {
  const start = (date ? DateTime.fromISO(date, { zone: tz }) : DateTime.now().setZone(tz)).startOf("day");
  const day = start.isValid ? start : DateTime.now().setZone(tz).startOf("day");
  const members = await getTeamAvailability(userId, orgId, { from: day.toJSDate(), to: day.plus({ days: 1 }).toJSDate() });
  return (
    <TeamAvailability
      orgId={orgId} date={day.toISODate()!} timeZone={tz} fromMs={day.toMillis()} toMs={day.plus({ days: 1 }).toMillis()}
      isToday={day.hasSame(DateTime.now().setZone(tz), "day")}
      members={members.map((m) => ({ userId: m.userId, name: m.name, image: m.image, freeNow: m.freeNow, freeMinutes: m.freeMinutes, free: m.free }))}
    />
  );
}
