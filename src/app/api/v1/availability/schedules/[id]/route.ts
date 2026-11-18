import { z } from "zod";
import { apiRoute, hideForbidden, requireUuid } from "@/server/api/handler";
import { scheduleOut } from "@/server/api/schedule-shape";
import { deleteSchedule, getSchedule, saveSchedule } from "@/server/services/availability";

type P = { id: string };

export const GET = apiRoute<P>({ scope: "availability:read" }, async (c) =>
  scheduleOut(await hideForbidden(getSchedule(c.key.userId, requireUuid(c.params.id, "Schedule")))));

export const PUT = apiRoute<P>({ scope: "availability:write" }, async (c) => {
  const id = requireUuid(c.params.id, "Schedule");
  const b = await c.body(z.object({ name: z.string(), time_zone: z.string(), rules: z.array(z.unknown()), overrides: z.array(z.unknown()).optional() }));
  const s = await hideForbidden(saveSchedule(c.key.userId, id, { name: b.name, timeZone: b.time_zone, rules: b.rules, overrides: b.overrides }));
  c.setAudit("schedule.updated", { type: "availability_schedule", id });
  return scheduleOut(s);
});

export const DELETE = apiRoute<P>({ scope: "availability:write" }, async (c) => {
  const id = requireUuid(c.params.id, "Schedule");
  await hideForbidden(deleteSchedule(c.key.userId, id));
  c.setAudit("schedule.deleted", { type: "availability_schedule", id });
  return new Response(null, { status: 204 });
});
