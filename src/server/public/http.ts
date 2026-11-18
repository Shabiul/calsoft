import { ZodError } from "zod";
import { isAppError } from "@/server/errors";

const NO_STORE = { "Cache-Control": "no-store" };

export function jsonOk(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return Response.json(data, { status: init?.status ?? 200, headers: { ...NO_STORE, ...init?.headers } });
}

export function jsonError(code: string, message: string, status: number, details?: unknown) {
  return Response.json({ error: { code, message, details } }, { status, headers: NO_STORE });
}

/** Maps any thrown value to a safe JSON response (never leaks internals). */
export function handleError(e: unknown): Response {
  if (e instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const i of e.issues) fields[i.path.join(".") || "_"] = i.message;
    return jsonError("VALIDATION", "Please check the highlighted fields.", 400, fields);
  }
  if (isAppError(e)) {
    // 5xx messages may contain internals -> generic.
    if (e.status >= 500) return jsonError("INTERNAL", "Something went wrong. Please try again.", e.status);
    return jsonError(e.code, e.message, e.status, e.details);
  }
  console.error("[public-api]", e);
  return jsonError("INTERNAL", "Something went wrong. Please try again.", 500);
}

export async function readJson(req: Request, maxBytes = 32_000): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw Object.assign(new Error("Payload too large"), { tooLarge: true });
  try { return JSON.parse(text); } catch { return null; }
}
