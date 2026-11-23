import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { limitOr429 } from "@/server/ratelimit";
import { APP_NAME } from "@/lib/brand";

/** GET /j/:code -> redirects to the booking's real meeting URL (the masked "join" link shown to invitees). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const limited = await limitOr429(req, "join", 60, 60);
  if (limited) return limited;
  const { code } = await ctx.params;
  if (!/^[0-9a-f]{10}$/.test(code)) return page(404, "Link not found", "Check the link in your invitation email.");
  const [b] = await db.select({ status: schema.bookings.status, meetingUrl: schema.bookings.meetingUrl })
    .from(schema.bookings).where(eq(schema.bookings.joinCode, code)).limit(1);
  if (!b) return page(404, "Link not found", "Check the link in your invitation email.");
  if (b.status === "cancelled" || b.status === "expired") return page(410, "This meeting was cancelled", "Check your email for details.");
  if (b.status === "rescheduled") return page(410, "This meeting was rescheduled", "Use the join link in your most recent invitation email.");
  if (b.status !== "confirmed" && b.status !== "completed") return page(409, "This meeting is not confirmed yet", "You will get an email with the link once it is confirmed.");
  const url = b.meetingUrl && /^https?:\/\//i.test(b.meetingUrl) ? b.meetingUrl : null;
  if (!url) return page(202, "Your meeting link is being prepared", "This page refreshes automatically in a few seconds.", 5);
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

function page(status: number, title: string, message: string, refreshSeconds?: number) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}<title>${title} | ${APP_NAME}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f4f6;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<main style="max-width:420px;margin:16px;padding:32px;background:#fff;border-radius:16px;border-top:4px solid #4f46e5;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)">
<img src="/email-logo.png" width="40" height="40" alt="" style="border-radius:10px"><h1 style="font-size:20px;margin:16px 0 8px">${title}</h1>
<p style="margin:0;color:#6b7280;line-height:1.5">${message}</p></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
