import type { NextRequest } from "next/server";
import { getNotes, recordingUrls, verifyNotesToken } from "@/server/notetaker";
import { handleError, jsonError } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

/** GET /api/public/notes/:token/media/(video|audio) -> 302 to a fresh Recall download URL (they expire, so never stored). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string; kind: string }> }) {
  try {
    const limited = await limitOr429(req, "notes-media", 60, 60);
    if (limited) return limited;
    const { token, kind } = await ctx.params;
    const bookingId = verifyNotesToken(token);
    if (!bookingId || (kind !== "video" && kind !== "audio")) return jsonError("NOT_FOUND", "Not found.", 404);
    const n = await getNotes(bookingId);
    if (!n.botId) return jsonError("NOT_FOUND", "No recording for this meeting.", 404);
    if (n.recordingExpiresAt && n.recordingExpiresAt <= new Date()) return jsonError("GONE", "The recording was deleted after the retention period.", 410);
    const url = (await recordingUrls(n.botId))[kind];
    if (!url) return jsonError("NOT_FOUND", "The recording is not available.", 404);
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (e) {
    return handleError(e);
  }
}
