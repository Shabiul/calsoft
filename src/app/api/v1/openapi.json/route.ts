import { buildOpenApi } from "@/server/api/openapi";

/** Public (unauthenticated) OpenAPI document. */
export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  return Response.json(buildOpenApi(origin), { headers: { "Cache-Control": "public, max-age=300" } });
}
