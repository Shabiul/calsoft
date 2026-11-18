import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { webhookDeliveries, webhookEndpoints } from "@/server/db/schema";
import { encrypt } from "@/lib/crypto";
import { AppError } from "@/server/errors";
import { enqueueDelivery, detUuid } from "./dispatch";
import { WEBHOOK_EVENTS } from "./events";
import { assertUrlAllowed, SsrfError } from "./ssrf";

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

function validate(url: string, events: string[]) {
  try { assertUrlAllowed(url); } catch (e) { if (e instanceof SsrfError) throw new AppError("VALIDATION", e.message, 422); throw e; }
  const ok = new Set<string>([...WEBHOOK_EVENTS, "*"]);
  if (!events.length) throw new AppError("VALIDATION", "Select at least one event", 422);
  const bad = events.find((e) => !ok.has(e));
  if (bad) throw new AppError("VALIDATION", `Unknown event: ${bad}`, 422);
}

const publicShape = (e: typeof webhookEndpoints.$inferSelect) => ({
  id: e.id, url: e.url, events: e.events, isActive: e.isActive, createdAt: e.createdAt,
});
export type WebhookEndpointView = ReturnType<typeof publicShape>;

/** Returns the plaintext secret ONCE; only the encrypted form is stored. */
export async function createWebhookEndpoint(userId: string, input: { url: string; events: string[] }) {
  validate(input.url, input.events);
  const secret = newWebhookSecret();
  const [row] = await db.insert(webhookEndpoints).values({ userId, url: input.url, events: input.events, secret: encrypt(secret) }).returning();
  return { endpoint: publicShape(row), secret };
}

export async function listWebhookEndpoints(userId: string): Promise<WebhookEndpointView[]> {
  const rows = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.userId, userId)).orderBy(desc(webhookEndpoints.createdAt));
  return rows.map(publicShape);
}

async function owned(userId: string, id: string) {
  const [row] = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.userId, userId)));
  if (!row) throw new AppError("NOT_FOUND", "Webhook endpoint not found", 404);
  return row;
}

export async function updateWebhookEndpoint(userId: string, id: string, patch: { url?: string; events?: string[]; isActive?: boolean }) {
  const cur = await owned(userId, id);
  validate(patch.url ?? cur.url, patch.events ?? cur.events);
  const [row] = await db.update(webhookEndpoints).set({
    ...(patch.url !== undefined && { url: patch.url }), ...(patch.events !== undefined && { events: patch.events }),
    ...(patch.isActive !== undefined && { isActive: patch.isActive }),
  }).where(eq(webhookEndpoints.id, id)).returning();
  return publicShape(row);
}

export async function rotateWebhookSecret(userId: string, id: string) {
  await owned(userId, id);
  const secret = newWebhookSecret();
  await db.update(webhookEndpoints).set({ secret: encrypt(secret) }).where(eq(webhookEndpoints.id, id));
  return { secret };
}

export async function deleteWebhookEndpoint(userId: string, id: string) {
  await owned(userId, id);
  await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
}

export async function listDeliveries(userId: string, endpointId: string, limit = 25) {
  await owned(userId, endpointId);
  return db.select({
    id: webhookDeliveries.id, event: webhookDeliveries.event, status: webhookDeliveries.status, attempts: webhookDeliveries.attempts,
    responseCode: webhookDeliveries.responseCode, error: webhookDeliveries.error, createdAt: webhookDeliveries.createdAt, deliveredAt: webhookDeliveries.deliveredAt,
  }).from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpointId)).orderBy(desc(webhookDeliveries.createdAt)).limit(limit);
}

/** Queue a synthetic test event ("webhook.test") to the endpoint. */
export async function sendTestWebhook(userId: string, endpointId: string) {
  await owned(userId, endpointId);
  const id = detUuid(`test:${endpointId}:${Date.now()}`);
  await db.insert(webhookDeliveries).values({
    id, endpointId, event: "webhook.test",
    payload: { id, type: "webhook.test", created_at: new Date().toISOString(), data: { message: "Test event from MeetFlow" } },
  });
  await enqueueDelivery(id);
  return { id };
}

/** Re-queue a failed/dead delivery. */
export async function retryDelivery(userId: string, deliveryId: string) {
  const [row] = await db.select({ d: webhookDeliveries, e: webhookEndpoints }).from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookEndpoints.userId, userId)));
  if (!row) throw new AppError("NOT_FOUND", "Delivery not found", 404);
  await db.update(webhookDeliveries).set({ status: "queued", error: null }).where(eq(webhookDeliveries.id, deliveryId));
  await enqueueDelivery(deliveryId, false);
}
