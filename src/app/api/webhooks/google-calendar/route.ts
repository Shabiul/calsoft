import { NextResponse, after, type NextRequest } from "next/server";
import { resolveGoogleNotification, syncCalendar } from "@/server/integrations/sync";

/** Google push notification (events.watch). Body is empty; identity is in X-Goog-* headers. */
export async function POST(req: NextRequest) {
  const calendarId = await resolveGoogleNotification({
    channelId: req.headers.get("x-goog-channel-id"),
    token: req.headers.get("x-goog-channel-token"),
    resourceState: req.headers.get("x-goog-resource-state"),
  });
  // Always 200 for unknown/handshake channels so Google does not retry forever; sync only for verified ones.
  if (calendarId) after(() => syncCalendar(calendarId));
  return new NextResponse(null, { status: 200 });
}
