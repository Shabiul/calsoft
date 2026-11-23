"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { runAction, type ActionResult } from "@/lib/validation/action-result";
import { AppError } from "@/server/errors";
import { approveScheduled, cancelScheduled, declineScheduled, getRescheduleSlots, markScheduled, rescheduleScheduled, scheduleMeeting, getScheduleSlots, getMeetingUrl, setHostNotes, createContextLink } from "@/server/services/scheduled";

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

const tz = z.string().min(1).max(64);
const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email").max(254));

export async function getScheduleSlotsAction(eventTypeId: string, fromIso: string, toIso: string, timeZone: string): Promise<ActionResult<string[]>> {
  const user = await requireUser();
  return runAction(() => getScheduleSlots(user.id, parse(uuid, eventTypeId), new Date(parse(z.iso.datetime({ offset: true }), fromIso)), new Date(parse(z.iso.datetime({ offset: true }), toIso)), parse(tz, timeZone)));
}

export async function createContextLinkAction(eventTypeId: string, notes: string): Promise<ActionResult<{ token: string }>> {
  const user = await requireUser();
  return runAction(async () => ({ token: await createContextLink(user.id, parse(uuid, eventTypeId), parse(z.string().max(5000), notes)) }));
}

export async function getMeetingUrlAction(bookingId: string): Promise<ActionResult<{ meetingUrl: string | null }>> {
  const user = await requireUser();
  return runAction(async () => ({ meetingUrl: await getMeetingUrl(user.id, parse(uuid, bookingId)) }));
}

export async function scheduleMeetingAction(input: unknown): Promise<ActionResult<{ bookingId: string; meetPending: boolean }>> {
  const user = await requireUser();
  return runAction(async () => {
    const v = parse(z.object({
      eventTypeId: uuid, startsAt: z.iso.datetime({ offset: true }), timeZone: tz,
      invitee: z.object({ name: z.string().trim().min(1, "Name is required").max(120), email, phone: z.string().trim().max(40).optional() }),
      guests: z.array(email).max(10).default([]),
      context: z.string().max(5000).optional(),
    }), input);
    const r = await scheduleMeeting(user.id, v);
    refresh();
    return r;
  });
}
