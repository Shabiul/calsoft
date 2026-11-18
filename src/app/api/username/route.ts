import { NextResponse } from "next/server";
import { checkUsername, suggestUsernames } from "@/server/services/username";
import { limitOr429 } from "@/server/ratelimit";
import { getSession } from "@/lib/auth-session";

/** GET /api/username?u=foo[&base=Jane Doe] -> availability (+ suggestions when taken / base given). */
export async function GET(req: Request) {
  const limited = await limitOr429(req, "username-check", 60, 60);
  if (limited) return limited;
  const url = new URL(req.url);
  const u = url.searchParams.get("u") ?? "";
  const base = url.searchParams.get("base") ?? u;
  const session = await getSession().catch(() => null);
  const result = u ? await checkUsername(u, session?.user.id) : { available: false };
  const suggestions = !u || !result.available ? await suggestUsernames(base || "user", 4) : [];
  return NextResponse.json({ ...result, suggestions });
}
