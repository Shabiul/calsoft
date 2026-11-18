import { z } from "zod";
import { apiRoute } from "@/server/api/handler";
import { getBookingFor } from "@/server/api/resources";
import { cancelBooking } from "@/server/services/booking";
import { AppError } from "@/server/errors";

const body = z.object({ reason: z.string().max(1000).optional(), scope: z.enum(["occurrence", "series"]).optional() });

export const POST = apiRoute<{ id: string }>({ scope: "bookings:write" }, async (c) => {
  const text = (await c.req.text()).trim();
  let reason: string | undefined;
  let scope: "occurrence" | "series" | undefined;
  if (text) {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new AppError("VALIDATION", "Request body must be valid JSON", 422, [{ path: "", message: "Invalid JSON" }]); }
    const r = body.safeParse(raw);
    if (!r.success) throw new AppError("VALIDATION", "Invalid request body", 422, r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    reason = r.data.reason; scope = r.data.scope;
  }
  await getBookingFor(c.key, c.params.id); // tenant check (404 if not yours)
  await cancelBooking({ bookingId: c.params.id, actor: "host", actorId: c.key.userId, reason, scope });
  c.setAudit("booking.cancelled", { type: "booking", id: c.params.id });
  return getBookingFor(c.key, c.params.id);
});
