import { maskedMeetingUrl } from "@/server/public/join";
import type { NextRequest } from "next/server";
import { createBooking } from "@/server/services/booking";
import { meetLinkExpected } from "@/server/integrations/meet-pending";
import { loadEventById } from "@/server/public/data";
import { bookBodySchema, validateAnswers } from "@/server/public/schemas";
import { handleError, jsonError, jsonOk, readJson } from "@/server/public/http";
import { limitOr429, rateLimit } from "@/server/ratelimit";

/**
 * POST /api/public/book
 * Body: { eventTypeId, startsAt, invitee:{name,email,phone?,timeZone}, answers?, guests?, idempotencyKey, consent:true }
 * -> 201 { booking:{id,startsAt,endsAt,status,meetingUrl}, manageToken, requiresPayment } | 409 SLOT_UNAVAILABLE
 */
export async function POST(req: NextRequest) {
  try {
    const limited = await limitOr429(req, "book", 15, 60);
    if (limited) return limited;

    let raw: unknown;
    try { raw = await readJson(req); } catch { return jsonError("VALIDATION", "Request body too large.", 413); }
    const body = bookBodySchema.parse(raw);

    // Per-email throttle (stops one address from being used to spam hosts).
    const perEmail = await rateLimit("book-email", `${body.invitee.email}`, 10, 3600);
    if (!perEmail.ok) return jsonError("RATE_LIMITED", "Too many booking attempts for this email. Try again later.", 429);

    const event = await loadEventById(body.eventTypeId);
    if (!event) return jsonError("NOT_FOUND", "This event is not available for booking.", 404);

    const v = validateAnswers(event.questions, body.answers);
    if (!v.ok) return jsonError("VALIDATION", "Please check the highlighted fields.", 400, v.errors);

    const res = await createBooking({
      eventTypeId: event.id,
      startsAt: body.startsAt,
      invitee: body.invitee,
      answers: body.answers,
      idempotencyKey: body.idempotencyKey,
      guests: body.guests, // stored as extra invitees before booking events fire, so every attendee gets the emails/invites
      actor: "invitee",
      contextToken: body.context,
    });

    const b = res.booking;
    return jsonOk({
      booking: {
        id: b.id, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), status: b.status,
        meetingUrl: b.status === "confirmed" ? maskedMeetingUrl(b) : null,
      },
      manageToken: res.manageToken,
      // Recurring series: every occurrence (manage tokens are only available at creation, never on replay).
      series: res.series?.map((s) => ({ id: s.booking.id, startsAt: s.booking.startsAt.toISOString(), endsAt: s.booking.endsAt.toISOString(), status: s.booking.status, manageToken: s.manageToken })),
      requiresPayment: b.status === "pending_payment",
      meetPending: !res.idempotentReplay && (await meetLinkExpected(b)),
      replay: !!res.idempotentReplay,
    }, { status: res.idempotentReplay ? 200 : 201 });
  } catch (e) {
    return handleError(e);
  }
}
