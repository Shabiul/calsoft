import { apiRoute, requireUuid } from "@/server/api/handler";
import { rotateWebhookSecret } from "@/server/webhooks/endpoints";

export const POST = apiRoute<{ id: string }>({ scope: "webhooks:manage" }, async (c) => {
  const id = requireUuid(c.params.id, "Webhook");
  const { secret } = await rotateWebhookSecret(c.key.userId, id);
  c.setAudit("webhook.secret_rotated", { type: "webhook_endpoint", id });
  return { secret };
});
