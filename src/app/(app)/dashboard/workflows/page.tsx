import { Suspense } from "react";
import Link from "next/link";
import { Plus, Workflow } from "lucide-react";
import { Button, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { listWorkflows } from "@/server/workflows/service";
import { WorkflowList, type WorkflowRow } from "./workflow-list";

export const metadata = { title: "Workflows" };

export default function WorkflowsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title="Workflows"
        description="Automate emails and webhooks around your bookings."
        actions={<Button asChild><Link href="/dashboard/workflows/new"><Plus /> New workflow</Link></Button>}
      />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requireUser();
  const items = await listWorkflows(user.id);
  if (!items.length) {
    return (
      <EmptyState
        icon={<Workflow />}
        title="No workflows yet"
        description="Send a follow-up email after meetings, notify your CRM when someone books, and more."
        action={<Button asChild><Link href="/dashboard/workflows/new"><Plus /> Create workflow</Link></Button>}
      />
    );
  }
  const rows: WorkflowRow[] = items.map((w) => ({
    id: w.id, name: w.name, trigger: w.trigger, isActive: w.isActive, stepCount: w.stepCount,
    executions: w.executions, failedExecutions: w.failedExecutions, scoped: !!w.eventTypeIds?.length,
  }));
  return <WorkflowList rows={rows} />;
}
