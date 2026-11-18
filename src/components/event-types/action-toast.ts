"use client";
import { toast } from "@/components/ui";
import type { ActionResult } from "@/lib/validation/action-result";

/** Show an error toast for a failed action result. Returns data on success, or null on failure. */
export function unwrap<T>(res: ActionResult<T>, successMessage?: string): { data: T } | null {
  if (res.ok) {
    if (successMessage) toast.success(successMessage);
    return { data: res.data };
  }
  toast.error(res.error.message);
  return null;
}
