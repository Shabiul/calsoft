import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { EventTypeForm } from "@/components/event-types/event-type-form";
import { defaultFormState } from "@/components/event-types/event-type-state";
import { loadFormRefs } from "../_data";

export const metadata = { title: "New event type" };

export default function NewEventTypePage() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link href="/dashboard/event-types" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Event types</Link>
      <PageHeader title="New event type" />
      <Suspense fallback={<div className="space-y-4"><Skeleton className="h-10 w-80" /><Skeleton className="h-96" /></div>}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requireUser();
  const refs = await loadFormRefs(user.id);
  return <EventTypeForm mode="create" initial={defaultFormState(null)} currentUserId={user.id} {...refs} />;
}
