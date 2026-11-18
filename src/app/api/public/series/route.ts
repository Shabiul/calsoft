import type { NextRequest } from "next/server";
import { z } from "zod";
import { previewSeries } from "@/server/services/booking";
import { loadEventById } from "@/server/public/data";
import { handleError, jsonError, jsonOk } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

const q = z.object({ eventTypeId: z.uuid(), startsAt: z.iso.datetime({ offset: true }) });

/**
 * GET /api/public/series?eventTypeId&startsAt
 * -> { recurrence, timeZone, occurrences: [{ startsAt, endsAt, available }] } for a recurring event, or { recurrence: null }.
 * Dates come from the same engine createBooking uses (host time zone, Luxon calendar arithmetic).
 */
export async function GET(req: NextRequest) {
  try {
    const limited = await limitOr429(req, "series", 60, 60);
    if (limited) return limited;
    const sp = req.nextUrl.searchParams;
    const p = q.parse({ eventTypeId: sp.get("eventTypeId"), startsAt: sp.get("startsAt") });
    const event = await loadEventById(p.eventTypeId);
    if (!event) return jsonError("NOT_FOUND", "This event is not available.", 404);
    const preview = await previewSeries(event.id, p.startsAt);
    return jsonOk(preview ?? { recurrence: null, occurrences: [] });
  } catch (e) {
    return handleError(e);
  }
}
