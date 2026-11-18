import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { getQueue, getConnection, QUEUES, queuePrefix } from "./index";

export const HEARTBEAT_KEY = () => `${queuePrefix()}:worker:heartbeat`;

export interface QueueStats {
  name: string;
  counts: Record<string, number>;
  isPaused: boolean;
  schedulers: number;
  recentFailed: { id: string | undefined; name: string; failedReason: string; attemptsMade: number; finishedOn?: number }[];
}
export interface QueueOverview {
  worker: { alive: boolean; lastHeartbeat: string | null; info: Record<string, unknown> | null };
  queues: QueueStats[];
  notifications: Record<string, number>;
  webhookDeliveries: Record<string, number>;
  workflowExecutions: Record<string, number>;
}

async function countBy(table: string): Promise<Record<string, number>> {
  const r = await db.execute(sql.raw(`select status::text as status, count(*)::int as n from ${table} group by status`));
  const out: Record<string, number> = {};
  for (const row of r.rows as { status: string; n: number }[]) out[row.status] = row.n;
  return out;
}

/** Monitoring snapshot for the admin agent. */
export async function getQueueStats(): Promise<QueueOverview> {
  const queues: QueueStats[] = [];
  for (const name of Object.values(QUEUES)) {
    const q = getQueue(name);
    const [counts, isPaused, schedulers, failed] = await Promise.all([
      q.getJobCounts("waiting", "active", "delayed", "completed", "failed"),
      q.isPaused(),
      q.getJobSchedulersCount().catch(() => 0),
      q.getFailed(0, 9),
    ]);
    queues.push({
      name, counts, isPaused, schedulers,
      recentFailed: failed.map((j) => ({ id: j.id, name: j.name, failedReason: j.failedReason, attemptsMade: j.attemptsMade, finishedOn: j.finishedOn })),
    });
  }
  const raw = await getConnection().get(HEARTBEAT_KEY());
  let info: Record<string, unknown> | null = null;
  try { info = raw ? JSON.parse(raw) : null; } catch { info = null; }
  const [notifications, webhookDeliveries, workflowExecutions] = await Promise.all([
    countBy("notification_log"), countBy("webhook_delivery"), countBy("workflow_execution"),
  ]);
  return {
    worker: { alive: !!raw, lastHeartbeat: (info?.at as string) ?? null, info },
    queues, notifications, webhookDeliveries, workflowExecutions,
  };
}
