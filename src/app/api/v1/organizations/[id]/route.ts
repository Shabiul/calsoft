import { apiRoute } from "@/server/api/handler";
import { getOrganizationFor } from "@/server/api/resources";

export const GET = apiRoute<{ id: string }>({ scope: "organizations:read" }, async (c) => getOrganizationFor(c.key, c.params.id));
