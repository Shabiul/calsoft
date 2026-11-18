"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSuperadmin } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import {
  changeSubscriptionPlan, CONFIG_FIELDS, parseLimitsJson, savePlan, savePlatformConfig, setUserStatus,
} from "@/server/admin";

/** Runs an admin mutation, then redirects back with ?ok / ?error so plain <form action> works without JS state. */
async function run(back: string, fn: (actorId: string) => Promise<void>) {
  const actor = await requireSuperadmin(); // re-checked on every action, never trust the page guard alone
  let msg: string | null = null;
  try {
    await fn(actor.id);
  } catch (e) {
    if (!isAppError(e)) throw e;
    msg = e.message;
  }
  revalidatePath(back.split("?")[0]);
  const sep = back.includes("?") ? "&" : "?";
  redirect(msg ? `${back}${sep}error=${encodeURIComponent(msg)}` : `${back}${sep}ok=1`);
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function setUserStatusAction(formData: FormData) {
  const id = str(formData, "userId"), status = str(formData, "status") === "suspended" ? "suspended" : "active";
  await run(str(formData, "back") || "/admin/users", (actor) => setUserStatus(actor, id, status));
}

export async function savePlanAction(formData: FormData) {
  await run("/admin/subscriptions", async (actor) => {
    await savePlan(actor, {
      id: str(formData, "id"), name: str(formData, "name"), priceMonthly: Number(str(formData, "priceMonthly")),
      currency: str(formData, "currency") || "USD", isActive: formData.get("isActive") === "on", limits: parseLimitsJson(str(formData, "limits")),
    });
  });
}

export async function changeSubscriptionPlanAction(formData: FormData) {
  await run(str(formData, "back") || "/admin/subscriptions", (actor) => changeSubscriptionPlan(actor, str(formData, "subscriptionId"), str(formData, "planId")));
}

export async function saveConfigAction(formData: FormData) {
  await run("/admin/config", async (actor) => {
    const values: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(CONFIG_FIELDS)) values[k] = f.type === "boolean" ? formData.get(k) === "on" : str(formData, k).trim();
    await savePlatformConfig(actor, values);
  });
}
