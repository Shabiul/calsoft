import { ZodError } from "zod";
import { AppError } from "@/server/errors";
import { runAction, type ActionResult } from "@/lib/validation/action-result";

/** runAction + ZodError -> VALIDATION result with field issues. */
export function runSafe<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  return runAction(async () => {
    try { return await fn(); } catch (e) {
      if (e instanceof ZodError) {
        throw new AppError("VALIDATION", e.issues[0]?.message ?? "Invalid input", 422, e.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      }
      throw e;
    }
  });
}
