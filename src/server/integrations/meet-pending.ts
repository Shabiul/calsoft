import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";

/** True when a Google Meet link will be generated for this booking: Meet location and a host with an active Google calendar that has a destination. */
export async function meetLinkExpected(booking: { hostUserId: string; locationType: string | null; meetingUrl: string | null; status: string }): Promise<boolean> {
  if (booking.status !== "confirmed" || booking.meetingUrl || booking.locationType !== "google_meet") return false;
  const [r] = await db.select({ id: schema.calendars.id }).from(schema.calendars)
    .innerJoin(schema.connectedCalendars, eq(schema.connectedCalendars.id, schema.calendars.connectedCalendarId))
    .where(and(eq(schema.connectedCalendars.userId, booking.hostUserId), eq(schema.connectedCalendars.provider, "google"),
      eq(schema.connectedCalendars.status, "active"), eq(schema.calendars.isDestination, true))).limit(1);
  return !!r;
}
