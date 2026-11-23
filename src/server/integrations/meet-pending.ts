import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";

/**
 * True when a meeting link will be generated for this booking: a confirmed booking without a link whose location creates one
 * (Google Meet via a Google destination calendar; Zoho Meeting via an active Zoho account) for a host who has that connected.
 */
export async function meetLinkExpected(booking: { hostUserId: string; locationType: string | null; meetingUrl: string | null; status: string }): Promise<boolean> {
  if (booking.status !== "confirmed" || booking.meetingUrl) return false;
  if (booking.locationType === "google_meet") {
    const [r] = await db.select({ id: schema.calendars.id }).from(schema.calendars)
      .innerJoin(schema.connectedCalendars, eq(schema.connectedCalendars.id, schema.calendars.connectedCalendarId))
      .where(and(eq(schema.connectedCalendars.userId, booking.hostUserId), eq(schema.connectedCalendars.provider, "google"),
        eq(schema.connectedCalendars.status, "active"), eq(schema.calendars.isDestination, true))).limit(1);
    return !!r;
  }
  if (booking.locationType === "zoho_meeting") {
    const [r] = await db.select({ id: schema.connectedCalendars.id }).from(schema.connectedCalendars)
      .where(and(eq(schema.connectedCalendars.userId, booking.hostUserId), eq(schema.connectedCalendars.provider, "zoho"), eq(schema.connectedCalendars.status, "active"))).limit(1);
    return !!r;
  }
  return false;
}
