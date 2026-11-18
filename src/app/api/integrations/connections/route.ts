import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/auth-session";
import { listConnections } from "@/server/integrations/connections";
import { errorResponse } from "@/server/integrations/http-errors";

export async function GET() {
  try {
    const user = await requireUserApi();
    return NextResponse.json(await listConnections(user.id));
  } catch (e) { return errorResponse(e); }
}
