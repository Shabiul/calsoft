"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { AppError } from "@/server/errors";
import { runSafe } from "@/server/workflows/run-action";
import { createApiKey, revokeApiKey } from "@/server/api-keys";

const createSchema = z.object({ name: z.string().trim().min(1, "Name is required").max(80), scopes: z.array(z.string()).min(1, "Select at least one scope") });

export async function createApiKeyAction(input: unknown) {
  const user = await requireUser();
  return runSafe(async () => {
    const data = createSchema.parse(input);
    const r = await createApiKey(user.id, data);
    revalidatePath("/dashboard/settings/api-keys");
    return { id: r.apiKey.id, key: r.key };
  });
}
export async function revokeApiKeyAction(keyId: string) {
  const user = await requireUser();
  return runSafe(async () => {
    const parsed = z.string().uuid().safeParse(keyId);
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid id", 422);
    await revokeApiKey(user.id, parsed.data);
    revalidatePath("/dashboard/settings/api-keys");
    return null;
  });
}
