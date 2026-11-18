import { z } from "zod";
import { apiRoute, requireUuid } from "@/server/api/handler";
import { deleteWebhookEndpoint, listWebhookEndpoints, updateWebhookEndpoint } from "@/server/webhooks/endpoints";
import { AppError } from "@/server/errors";

type P = { id: string };
const out = (e: Awaited<ReturnType<typeof listWebhookEndpoints>>[number]) => ({
  id: e.id, url: e.url, events: e.events, is_active: e.isActive, created_at: e.createdAt.toISOString(),
});

export const GET = apiRoute<P>({ scope: "webhooks:manage" }, async (c) => {
  const id = requireUuid(c.params.id, "Webhook");
  const e = (await listWebhookEndpoints(c.key.userId)).find((x) => x.id === id);
  if (!e) throw new AppError("NOT_FOUND", "Webhook endpoint not found", 404);
  return out(e);
});

export const PATCH = apiRoute<P>({ scope: "webhooks:manage" }, async (c) => {
  const id = requireUuid(c.params.id, "Webhook");
  const b = await c.body(z.object({
    url: z.string().url().max(2000).optional(), events: z.array(z.string()).min(1).max(20).optional(), is_active: z.boolean().optional(),
  }).strict());
  const e = await updateWebhookEndpoint(c.key.userId, id, { url: b.url, events: b.events, isActive: b.is_active });
  c.setAudit("webhook.updated", { type: "webhook_endpoint", id });
  return out(e);
});

export const DELETE = apiRoute<P>({ scope: "webhooks:manage" }, async (c) => {
  const id = requireUuid(c.params.id, "Webhook");
  await deleteWebhookEndpoint(c.key.userId, id);
  c.setAudit("webhook.deleted", { type: "webhook_endpoint", id });
  return new Response(null, { status: 204 });
});
