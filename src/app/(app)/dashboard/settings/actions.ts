"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-session";
import { runAction, type ActionResult } from "@/lib/validation/action-result";
import { AppError } from "@/server/errors";
import { deleteAccount, updateProfile } from "@/server/services/account";
import { checkUsername, type UsernameAvailability } from "@/server/services/username";
import { rateLimit } from "@/server/ratelimit";

export async function saveProfileAction(input: unknown): Promise<ActionResult<{ username: string }>> {
  return runAction(async () => {
    const user = await requireUser();
    const res = await updateProfile(user.id, input);
    revalidatePath("/dashboard", "layout");
    return res;
  });
}

export async function checkUsernameAction(username: string): Promise<UsernameAvailability> {
  const user = await requireUser();
  return checkUsername(username, user.id);
}

/** Verifies the account password (or, for OAuth-only accounts, that the typed email matches) then soft-deletes. */
export async function deleteAccountAction(confirm: string): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();
    const rl = await rateLimit("delete-account", user.id, 5, 600);
    if (!rl.ok) throw new AppError("RATE_LIMITED", "Too many attempts. Try again later.", 429);
    // Sign-in is Zoho only (no passwords), so confirmation is typing the account email.
    if (confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw new AppError("FORBIDDEN", "Type your email address to confirm.", 403);
    }
    await deleteAccount(user.id);
    return null;
  });
}
