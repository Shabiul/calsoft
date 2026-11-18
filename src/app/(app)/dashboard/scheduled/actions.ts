"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { runAction, type ActionResult } from "@/lib/validation/action-result";
import { AppError } from "@/server/errors";
import { approveScheduled, cancelScheduled, declineScheduled, getRescheduleSlots, markScheduled, rescheduleScheduled, setHostNotes } from "@/server/services/scheduled";

const uuid = z.string().uuid();
function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Invalid input", 422);
  return r.data;
}
const refresh = () => { revalidatePath("/dashboard/scheduled"); revalidatePath("/dashboard"); };

export async function saveNotesAction(bookingId: string, notes: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await setHostNotes(user.id, parse(uuid, bookingId), parse(z.string().max(5000), notes));
    refresh();
    return null;
  });
}

export async function cancelBookingAction(bookingId: string, reason: string, scope: "occurrence" | "series" = "occurrence"): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await cancelScheduled(user.id, parse(uuid, bookingId), parse(z.string().max(500), reason ?? ""), parse(z.enum(["occurrence", "series"]), scope));
    refresh();
    return null;
  });
}

export async function approveBookingAction(bookingId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await approveScheduled(user.id, parse(uuid, bookingId));
    refresh();
    return null;
  });
}

export async function declineBookingAction(bookingId: string, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await declineScheduled(user.id, parse(uuid, bookingId), parse(z.string().max(500), reason ?? ""));
    refresh();
    return null;
  });
}

export async function markBookingAction(bookingId: string, status: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await markScheduled(user.id, parse(uuid, bookingId), parse(z.enum(["completed", "no_show", "confirmed"]), status));
    refresh();
    return null;
  });
}

export async function rescheduleBookingAction(bookingId: string, newStartsAt: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return runAction(async () => {
    const r = await rescheduleScheduled(user.id, parse(uuid, bookingId), parse(z.string().datetime(), newStartsAt));
    refresh();
    return { id: r.booking.id };
  });
}

/** Open slots for a given calendar day (YYYY-MM-DD in `timeZone`), excluding the booking being moved. */
export async function rescheduleSlotsAction(bookingId: string, date: string, timeZone: string): Promise<ActionResult<{ slots: string[] }>> {
  const user = await requireUser();
  return runAction(async () => {
    const d = parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), date);
    const tz = parse(z.string().max(64), timeZone);
    const { DateTime } = await import("luxon");
    const start = DateTime.fromISO(d, { zone: tz });
    if (!start.isValid) throw new AppError("VALIDATION", "Invalid date or time zone", 422);
    const slots = await getRescheduleSlots(user.id, parse(uuid, bookingId), start.toJSDate(), start.plus({ days: 1 }).toJSDate());
    return { slots };
  });
}
