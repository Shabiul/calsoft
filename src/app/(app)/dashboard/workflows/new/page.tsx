import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { listEventTypeOptions } from "@/server/workflows/service";
import { WorkflowForm } from "../workflow-form";
import { emptyWorkflow } from "../workflow-state";

export const metadata = { title: "New workflow" };

export default function NewWorkflowPage() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="New workflow" description="Choose a trigger and what should happen." />
      <Suspense fallback={<Skeleton className="h-96" />}><Content /></Suspense>
    </div>
  );
}
async function Content() {
  const user = await requireUser();
  const eventTypes = await listEventTypeOptions(user.id);
  return <WorkflowForm initial={emptyWorkflow()} eventTypes={eventTypes} />;
}
