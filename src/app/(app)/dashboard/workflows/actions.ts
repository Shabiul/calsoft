"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { AppError } from "@/server/errors";
import { createWorkflow, deleteWorkflow, setWorkflowActive, updateWorkflow } from "@/server/workflows/service";
import { runSafe } from "@/server/workflows/run-action";

const idSchema = z.string().uuid();
const id = (v: unknown) => {
  const r = idSchema.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION", "Invalid id", 422);
  return r.data;
};

export async function createWorkflowAction(input: unknown) {
  const user = await requireUser();
  return runSafe(async () => {
    const wf = await createWorkflow(user.id, input);
    revalidatePath("/dashboard/workflows");
    return { id: wf.id };
  });
}
export async function updateWorkflowAction(workflowId: string, input: unknown) {
  const user = await requireUser();
  return runSafe(async () => {
    await updateWorkflow(user.id, id(workflowId), input);
    revalidatePath("/dashboard/workflows");
    revalidatePath(`/dashboard/workflows/${workflowId}`);
    return null;
  });
}
export async function setWorkflowActiveAction(workflowId: string, active: boolean) {
  const user = await requireUser();
  return runSafe(async () => {
    await setWorkflowActive(user.id, id(workflowId), !!active);
    revalidatePath("/dashboard/workflows");
    return null;
  });
}
export async function deleteWorkflowAction(workflowId: string) {
  const user = await requireUser();
  return runSafe(async () => {
    await deleteWorkflow(user.id, id(workflowId));
    revalidatePath("/dashboard/workflows");
    return null;
  });
}
