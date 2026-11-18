/**
 * Workflow engine. Triggers: booking_created / cancelled / rescheduled / completed.
 * Each step becomes a workflow_execution (deterministic id => idempotent per booking+trigger+step) and a
 * delayed BullMQ job. offsetMinutes >= 0: delay after the trigger; < 0: that many minutes BEFORE the meeting start.
 */
import { and, eq } from "drizzle-orm";
import { UnrecoverableError } from "bullmq";
import { db } from "@/server/db";
import { bookings, workflowExecutions, workflows, workflowSteps } from "@/server/db/schema";
import { decrypt } from "@/lib/crypto";
import { enqueue, MAX_ATTEMPTS, QUEUES, type EventJobData, type EventType } from "@/server/queue";
import { loadBookingContext } from "@/server/notifications/context";
import { queueNotification } from "@/server/notifications/service";
import { buildWebhookPayload, detUuid } from "@/server/webhooks/dispatch";
import { postJson } from "@/server/webhooks/http";
import { signPayload } from "@/server/webhooks/signing";
import { SsrfError } from "@/server/webhooks/ssrf";
import type { WorkflowTrigger } from "@/server/webhooks/events";

export function triggerForEvent(type: EventType): WorkflowTrigger | null {
  switch (type) {
    case "booking.created": case "booking.confirmed": case "payment.succeeded": return "booking_created";
    case "booking.cancelled": return "booking_cancelled";
    case "booking.rescheduled": return "booking_rescheduled";
    case "booking.completed": return "booking_completed";
    default: return null;
  }
}

/** Pure scheduling rule, exported for tests. */
export function computeRunAt(offsetMinutes: number, startsAt: Date, now: Date): Date {
  return offsetMinutes < 0 ? new Date(startsAt.getTime() + offsetMinutes * 60_000) : new Date(now.getTime() + offsetMinutes * 60_000);
}

class HttpStatusError extends Error {}

export async function fanoutWorkflows(event: EventJobData, now = new Date()): Promise<number> {
  const trigger = triggerForEvent(event.type);
  if (!trigger) return 0;
  const [b] = await db.select().from(bookings).where(eq(bookings.id, event.payload.bookingId));
  if (!b) return 0;
  if (trigger !== "booking_cancelled" && trigger !== "booking_completed" && b.status !== "confirmed") return 0;
  const wfs = await db.select().from(workflows).where(and(eq(workflows.isActive, true), eq(workflows.trigger, trigger)));
  let created = 0;
  for (const wf of wfs) {
    const owned = wf.ownerUserId === b.hostUserId || (!!wf.organizationId && wf.organizationId === b.organizationId);
    if (!owned) continue;
    if (wf.eventTypeIds?.length && !wf.eventTypeIds.includes(b.eventTypeId)) continue;
    const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, wf.id)).orderBy(workflowSteps.position);
    for (const step of steps) {
      const runAt = computeRunAt(step.offsetMinutes, b.startsAt, now);
      const id = detUuid(`wf:${trigger}:${b.id}:${step.id}`);
      const stale = step.offsetMinutes < 0 && runAt.getTime() < now.getTime() - 60_000;
      const [row] = await db.insert(workflowExecutions).values({
        id, workflowId: wf.id, stepId: step.id, bookingId: b.id, runAt,
        status: stale ? "dead" : "queued", error: stale ? "skipped: scheduled time already passed" : null,
      }).onConflictDoNothing().returning({ id: workflowExecutions.id });
      if (!row) continue;
      created++;
      if (!stale) await enqueueExecution(id, Math.max(0, runAt.getTime() - now.getTime()));
    }
  }
  return created;
}

export function enqueueExecution(executionId: string, delay: number) {
  return enqueue(QUEUES.workflows, { name: "run", data: { executionId } }, { jobId: `wfx-${executionId}`, delay, attempts: MAX_ATTEMPTS.default });
}

export async function processExecution(executionId: string, opts: { attemptsMade: number; isFinal: boolean }): Promise<"sent" | "skipped"> {
  const [row] = await db.select({ x: workflowExecutions, s: workflowSteps, w: workflows }).from(workflowExecutions)
    .leftJoin(workflowSteps, eq(workflowSteps.id, workflowExecutions.stepId))
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .where(eq(workflowExecutions.id, executionId));
  if (!row || row.x.status === "sent" || row.x.status === "dead") return "skipped";
  const mark = (status: "sent" | "failed" | "dead", error: string | null) =>
    db.update(workflowExecutions).set({ status, error }).where(eq(workflowExecutions.id, executionId));

  if (!row.s || !row.w.isActive || !row.x.bookingId) { await mark("dead", "skipped: step removed or workflow disabled"); return "skipped"; }
  const ctx = await loadBookingContext(row.x.bookingId);
  if (!ctx) { await mark("dead", "skipped: booking not found"); return "skipped"; }
  const trigger = row.w.trigger as WorkflowTrigger;
  if ((trigger === "booking_created" || trigger === "booking_rescheduled") && ctx.booking.status !== "confirmed") {
    await mark("dead", `skipped: booking is ${ctx.booking.status}`); return "skipped";
  }
  const cfg = row.s.config as Record<string, unknown>;
  try {
    if (row.s.action === "send_email") {
      const to = String(cfg.to ?? "invitee");
      const recipients = to === "host" ? [ctx.host.email] : to === "both" ? [ctx.invitee.email, ctx.host.email] : [ctx.invitee.email];
      for (const r of recipients) {
        await queueNotification({
          kind: "workflow", bookingId: ctx.booking.id, recipient: r, dedupeKey: `wf:${executionId}:${r.toLowerCase()}`,
          extra: { subject: String(cfg.subject ?? ""), body: String(cfg.body ?? "") },
        });
      }
    } else if (row.s.action === "send_webhook") {
      const url = String(cfg.url ?? "");
      const payload = await buildWebhookPayload({ eventId: executionId, type: `booking.${trigger.replace("booking_", "")}` as EventType, at: new Date().toISOString(), payload: { bookingId: ctx.booking.id } });
      const body = JSON.stringify({ ...payload, workflow: { id: row.w.id, name: row.w.name } });
      const headers: Record<string, string> = {};
      if (typeof cfg.secretEnc === "string") Object.assign(headers, signPayload(decrypt(cfg.secretEnc), body).headers);
      const res = await postJson(url, body, headers);
      if (res.status < 200 || res.status >= 300) throw new HttpStatusError(`HTTP ${res.status}`);
    } else {
      throw new UnrecoverableError(`unknown action ${row.s.action}`);
    }
    await mark("sent", null);
    return "sent";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof SsrfError || err instanceof UnrecoverableError;
    await mark(opts.isFinal || permanent ? "dead" : "failed", msg.slice(0, 500));
    if (permanent && !(err instanceof UnrecoverableError)) throw new UnrecoverableError(msg);
    throw err;
  }
}
