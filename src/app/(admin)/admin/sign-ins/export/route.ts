import { requireSuperadmin } from "@/lib/auth-session";
import { toCsv } from "@/lib/csv";
import { isAppError } from "@/server/errors";
import { listSignInLog } from "@/server/admin/sign-ins";

export async function GET(req: Request) {
  try { await requireSuperadmin(); } catch (e) { if (isAppError(e)) return new Response("Forbidden", { status: 403 }); throw e; }
  const q = new URL(req.url).searchParams;
  const rows: unknown[][] = [];
  for (let page = 1; page <= 100; page++) { // up to 5,000 rows per export
    const r = await listSignInLog({ q: q.get("q") ?? "", event: q.get("event") ?? "", from: q.get("from") ?? "", to: q.get("to") ?? "", page });
    rows.push(...r.rows.map((x) => [x.at, x.name, x.email, x.event, x.event === "sign_out" ? "" : x.provider, x.device]));
    if (page >= r.pages) break;
  }
  return new Response(toCsv(["when", "name", "email", "event", "method", "browser"], rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="sign-in-activity.csv"', "Cache-Control": "no-store" },
  });
}
