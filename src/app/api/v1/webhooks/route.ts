import { z } from "zod";
import { apiRoute, created, paginateSorted, paginationQuery } from "@/server/api/handler";
import { createWebhookEndpoint, listWebhookEndpoints } from "@/server/webhooks/endpoints";

const out = (e: Awaited<ReturnType<typeof listWebhookEndpoints>>[number]) => ({
  id: e.id, url: e.url, events: e.events, is_active: e.isActive, created_at: e.createdAt.toISOString(),
});

export const GET = apiRoute({ scope: "webhooks:manage" }, async (c) => {
  const q = c.query(paginationQuery);
  const rows = await listWebhookEndpoints(c.key.userId); // already newest first
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  const p = paginateSorted(rows, q, (r) => [r.createdAt, r.id]);
  return { ...p, data: p.data.map(out) };
});

export const POST = apiRoute({ scope: "webhooks:manage" }, async (c) => {
  const b = await c.body(z.object({ url: z.string().url().max(2000), events: z.array(z.string()).min(1).max(20) }));
  const { endpoint, secret } = await createWebhookEndpoint(c.key.userId, b);
  c.setAudit("webhook.created", { type: "webhook_endpoint", id: endpoint.id });
  return created({ ...out(endpoint), secret });
});
