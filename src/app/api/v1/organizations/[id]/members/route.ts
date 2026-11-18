import { apiRoute, requireUuid } from "@/server/api/handler";
import { listMembersFor } from "@/server/api/resources";

export const GET = apiRoute<{ id: string }>({ scope: "organizations:read" }, async (c) => ({
  data: await listMembersFor(c.key, requireUuid(c.params.id, "Organization")),
}));
