import { NextResponse, after, type NextRequest } from "next/server";
import { resolveGraphNotifications, syncCalendar } from "@/server/integrations/sync";

/** Validation handshake: Graph POSTs ?validationToken=... and expects it echoed as text/plain within 10s. */
function handshake(req: NextRequest): NextResponse | null {
  const token = req.nextUrl.searchParams.get("validationToken");
  if (token === null) return null;
  return new NextResponse(token, { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function POST(req: NextRequest) {
  const hs = handshake(req);
  if (hs) return hs;
  const body = await req.json().catch(() => null);
  const ids = await resolveGraphNotifications(body);
  for (const id of ids) after(() => syncCalendar(id));
  return new NextResponse(null, { status: 202 }); // must answer < 3s
}

export async function GET(req: NextRequest) {
  return handshake(req) ?? new NextResponse(null, { status: 405 });
}
