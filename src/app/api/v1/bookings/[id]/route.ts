import { apiRoute } from "@/server/api/handler";
import { getBookingFor } from "@/server/api/resources";

export const GET = apiRoute<{ id: string }>({ scope: "bookings:read" }, async (c) => getBookingFor(c.key, c.params.id));
