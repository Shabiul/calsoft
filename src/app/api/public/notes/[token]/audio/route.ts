import type { NextRequest } from "next/server";
import { audioNotesConfigured, MAX_CHUNK_BYTES, storeChunk } from "@/server/notetaker/audio";
import { hostNotesBooking } from "@/server/notetaker";
import { getSession } from "@/lib/auth-session";
import { handleError, jsonError, jsonOk } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

/** POST /api/public/notes/:token/audio?upload=<id>&index=<n>  (raw bytes, <= 4 MB) -> stores one part of a meeting recording. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    const limited = await limitOr429(req, "notes-audio", 120, 60);
    if (limited) return limited;
    const bookingId = await hostNotesBooking((await ctx.params).token, (await getSession())?.user.id);
    if (!bookingId) return jsonError("NOT_FOUND", "Notes not found.", 404);
    if (!audioNotesConfigured()) return jsonError("NOT_CONFIGURED", "AI notes are not enabled on this server.", 503);
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_CHUNK_BYTES + 1024) return jsonError("VALIDATION", "Chunk too large.", 413);
    const sp = req.nextUrl.searchParams;
    const data = Buffer.from(await req.arrayBuffer());
    await storeChunk(bookingId, sp.get("upload") ?? "", Number(sp.get("index")), data);
    return jsonOk({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
