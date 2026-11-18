"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-session";
import { runAction, type ActionResult } from "@/lib/validation/action-result";
import { acceptInvitation } from "@/server/services/organizations";

export async function acceptInvitationAction(token: string): Promise<ActionResult<{ organizationId: string; slug: string }>> {
  const user = await requireUser();
  return runAction(async () => {
    const r = await acceptInvitation(user.id, String(token ?? "").slice(0, 200));
    revalidatePath("/dashboard/teams");
    revalidatePath("/dashboard/event-types");
    return { organizationId: r.organizationId, slug: r.slug };
  });
}
