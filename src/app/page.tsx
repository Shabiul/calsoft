import Link from "next/link";
import { Suspense } from "react";
import { asc, eq } from "drizzle-orm";
import { CalendarCheck, CalendarClock, Globe2, Check, Users, Workflow, ShieldCheck, Zap } from "lucide-react";
import { APP_NAME } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/providers/theme-toggle";
import { db, schema } from "@/server/db";

const FEATURES = [
  { icon: CalendarClock, title: "Booking pages that convert", body: "Share one link. Invitees see your real availability in their own time zone and book in seconds." },
  { icon: Zap, title: "No double-booking, ever", body: "Conflicts are blocked at the database level, and connected calendars are re-checked at the moment of booking." },
  { icon: Users, title: "Teams and round robin", body: "Collective, group and round-robin events distribute meetings fairly across your team." },
  { icon: Workflow, title: "Automations", body: "Reminders, follow-ups and webhooks run in the background so nothing slips." },
  { icon: Globe2, title: "Time zones handled", body: "Daylight saving, buffers and minimum notice are computed for you, accurately." },
  { icon: ShieldCheck, title: "Secure by default", body: "Two-factor sign-in, encrypted calendar credentials and an audit trail for every booking." },
];

function formatPrice(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

async function Pricing() {
  let plans: (typeof schema.subscriptionPlans.$inferSelect)[] = [];
  try {
    plans = await db.select().from(schema.subscriptionPlans).where(eq(schema.subscriptionPlans.isActive, true)).orderBy(asc(schema.subscriptionPlans.priceMonthly));
  } catch { /* DB unavailable: hide section */ }
  if (plans.length === 0) return null;
  const rank = ["free", "starter", "professional", "teams", "enterprise"];
  plans.sort((a, b) => rank.indexOf(a.id) - rank.indexOf(b.id));
  return (
    <section id="pricing" className="mx-auto max-w-6xl px-4 py-20">
      <h2 className="text-center text-3xl font-semibold tracking-tight">Simple, transparent pricing</h2>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">Start free. Upgrade when you need more.</p>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {plans.map((p) => {
          const l = p.limits as Record<string, number | boolean>;
          const lim = (n: unknown) => (n === -1 ? "Unlimited" : String(n));
          return (
            <div key={p.id} className="flex flex-col rounded-xl border bg-card p-5 shadow-sm">
              <h3 className="font-semibold">{p.name}</h3>
              <p className="mt-2 text-2xl font-semibold">{p.id === "enterprise" ? "Custom" : formatPrice(p.priceMonthly, p.currency)}{p.id !== "enterprise" && p.priceMonthly > 0 && <span className="text-sm font-normal text-muted-foreground"> /mo</span>}</p>
              <ul className="mt-4 flex-1 space-y-2 text-sm text-muted-foreground">
                {l.maxEventTypes !== undefined && <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{lim(l.maxEventTypes)} event types</li>}
                {l.maxTeamMembers !== undefined && Number(l.maxTeamMembers) !== 1 && <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{lim(l.maxTeamMembers)} team members</li>}
                {l.payments === true && <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />Collect payments</li>}
                {l.roundRobin === true && <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />Round robin and collective</li>}
                {l.analytics === true && <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />Analytics</li>}
                {l.sso === true && <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />SSO</li>}
              </ul>
              <Button asChild variant={p.id === "professional" ? "default" : "secondary"} className="mt-5"><Link href="/signup">{p.id === "enterprise" ? "Contact us" : "Get started"}</Link></Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="flex size-7 items-center justify-center rounded-lg bg-brand text-brand-foreground"><CalendarCheck className="size-4" /></span>{APP_NAME}
          </Link>
          <nav className="flex items-center gap-1">
            <a href="#features" className="hidden px-3 text-sm text-muted-foreground hover:text-foreground sm:block">Features</a>
            <a href="#pricing" className="hidden px-3 text-sm text-muted-foreground hover:text-foreground sm:block">Pricing</a>
            <ThemeToggle />
            <Button asChild variant="ghost" size="sm"><Link href="/login">Sign in</Link></Button>
            <Button asChild size="sm"><Link href="/signup">Get started</Link></Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_srgb,var(--brand)_18%,transparent),transparent)]" />
          <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-20 text-center sm:pt-28">
            <p className="mx-auto mb-5 w-fit rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">Scheduling without the back-and-forth</p>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">Let people book time with you, <span className="text-brand">effortlessly</span></h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">{APP_NAME} connects your calendars, shows your real availability and confirms meetings automatically, for you and your whole team.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Button asChild size="lg"><Link href="/signup">Start for free</Link></Button>
              <Button asChild size="lg" variant="secondary"><Link href="/login">Sign in</Link></Button>
            </div>
          </div>
        </section>

        <section id="features" className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-center text-3xl font-semibold tracking-tight">Everything you need to schedule smarter</h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border bg-card p-6 shadow-sm">
                <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-brand/10 text-brand"><Icon className="size-5" /></div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <Suspense fallback={null}><Pricing /></Suspense>
      </main>

      <footer className="border-t py-8 text-center text-sm text-muted-foreground">&copy; {APP_NAME}. All rights reserved.</footer>
    </div>
  );
}
