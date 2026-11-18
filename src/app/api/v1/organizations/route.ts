import { apiRoute } from "@/server/api/handler";
import { listOrganizationsFor } from "@/server/api/resources";

export const GET = apiRoute({ scope: "organizations:read" }, async (c) => ({ data: await listOrganizationsFor(c.key) }));
