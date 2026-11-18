"use client";
import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge, Button, Card, Switch } from "@/components/ui";
import { deleteWorkflowAction, setWorkflowActiveAction } from "./actions";
import { TRIGGER_LABELS } from "./labels";

export interface WorkflowRow {
  id: string; name: string; trigger: string; isActive: boolean; stepCount: number;
  executions: number; failedExecutions: number; scoped: boolean;
}

export function WorkflowList({ rows }: { rows: WorkflowRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const toggle = (r: WorkflowRow, v: boolean) => start(async () => {
    const res = await setWorkflowActiveAction(r.id, v);
    if (!res.ok) toast.error(res.error.message); else { toast.success(v ? "Workflow enabled" : "Workflow paused"); router.refresh(); }
  });
  const remove = (r: WorkflowRow) => {
    if (!window.confirm(`Delete workflow "${r.name}"? Scheduled steps will not run.`)) return;
    start(async () => {
      const res = await deleteWorkflowAction(r.id);
      if (!res.ok) toast.error(res.error.message); else { toast.success("Workflow deleted"); router.refresh(); }
    });
  };

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <Card key={r.id} className="flex flex-wrap items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <Link href={`/dashboard/workflows/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{TRIGGER_LABELS[r.trigger] ?? r.trigger}</Badge>
              <span>{r.stepCount} step{r.stepCount === 1 ? "" : "s"}</span>
              <span>{r.scoped ? "Selected event types" : "All event types"}</span>
              <span>{r.executions} run{r.executions === 1 ? "" : "s"}</span>
              {r.failedExecutions > 0 && <Badge variant="destructive">{r.failedExecutions} failed/skipped</Badge>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={r.isActive} disabled={pending} onCheckedChange={(v) => toggle(r, v)} aria-label={`Toggle ${r.name}`} />
              {r.isActive ? "Active" : "Paused"}
            </label>
            <Button asChild variant="outline" size="sm"><Link href={`/dashboard/workflows/${r.id}`}>Edit</Link></Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => remove(r)}>Delete</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
