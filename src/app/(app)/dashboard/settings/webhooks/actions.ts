"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { AppError } from "@/server/errors";
import { runSafe } from "@/server/workflows/run-action";
import {
  createWebhookEndpoint, deleteWebhookEndpoint, listDeliveries, retryDelivery, rotateWebhookSecret, sendTestWebhook, updateWebhookEndpoint,
} from "@/server/webhooks/endpoints";

const uuid = z.string().uuid();
const id = (v: unknown) => {
  const r = uuid.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION", "Invalid id", 422);
  return r.data;
};
const createSchema = z.object({ url: z.string().url("Enter a valid URL").max(2000), events: z.array(z.string()).min(1, "Select at least one event") });
const refresh = () => revalidatePath("/dashboard/settings/webhooks");

export async function createWebhookAction(input: unknown) {
  const user = await requireUser();
  return runSafe(async () => {
    const data = createSchema.parse(input);
    const r = await createWebhookEndpoint(user.id, data);
    refresh();
    return { id: r.endpoint.id, secret: r.secret };
  });
}
export async function updateWebhookAction(endpointId: string, input: unknown) {
  const user = await requireUser();
  return runSafe(async () => {
    const data = createSchema.partial().extend({ isActive: z.boolean().optional() }).parse(input);
    await updateWebhookEndpoint(user.id, id(endpointId), data);
    refresh();
    return null;
  });
}
export async function rotateWebhookSecretAction(endpointId: string) {
  const user = await requireUser();
  return runSafe(async () => rotateWebhookSecret(user.id, id(endpointId)));
}
export async function deleteWebhookAction(endpointId: string) {
  const user = await requireUser();
  return runSafe(async () => { await deleteWebhookEndpoint(user.id, id(endpointId)); refresh(); return null; });
}
export async function testWebhookAction(endpointId: string) {
  const user = await requireUser();
  return runSafe(async () => { await sendTestWebhook(user.id, id(endpointId)); return null; });
}
export async function listDeliveriesAction(endpointId: string) {
  const user = await requireUser();
  return runSafe(async () => {
    const rows = await listDeliveries(user.id, id(endpointId));
    return rows.map((r) => ({
      id: r.id, event: r.event, status: r.status, attempts: r.attempts, responseCode: r.responseCode, error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
export async function retryDeliveryAction(deliveryId: string) {
  const user = await requireUser();
  return runSafe(async () => { await retryDelivery(user.id, id(deliveryId)); return null; });
}
