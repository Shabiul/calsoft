"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-session";
import { runAction, type ActionResult } from "@/lib/validation/action-result";
import { AppError } from "@/server/errors";
import { cancelMySubscription, startUpgradeCheckout } from "@/server/payments/billing";
import { rateLimit } from "@/server/ratelimit";

/** Returns the hosted checkout URL; the client redirects. */
export async function startUpgradeAction(planId: string, provider?: string): Promise<ActionResult<{ checkoutUrl: string }>> {
  return runAction(async () => {
    const user = await requireUser();
    const rl = await rateLimit("billing-upgrade", user.id, 10, 600);
    if (!rl.ok) throw new AppError("RATE_LIMITED", "Too many attempts. Try again later.", 429);
    return startUpgradeCheckout({ id: user.id, email: user.email }, String(planId), provider);
  });
}

export async function cancelSubscriptionAction(): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();
    await cancelMySubscription(user.id);
    revalidatePath("/dashboard/billing");
    return null;
  });
}
