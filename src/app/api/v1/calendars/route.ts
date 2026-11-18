import { apiRoute } from "@/server/api/handler";
import { listCalendarsFor } from "@/server/api/resources";

export const GET = apiRoute({ scope: "calendars:read" }, async (c) => ({ data: await listCalendarsFor(c.key) }));
