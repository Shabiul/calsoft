import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleError, jsonError, jsonOk, readJson } from "@/server/public/http";
import { limitOr429 } from "@/server/ratelimit";
import { submitPublicForm } from "@/server/services/routing-forms";

const body = z.object({
  username: z.string().trim().min(1).max(64),
  slug: z.string().trim().min(1).max(64),
  answers: z.record(z.string().max(64), z.union([z.string().max(2000), z.array(z.string().max(500)).max(50)])),
});

/**
 * POST /api/public/routing  { username, slug, answers }
 * -> 200 { result: { kind:"redirect", url, external } | { kind:"message", title, message } }
 * -> 400 VALIDATION with field errors | 404 | 429
 */
export async function POST(req: NextRequest) {
  try {
    const limited = await limitOr429(req, "routing", 20, 60);
    if (limited) return limited;
    let raw: unknown;
    try { raw = await readJson(req); } catch { return jsonError("VALIDATION", "Request body too large.", 413); }
    const b = body.parse(raw);
    if (Object.keys(b.answers).length > 40) return jsonError("VALIDATION", "Too many answers.", 400);
    const r = await submitPublicForm(b.username, b.slug, b.answers);
    if (!r.ok) return jsonError("VALIDATION", "Please check the highlighted fields.", 400, r.errors);
    return jsonOk({ result: r.result });
  } catch (e) {
    return handleError(e);
  }
}
