import { Suspense } from "react";
import Link from "next/link";
import { requireSuperadmin } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_NAME } from "@/lib/brand";

export const instant = false;

const NAV = [
  ["/admin", "Overview"], ["/admin/users", "Users"], ["/admin/organizations", "Organizations"], ["/admin/subscriptions", "Plans & subscriptions"],
  ["/admin/bookings", "Booking stats"], ["/admin/health", "System health"], ["/admin/audit", "Audit log"], ["/admin/config", "Configuration"],
] as const;

async function Guard({ children }: { children: React.ReactNode }) {
  try {
    await requireSuperadmin();
  } catch (e) {
    if (isAppError(e)) {
      return (
        <div className="mx-auto max-w-md p-10 text-center">
          <h1 className="text-xl font-semibold">Access denied</h1>
          <p className="mt-2 text-sm text-muted-foreground">Super-admin access is required to view this area.</p>
          <Link href="/dashboard" className="mt-4 inline-block text-sm underline">Back to dashboard</Link>
        </div>
      );
    }
    throw e;
  }
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 md:flex-row">
      <aside className="md:w-56 md:shrink-0">
        <div className="mb-4 text-sm font-semibold">{APP_NAME} admin</div>
        <nav className="flex flex-wrap gap-1 md:flex-col">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className="rounded-md px-3 py-2 text-sm hover:bg-accent">{label}</Link>
          ))}
          <Link href="/dashboard" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent">&larr; Back to app</Link>
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        <Suspense fallback={<div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-40 w-full" /></div>}>{children}</Suspense>
      </main>
    </div>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="p-8"><Skeleton className="h-8 w-48" /></div>}>
      <Guard>{children}</Guard>
    </Suspense>
  );
}
