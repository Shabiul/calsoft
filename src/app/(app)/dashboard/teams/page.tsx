import { Suspense } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { Avatar, Badge, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { listMyOrganizations } from "@/server/services/organizations";
import { CreateOrgDialog } from "@/components/teams/create-org-dialog";
import { roleLabel } from "@/lib/org-roles";

export const metadata = { title: "Teams" };

export default function TeamsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="Teams" description="Organizations let you share event types, brand your booking pages and schedule together." actions={<CreateOrgDialog />} />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requireUser();
  const orgs = await listMyOrganizations(user.id);
  if (!orgs.length) {
    return <EmptyState icon={<Users />} title="No teams yet" description="Create an organization to invite teammates and offer round robin, collective and group events." action={<CreateOrgDialog />} />;
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {orgs.map((o) => (
        <li key={o.id}>
          <Link href={`/dashboard/teams/${o.id}`} className="block">
            <Card className="flex items-center gap-3 p-4 transition-colors hover:bg-accent/50">
              <Avatar src={o.logoUrl} name={o.name} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{o.name}</div>
                <div className="truncate text-xs text-muted-foreground">/{o.slug} · {o.memberCount} member{o.memberCount === 1 ? "" : "s"}</div>
              </div>
              <Badge variant={o.role === "owner" ? "default" : "secondary"} >{roleLabel(o.role)}</Badge>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
