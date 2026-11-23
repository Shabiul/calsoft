import type { NextRequest } from "next/server";
import { z } from "zod";
import { saveNotes, hostNotesBooking } from "@/server/notetaker";
import { getSession } from "@/lib/auth-session";
import { handleError, jsonError, jsonOk, readJson } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";

const body = z.object({ content: z.string().max(100_000), baseUpdatedAt: z.string().nullable() });

/** PUT /api/public/notes/:token -> save the shared meeting notes (409 + latest when someone else saved first). */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    const limited = await limitOr429(req, "notes-put", 120, 60);
    if (limited) return limited;
    const bookingId = await hostNotesBooking((await ctx.params).token, (await getSession())?.user.id);
    if (!bookingId) return jsonError("NOT_FOUND", "Notes not found.", 404);
    const v = body.safeParse(await readJson(req, 200_000));
    if (!v.success) return jsonError("VALIDATION", "Invalid notes.", 422);
    const r = await saveNotes(bookingId, v.data.content, v.data.baseUpdatedAt);
    return r.ok ? jsonOk({ updatedAt: r.updatedAt }) : jsonError("CONFLICT", "Someone else updated the notes.", 409, r.latest);
  } catch (e) {
    return handleError(e);
  }
}
