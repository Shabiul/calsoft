import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/auth-session";
import { exportUserData } from "@/server/services/account";
import { isAppError } from "@/server/errors";
import { limitOr429 } from "@/server/ratelimit";

export async function GET(req: Request) {
  try {
    const user = await requireUserApi();
    const limited = await limitOr429(req, "data-export", 5, 600);
    if (limited) return limited;
    const data = await exportUserData(user.id);
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`, "cache-control": "no-store" },
    });
  } catch (e) {
    if (isAppError(e)) return NextResponse.json(e.toJSON(), { status: e.status });
    console.error("[export]", e);
    return NextResponse.json({ error: { code: "INTERNAL", message: "Export failed" } }, { status: 500 });
  }
}
