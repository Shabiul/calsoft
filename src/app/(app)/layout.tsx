import { Suspense } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth-session";
import { APP_NAME } from "@/lib/brand";
import { listOversightOrgs } from "@/server/services/team-oversight";

// Every route under this layout depends on the signed-in session (cookies), so it renders per request.
export const instant = false;

async function ShellWithUser({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // The "Team activity" link shows only for people who manage a team (manager, team lead, admin, owner). The pages re-check on the server.
  const canOversee = (await listOversightOrgs(user.id).catch(() => [])).length > 0;
  return (
    <AppShell
      appName={APP_NAME}
      user={{ name: user.name, email: user.email, image: user.image, username: user.username, platformRole: user.platformRole, canOversee }}
    >
      <Suspense fallback={<div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-40 w-full" /></div>}>{children}</Suspense>
    </AppShell>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="p-8"><Skeleton className="h-8 w-48" /></div>}>
      <ShellWithUser>{children}</ShellWithUser>
    </Suspense>
  );
}
