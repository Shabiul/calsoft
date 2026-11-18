import { z } from "zod";
import { apiRoute, hideForbidden } from "@/server/api/handler";
import { getEventType } from "@/server/services/event-types";
import { getAvailableSlots } from "@/server/scheduling/slots";
import { AppError } from "@/server/errors";

const MAX_RANGE_MS = 31 * 86_400_000;

export const GET = apiRoute({ scope: "availability:read" }, async (c) => {
  const q = c.query(z.object({
    event_id: z.string().uuid(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
    time_zone: z.string().default("UTC"),
  }));
  const from = new Date(q.from), to = new Date(q.to);
  if (to <= from) throw new AppError("VALIDATION", "'to' must be after 'from'", 422, [{ path: "to", message: "Must be after from" }]);
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new AppError("VALIDATION", "Range may not exceed 31 days", 422, [{ path: "to", message: "Range too large" }]);
  await hideForbidden(getEventType({ userId: c.key.userId }, q.event_id));
  const slots = await getAvailableSlots({ eventTypeId: q.event_id, from, to, inviteeTimeZone: q.time_zone });
  return { data: slots.map((s) => ({ starts_at: s.startsAt, host_user_id: s.hostUserId, ...(s.spotsLeft !== undefined ? { spots_left: s.spotsLeft } : {}) })) };
});
