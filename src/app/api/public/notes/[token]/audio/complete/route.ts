import type { NextRequest } from "next/server";
import { z } from "zod";
import { audioNotesConfigured, finishUpload, isUploadId, MAX_CHUNKS } from "@/server/notetaker/audio";
import { hostNotesBooking } from "@/server/notetaker";
import { getSession } from "@/lib/auth-session";
import { handleError, jsonError, jsonOk, readJson } from "@/server/public/http";
import { limitOr429, rateLimit } from "@/server/ratelimit";

const body = z.object({
  upload: z.string().refine(isUploadId), chunks: z.number().int().min(1).max(MAX_CHUNKS), mime: z.string().min(3).max(100),
  consent: z.literal(true, { error: "Confirm that everyone knows the meeting is being recorded" }),
});

/** POST /api/public/notes/:token/audio/complete -> all parts uploaded: queue Gemini transcription + notes. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    const limited = await limitOr429(req, "notes-audio-done", 30, 60);
    if (limited) return limited;
    const bookingId = await hostNotesBooking((await ctx.params).token, (await getSession())?.user.id);
    if (!bookingId) return jsonError("NOT_FOUND", "Notes not found.", 404);
    if (!audioNotesConfigured()) return jsonError("NOT_CONFIGURED", "AI notes are not enabled on this server.", 503);
    const v = body.safeParse(await readJson(req, 10_000));
    if (!v.success) return jsonError("VALIDATION", v.error.issues[0]?.message ?? "Invalid request.", 422);
    // Each meeting can be processed a few times (re-record / fix), not endlessly (Gemini costs money).
    const rl = await rateLimit("notes-audio-booking", bookingId, 4, 86_400);
    if (!rl.ok) return jsonError("RATE_LIMITED", "This meeting already had several recordings processed today.", 429);
    await finishUpload({ bookingId, uploadId: v.data.upload, chunks: v.data.chunks, mime: v.data.mime });
    return jsonOk({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
