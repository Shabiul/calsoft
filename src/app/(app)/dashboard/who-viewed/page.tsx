import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { roleLabel, isOrgRole } from "@/lib/org-roles";
import { listWhoViewedMe } from "@/server/services/my-privacy";
import { abs } from "../team-activity/format";

export const metadata = { title: "Who viewed my activity" };

async function Content() {
  const user = await requireUser();
  const rows = await listWhoViewedMe(user.id);
  return (
    <div className="space-y-4">
      <Link href="/dashboard/settings" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Settings</Link>
      <PageHeader title="Who viewed my activity" description="Managers, team leads and admins can see your meetings, working hours and sign-ins. Every time they open your page it is listed here." />
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">Nobody has opened your activity page yet.</p> : (
        <Card className="divide-y">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span><span className="font-medium">{r.viewerName}</span>{r.viewerRole && isOrgRole(r.viewerRole) ? ` (${roleLabel(r.viewerRole)})` : ""}{r.orgName ? ` · ${r.orgName}` : ""}</span>
              <span className="text-xs text-muted-foreground">{abs(r.at, user.timeZone, "ccc d LLL yyyy, h:mm a")}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

export default function WhoViewedPage() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <Suspense fallback={<Skeleton className="h-48" />}><Content /></Suspense>
    </div>
  );
}
