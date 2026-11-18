import { z } from "zod";
import { apiRoute, requireUuid } from "@/server/api/handler";
import { listDeliveries } from "@/server/webhooks/endpoints";

export const GET = apiRoute<{ id: string }>({ scope: "webhooks:manage" }, async (c) => {
  const q = c.query(z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }));
  const rows = await listDeliveries(c.key.userId, requireUuid(c.params.id, "Webhook"), q.limit);
  return {
    data: rows.map((d) => ({
      id: d.id, event: d.event, status: d.status, attempts: d.attempts, response_code: d.responseCode, error: d.error,
      created_at: d.createdAt.toISOString(), delivered_at: d.deliveredAt?.toISOString() ?? null,
    })),
  };
});
