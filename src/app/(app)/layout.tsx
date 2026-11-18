import { Suspense } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth-session";
import { APP_NAME } from "@/lib/brand";

// Every route under this layout depends on the signed-in session (cookies), so it renders per request.
export const instant = false;

async function ShellWithUser({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <AppShell
      appName={APP_NAME}
      user={{ name: user.name, email: user.email, image: user.image, username: user.username, platformRole: user.platformRole }}
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
