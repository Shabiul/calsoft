import type { NextRequest } from "next/server";
import { loadBookingView, LOCATION_LABELS } from "@/server/public/data";
import { generateIcs } from "@/server/public/ics";
import { limitOr429 } from "@/server/ratelimit";
import { jsonError } from "@/server/public/http";

/** GET /api/public/ics/:manageToken -> .ics download for the booking (token = capability). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await limitOr429(req, "ics", 60, 60);
  if (limited) return limited;
  const { token } = await ctx.params;
  const v = await loadBookingView(token);
  if (!v) return jsonError("NOT_FOUND", "Booking not found.", 404);
  const base = (process.env.APP_URL || req.nextUrl.origin).replace(/\/$/, "");
  const location = v.meetingUrl ?? v.event.locationAddress ?? LOCATION_LABELS[v.locationType ?? v.event.locationType] ?? null;
  const ics = generateIcs({
    uid: `${v.id}@meetflow`,
    title: `${v.event.title} with ${v.event.host.name}`,
    description: v.event.description,
    location,
    startsAt: v.startsAt, endsAt: v.endsAt,
    url: `${base}/booking/${token}`,
    organizerName: v.event.host.name,
    attendeeEmail: v.invitee?.email,
    cancelled: v.status === "cancelled" || v.status === "rescheduled" || v.status === "expired",
  });
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="meeting-${v.id.slice(0, 8)}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
