import { z } from "zod";
import { apiRoute, created, paginateSorted, paginationQuery } from "@/server/api/handler";
import { createSchedule, listSchedules } from "@/server/services/availability";
import { scheduleOut } from "@/server/api/schedule-shape";

export const GET = apiRoute({ scope: "availability:read" }, async (c) => {
  const q = c.query(paginationQuery);
  const rows = (await listSchedules(c.key.userId)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1));
  const p = paginateSorted(rows, q, (r) => [r.updatedAt, r.id]);
  return { ...p, data: p.data.map((s) => scheduleOut(s)) };
});

export const POST = apiRoute({ scope: "availability:write" }, async (c) => {
  const b = await c.body(z.object({ name: z.string(), time_zone: z.string(), template: z.enum(["weekdays_9_5", "empty"]).optional() }));
  const s = await createSchedule(c.key.userId, { name: b.name, timeZone: b.time_zone, template: b.template });
  c.setAudit("schedule.created", { type: "availability_schedule", id: s.id });
  return created(scheduleOut(s));
});
