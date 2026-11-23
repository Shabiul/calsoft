import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { listEventTypes, listUserOrganizations } from "@/server/services/event-types";
import { BookingLinks, type BookingLinkItem } from "@/components/event-types/booking-links";

export const metadata = { title: "Booking links" };

export default function BookingLinksPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="Booking links" description="Copy, share or embed the public pages for your event types." />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-64" /></div>}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requireUser();
  const actor = { userId: user.id };
  const orgs = await listUserOrganizations(actor);
  const [personal, ...orgLists] = await Promise.all([
    listEventTypes(actor, {}),
    ...orgs.map((o) => listEventTypes(actor, { organizationId: o.id })),
  ]);
  const items: BookingLinkItem[] = [
    ...personal.map((e) => ({ e, group: "Personal", prefix: user.username })),
    ...orgLists.flatMap((list, i) => list.map((e) => ({ e, group: orgs[i].name, prefix: orgs[i].slug }))),
  ].map(({ e, group, prefix }) => ({
    id: e.id, title: e.title, durationMinutes: e.durationMinutes, color: e.color, group, path: e.shortCode ? `/m/${e.shortCode}` : prefix ? `/${prefix}/${e.slug}` : null, embedPath: prefix ? `/${prefix}/${e.slug}` : null, isActive: e.isActive, isOneOff: e.isOneOff,
  }));
  const origin = process.env.APP_URL?.replace(/\/$/, "") ?? "";
  return <BookingLinks items={items} origin={origin} hasUsername={!!user.username} />;
}
