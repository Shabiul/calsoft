import { Suspense } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { listEventTypes, listUserOrganizations } from "@/server/services/event-types";
import { EventTypeList, type EventTypeListRow } from "@/components/event-types/event-type-list";

export const metadata = { title: "Event types" };

type SP = Promise<{ org?: string; archived?: string }>;

export default function EventTypesPage({ searchParams }: { searchParams: SP }) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title="Event types"
        description="Create the meetings people can book with you."
        actions={<Button asChild><Link href="/dashboard/event-types/new"><Plus /> New event type</Link></Button>}
      />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function money(amount: number | null, currency: string | null) {
  if (amount == null || !currency) return null;
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount / 100); } catch { return `${(amount / 100).toFixed(2)} ${currency}`; }
}

async function Content({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const user = await requireUser();
  const orgs = await listUserOrganizations({ userId: user.id });
  const org = sp.org ? orgs.find((o) => o.id === sp.org) : undefined;
  const showArchived = sp.archived === "1";
  const items = await listEventTypes({ userId: user.id }, { organizationId: org?.id ?? null, includeArchived: showArchived });
  const prefix = org ? org.slug : user.username;
  const rows: EventTypeListRow[] = items.map((e) => ({
    id: e.id, title: e.title, slug: e.slug, kind: e.kind, durationMinutes: e.durationMinutes, color: e.color, isActive: e.isActive, isOneOff: e.isOneOff,
    archived: !!e.archivedAt, hostCount: e.hostCount, priceLabel: money(e.priceAmount, e.priceCurrency), publicPath: e.shortCode ? `/m/${e.shortCode}` : prefix ? `/${prefix}/${e.slug}` : null,
  }));
  const origin = process.env.APP_URL?.replace(/\/$/, "") ?? "";
  const canCreate = !org || org.role !== "member";
  const q = (o: { org?: string; archived?: boolean }) => {
    const p = new URLSearchParams();
    if (o.org) p.set("org", o.org);
    if (o.archived) p.set("archived", "1");
    const s = p.toString();
    return `/dashboard/event-types${s ? `?${s}` : ""}`;
  };

  return (
    <>
      {orgs.length > 0 ? (
        <nav aria-label="Event type scope" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <Link href={q({ archived: showArchived })} className={`rounded-full border px-3 py-1 ${!org ? "border-brand bg-brand/10 text-brand" : "hover:bg-accent"}`}>Personal</Link>
          {orgs.map((o) => (
            <Link key={o.id} href={q({ org: o.id, archived: showArchived })} className={`rounded-full border px-3 py-1 ${org?.id === o.id ? "border-brand bg-brand/10 text-brand" : "hover:bg-accent"}`}>{o.name}</Link>
          ))}
          <Link href={q({ org: org?.id, archived: !showArchived })} className="ml-auto text-muted-foreground hover:text-foreground">{showArchived ? "Hide archived" : "Show archived"}</Link>
        </nav>
      ) : (
        <div className="mb-4 flex justify-end text-sm"><Link href={q({ archived: !showArchived })} className="text-muted-foreground hover:text-foreground">{showArchived ? "Hide archived" : "Show archived"}</Link></div>
      )}
      {!prefix ? (
        <p role="status" className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
          Your public links need a username. Set one in your profile settings to get shareable URLs.
        </p>
      ) : null}
      <EventTypeList rows={rows} origin={origin} canCreate={canCreate} />
    </>
  );
}
