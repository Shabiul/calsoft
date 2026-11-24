import { requireUser } from "@/lib/auth-session";
import { toCsv } from "@/lib/csv";
import { isAppError } from "@/server/errors";
import { getTeamOverview } from "@/server/services/team-oversight";

/** CSV of the team overview (same data and same access rules as the page). */
export async function GET(req: Request) {
  const user = await requireUser();
  const org = new URL(req.url).searchParams.get("org") ?? "";
  try {
    const o = await getTeamOverview(user.id, org);
    const csv = toCsv(["name", "email", "role", "status", "last sign-in", "sign-in method", "sign-ins (30 days)", "meetings next 24h", "meetings next 7 days", "next meeting"],
      o.members.map((m) => [m.name, m.email, m.role, m.status, m.lastSignInAt, m.lastSignInMethod, m.signIns30d, m.meetingsNext24h, m.meetingsNext7d, m.nextMeetingAt]));
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="team-activity.csv"', "Cache-Control": "no-store" } });
  } catch (e) {
    if (isAppError(e)) return new Response(e.status === 403 ? "Forbidden" : "Not found", { status: e.status === 403 ? 403 : 404 });
    throw e;
  }
}
