import { isAppError } from "@/server/errors";

export type FieldIssue = { path: string; message: string };
export type ActionResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; issues?: FieldIssue[] } };

/** Run a server-action body and map thrown AppError / unexpected errors to a structured result (never leaks internals). */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (isAppError(e)) {
      const issues = Array.isArray(e.details) ? (e.details as FieldIssue[]) : undefined;
      return { ok: false, error: { code: e.code, message: e.message, issues } };
    }
    // Next.js control-flow errors (redirect/notFound) must propagate
    if (e && typeof e === "object" && "digest" in e && typeof (e as { digest: unknown }).digest === "string" && /^NEXT_/.test((e as { digest: string }).digest)) throw e;
    console.error("[action] unexpected error", e);
    return { ok: false, error: { code: "INTERNAL", message: "Something went wrong. Please try again." } };
  }
}
