"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-session";
import { runAction, type ActionResult } from "@/lib/validation/action-result";
import { idSchema } from "@/lib/validation/event-types";
import { AppError } from "@/server/errors";
import {
  createBlockedTime, createSchedule, deleteBlockedTime, deleteSchedule, duplicateSchedule, saveSchedule, setDefaultSchedule,
} from "@/server/services/availability";

const refresh = () => {
  revalidatePath("/dashboard/availability");
  revalidatePath("/dashboard/event-types");
};
function id(v: unknown): string {
  const r = idSchema.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION", "Invalid id", 422);
  return r.data;
}

export async function createScheduleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return runAction(async () => {
    const s = await createSchedule(user.id, input);
    refresh();
    return { id: s.id };
  });
}

export async function saveScheduleAction(scheduleId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return runAction(async () => {
    const s = await saveSchedule(user.id, id(scheduleId), input);
    refresh();
    revalidatePath(`/dashboard/availability/${s.id}`);
    return { id: s.id };
  });
}

export async function setDefaultScheduleAction(scheduleId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await setDefaultSchedule(user.id, id(scheduleId));
    refresh();
    return null;
  });
}

export async function duplicateScheduleAction(scheduleId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return runAction(async () => {
    const s = await duplicateSchedule(user.id, id(scheduleId));
    refresh();
    return { id: s.id };
  });
}

export async function deleteScheduleAction(scheduleId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await deleteSchedule(user.id, id(scheduleId));
    refresh();
    return null;
  });
}

export async function createBlockedTimeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return runAction(async () => {
    const b = await createBlockedTime(user.id, input);
    refresh();
    return { id: b.id };
  });
}

export async function deleteBlockedTimeAction(blockedId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await deleteBlockedTime(user.id, id(blockedId));
    refresh();
    return null;
  });
}
