"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  BarChart3, CalendarCheck, CalendarClock, Clock, Contact, CreditCard, ExternalLink, GitBranch, Home, LayoutList,
  Link2, LogOut, Menu, Plug, Settings, Shield, Users, Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/providers/theme-toggle";
import { authClient } from "@/lib/auth-client";

const NAV = [
  { href: "/dashboard", label: "Home", icon: Home, exact: true },
  { href: "/dashboard/scheduled-events", label: "Scheduled events", icon: CalendarClock },
  { href: "/dashboard/event-types", label: "Event types", icon: LayoutList },
  { href: "/dashboard/availability", label: "Availability", icon: Clock },
  { href: "/dashboard/booking-links", label: "Booking links", icon: Link2 },
  { href: "/dashboard/contacts", label: "Contacts", icon: Contact },
  { href: "/dashboard/workflows", label: "Workflows", icon: Workflow },
  { href: "/dashboard/routing-forms", label: "Routing forms", icon: GitBranch },
  { href: "/dashboard/teams", label: "Teams", icon: Users },
  { href: "/dashboard/integrations", label: "Integrations", icon: Plug },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export interface ShellUser { name: string; email: string; image: string | null; username: string | null; platformRole: "user" | "superadmin" }

function NavList({ appName, onNavigate, isSuperadmin }: { appName: string; onNavigate?: () => void; isSuperadmin: boolean }) {
  const pathname = usePathname();
  const items = isSuperadmin ? [...NAV, { href: "/admin", label: "Admin", icon: Shield, exact: false }] : NAV;
  return (
    <div className="flex h-full flex-col">
      <Link href="/dashboard" onClick={onNavigate} className="flex h-14 items-center gap-2 px-4 text-base font-semibold">
        <span className="flex size-7 items-center justify-center rounded-lg bg-brand text-brand-foreground"><CalendarCheck className="size-4" /></span>
        {appName}
      </Link>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2" aria-label="Main">
        {items.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
          return (
            <Link key={href} href={href} onClick={onNavigate} aria-current={active ? "page" : undefined}
              className={cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                active && "bg-brand/10 text-brand hover:bg-brand/10 hover:text-brand")}>
              <Icon className="size-4" />{label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function AppShell({ user, appName, children }: { user: ShellUser; appName: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function logout() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r bg-card lg:block">
        <NavList appName={appName} isSuperadmin={user.platformRole === "superadmin"} />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
          <NavList appName={appName} onNavigate={() => setOpen(false)} isSuperadmin={user.platformRole === "superadmin"} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}><Menu /></Button>
          <div className="flex-1" />
          {user.username && (
            <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
              <a href={`/${user.username}`} target="_blank" rel="noreferrer"><ExternalLink />View booking page</a>
            </Button>
          )}
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-full cursor-pointer" aria-label="Account menu"><Avatar src={user.image} name={user.name} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <div className="truncate text-sm font-medium text-foreground">{user.name}</div>
                <div className="truncate text-xs">{user.email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/dashboard/settings")}><Settings />Settings</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push("/dashboard/billing")}><CreditCard />Billing</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={logout}><LogOut />Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
