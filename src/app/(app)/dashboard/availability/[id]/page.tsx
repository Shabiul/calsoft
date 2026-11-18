import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { getSchedule } from "@/server/services/availability";
import { ScheduleEditor } from "@/components/availability/schedule-editor";

export const metadata = { title: "Edit schedule" };

export default function EditSchedulePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link href="/dashboard/availability" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> All schedules</Link>
      <Suspense fallback={<div className="space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-40" /><Skeleton className="h-96" /></div>}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let schedule;
  try {
    schedule = await getSchedule(user.id, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
  return (
    <>
      <PageHeader title={schedule.name} description="Edit weekly hours, time zone and date overrides." />
      <ScheduleEditor schedule={{ id: schedule.id, name: schedule.name, timeZone: schedule.timeZone, isDefault: schedule.isDefault, rules: schedule.rules, overrides: schedule.overrides }} />
    </>
  );
}
