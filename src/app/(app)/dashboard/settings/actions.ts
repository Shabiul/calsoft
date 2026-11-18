"use server";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { requireUser } from "@/lib/auth-session";
import { runAction, type ActionResult } from "@/lib/validation/action-result";
import { db, schema } from "@/server/db";
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
    const [cred] = await db.select({ password: schema.accounts.password }).from(schema.accounts)
      .where(and(eq(schema.accounts.userId, user.id), eq(schema.accounts.providerId, "credential")));
    if (cred?.password) {
      const ctx = await auth.$context;
      const ok = await ctx.password.verify({ hash: cred.password, password: confirm });
      if (!ok) throw new AppError("FORBIDDEN", "Incorrect password.", 403);
    } else if (confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw new AppError("FORBIDDEN", "Type your email address to confirm.", 403);
    }
    await deleteAccount(user.id);
    return null;
  });
}
