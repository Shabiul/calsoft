import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { eventTypes, workflowExecutions, workflows, workflowSteps } from "@/server/db/schema";
import { encrypt } from "@/lib/crypto";
import { AppError } from "@/server/errors";
import { WORKFLOW_ACTIONS, WORKFLOW_TRIGGERS } from "@/server/webhooks/events";
import { assertUrlAllowed, SsrfError } from "@/server/webhooks/ssrf";

export const workflowStepSchema = z.object({
  action: z.enum(WORKFLOW_ACTIONS),
  /** >=0 minutes after trigger; <0 minutes before the meeting starts */
  offsetMinutes: z.number().int().min(-60 * 24 * 30).max(60 * 24 * 90),
  to: z.enum(["invitee", "host", "both"]).optional(),
  subject: z.string().max(200).optional(),
  body: z.string().max(5000).optional(),
  /** Attach the calendar invite (.ics) to the email (a cancellation invite for cancelled bookings). */
  attachIcs: z.boolean().optional(),
  url: z.string().max(2000).optional(),
  secret: z.string().max(200).optional(),
  /** kept when editing an existing webhook step without re-entering the secret */
  secretEnc: z.string().optional(),
}).superRefine((s, ctx) => {
  if (s.action === "send_email") {
    if (!s.subject?.trim()) ctx.addIssue({ code: "custom", path: ["subject"], message: "Subject is required" });
    if (!s.body?.trim()) ctx.addIssue({ code: "custom", path: ["body"], message: "Body is required" });
  } else if (!s.url?.trim()) ctx.addIssue({ code: "custom", path: ["url"], message: "URL is required" });
});
export const workflowInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  trigger: z.enum(WORKFLOW_TRIGGERS),
  eventTypeIds: z.array(z.string().uuid()).nullable().optional(),
  isActive: z.boolean().optional(),
  steps: z.array(workflowStepSchema).min(1, "Add at least one step").max(10),
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

function stepConfig(s: z.infer<typeof workflowStepSchema>): Record<string, unknown> {
  if (s.action === "send_email") return { to: s.to ?? "invitee", subject: s.subject, body: s.body, attachIcs: s.attachIcs === true };
  try { assertUrlAllowed(s.url!); } catch (e) { if (e instanceof SsrfError) throw new AppError("VALIDATION", e.message, 422); throw e; }
  const cfg: Record<string, unknown> = { url: s.url };
  if (s.secret) cfg.secretEnc = encrypt(s.secret);
  else if (s.secretEnc) cfg.secretEnc = s.secretEnc;
  return cfg;
}

async function assertEventTypesOwned(userId: string, ids: string[] | null | undefined) {
  if (!ids?.length) return;
  const rows = await db.select({ id: eventTypes.id }).from(eventTypes).where(and(inArray(eventTypes.id, ids), eq(eventTypes.ownerUserId, userId)));
  if (rows.length !== new Set(ids).size) throw new AppError("FORBIDDEN", "Unknown event type", 403);
}

export async function createWorkflow(userId: string, raw: unknown) {
  const input = workflowInputSchema.parse(raw);
  await assertEventTypesOwned(userId, input.eventTypeIds);
  return db.transaction(async (tx) => {
    const [wf] = await tx.insert(workflows).values({
      ownerUserId: userId, name: input.name, trigger: input.trigger,
      eventTypeIds: input.eventTypeIds?.length ? input.eventTypeIds : null, isActive: input.isActive ?? true,
    }).returning();
    await tx.insert(workflowSteps).values(input.steps.map((s, i) => ({
      workflowId: wf.id, position: i, action: s.action, offsetMinutes: s.offsetMinutes, config: stepConfig(s),
    })));
    return wf;
  });
}

export async function updateWorkflow(userId: string, id: string, raw: unknown) {
  const input = workflowInputSchema.parse(raw);
  await getOwned(userId, id);
  await assertEventTypesOwned(userId, input.eventTypeIds);
  await db.transaction(async (tx) => {
    await tx.update(workflows).set({
      name: input.name, trigger: input.trigger, eventTypeIds: input.eventTypeIds?.length ? input.eventTypeIds : null,
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    }).where(eq(workflows.id, id));
    // Steps are replaced; past executions keep history (step_id is set null).
    await tx.delete(workflowSteps).where(eq(workflowSteps.workflowId, id));
    await tx.insert(workflowSteps).values(input.steps.map((s, i) => ({
      workflowId: id, position: i, action: s.action, offsetMinutes: s.offsetMinutes, config: stepConfig(s),
    })));
  });
}

async function getOwned(userId: string, id: string) {
  const [wf] = await db.select().from(workflows).where(and(eq(workflows.id, id), eq(workflows.ownerUserId, userId)));
  if (!wf) throw new AppError("NOT_FOUND", "Workflow not found", 404);
  return wf;
}

export async function setWorkflowActive(userId: string, id: string, isActive: boolean) {
  await getOwned(userId, id);
  await db.update(workflows).set({ isActive }).where(eq(workflows.id, id));
}
export async function deleteWorkflow(userId: string, id: string) {
  await getOwned(userId, id);
  await db.delete(workflows).where(eq(workflows.id, id));
}

export async function listWorkflows(userId: string) {
  const wfs = await db.select().from(workflows).where(eq(workflows.ownerUserId, userId)).orderBy(desc(workflows.createdAt));
  if (!wfs.length) return [];
  const steps = await db.select().from(workflowSteps).where(inArray(workflowSteps.workflowId, wfs.map((w) => w.id)));
  const execs = await db.select({ workflowId: workflowExecutions.workflowId, status: workflowExecutions.status })
    .from(workflowExecutions).where(inArray(workflowExecutions.workflowId, wfs.map((w) => w.id)));
  return wfs.map((w) => ({
    ...w,
    stepCount: steps.filter((s) => s.workflowId === w.id).length,
    executions: execs.filter((e) => e.workflowId === w.id).length,
    failedExecutions: execs.filter((e) => e.workflowId === w.id && (e.status === "failed" || e.status === "dead")).length,
  }));
}

/** Editable shape for the builder form (secrets never leave the server). */
export async function getWorkflowForEdit(userId: string, id: string) {
  const wf = await getOwned(userId, id);
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, id)).orderBy(workflowSteps.position);
  return {
    id: wf.id, name: wf.name, trigger: wf.trigger, eventTypeIds: wf.eventTypeIds ?? [], isActive: wf.isActive,
    steps: steps.map((s) => {
      const c = s.config as Record<string, string | boolean | undefined>;
      return { action: s.action, offsetMinutes: s.offsetMinutes, to: c.to as string | undefined, subject: c.subject as string | undefined, body: c.body as string | undefined, attachIcs: c.attachIcs === true, url: c.url as string | undefined, secretEnc: c.secretEnc as string | undefined, hasSecret: !!c.secretEnc };
    }),
  };
}

export async function listEventTypeOptions(userId: string) {
  return db.select({ id: eventTypes.id, title: eventTypes.title }).from(eventTypes).where(eq(eventTypes.ownerUserId, userId)).orderBy(eventTypes.title);
}

export async function recentExecutions(userId: string, workflowId: string, limit = 20) {
  await getOwned(userId, workflowId);
  return db.select().from(workflowExecutions).where(eq(workflowExecutions.workflowId, workflowId)).orderBy(desc(workflowExecutions.createdAt)).limit(limit);
}
