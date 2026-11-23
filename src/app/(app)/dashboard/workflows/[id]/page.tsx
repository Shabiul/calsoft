import { Suspense } from "react";
import { notFound } from "next/navigation";
import { PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { getWorkflowForEdit, listEventTypeOptions } from "@/server/workflows/service";
import { WorkflowForm, type StepState } from "../workflow-form";

export const metadata = { title: "Edit workflow" };

export default function EditWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="Edit workflow" />
      <Suspense fallback={<Skeleton className="h-96" />}><Content params={params} /></Suspense>
    </div>
  );
}

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let wf;
  try { wf = await getWorkflowForEdit(user.id, id); } catch (e) { if (isAppError(e) && e.status === 404) notFound(); throw e; }
  const eventTypes = await listEventTypeOptions(user.id);
  const steps: StepState[] = wf.steps.map((s) => ({
    action: s.action as StepState["action"], offsetMinutes: s.offsetMinutes, to: (s.to as StepState["to"]) ?? "invitee",
    subject: s.subject ?? "", body: s.body ?? "", attachIcs: !!s.attachIcs, url: s.url ?? "", secret: "", secretEnc: s.secretEnc, hasSecret: s.hasSecret,
  }));
  return <WorkflowForm initial={{ id: wf.id, name: wf.name, trigger: wf.trigger, eventTypeIds: wf.eventTypeIds, isActive: wf.isActive, steps }} eventTypes={eventTypes} />;
}
