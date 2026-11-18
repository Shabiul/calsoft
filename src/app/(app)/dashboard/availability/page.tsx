import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { listBlockedTimes, listSchedules } from "@/server/services/availability";
import { ScheduleList } from "@/components/availability/schedule-list";
import { BlockedTimes } from "@/components/availability/blocked-times";

export const metadata = { title: "Availability" };

export default function AvailabilityPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="Availability" description="Define when people can book you. Create several schedules and assign them to event types." />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requireUser();
  const [schedules, blocked] = await Promise.all([listSchedules(user.id), listBlockedTimes(user.id)]);
  return (
    <div className="space-y-8">
      <ScheduleList
        defaultTimeZone={user.timeZone}
        schedules={schedules.map((s) => ({
          id: s.id, name: s.name, timeZone: s.timeZone, isDefault: s.isDefault, overrideCount: s.overrideCount,
          eventTypeCount: s.eventTypeCount, rules: s.rules,
        }))}
      />
      <BlockedTimes items={blocked.map((b) => ({ id: b.id, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), reason: b.reason }))} />
    </div>
  );
}
