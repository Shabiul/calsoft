"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { runAction, type ActionResult } from "@/lib/validation/action-result";
import { idSchema } from "@/lib/validation/event-types";
import {
  createEventType, deleteEventType, duplicateEventType, setEventTypeActive, setEventTypeArchived, updateEventType,
} from "@/server/services/event-types";
import { AppError } from "@/server/errors";

const refresh = () => {
  revalidatePath("/dashboard/event-types");
  revalidatePath("/dashboard/booking-links");
};

function id(v: unknown): string {
  const r = idSchema.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION", "Invalid event type id", 422);
  return r.data;
}

export async function createEventTypeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return runAction(async () => {
    const et = await createEventType({ userId: user.id }, input);
    refresh();
    return { id: et.id };
  });
}

export async function updateEventTypeAction(eventTypeId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return runAction(async () => {
    const et = await updateEventType({ userId: user.id }, id(eventTypeId), input);
    refresh();
    revalidatePath(`/dashboard/event-types/${et.id}`);
    return { id: et.id };
  });
}

export async function duplicateEventTypeAction(eventTypeId: string, opts?: { oneOff?: boolean }): Promise<ActionResult<{ id: string; slug: string }>> {
  const user = await requireUser();
  const o = z.object({ oneOff: z.boolean().optional() }).parse(opts ?? {});
  return runAction(async () => {
    const et = await duplicateEventType({ userId: user.id }, id(eventTypeId), o);
    refresh();
    return { id: et.id, slug: et.slug };
  });
}

export async function archiveEventTypeAction(eventTypeId: string, archived: boolean): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await setEventTypeArchived({ userId: user.id }, id(eventTypeId), z.boolean().parse(archived));
    refresh();
    return null;
  });
}

export async function toggleEventTypeActiveAction(eventTypeId: string, isActive: boolean): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await setEventTypeActive({ userId: user.id }, id(eventTypeId), z.boolean().parse(isActive));
    refresh();
    return null;
  });
}

export async function deleteEventTypeAction(eventTypeId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await deleteEventType({ userId: user.id }, id(eventTypeId));
    refresh();
    return null;
  });
}
