import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getProvider } from "./provider";
import { decodeCreds, withCalendarToken } from "./tokens";
import { http } from "./http";
import type { CalendarProviderName } from "./types";

/** On disconnect: stop push channels/subscriptions and revoke the Google token. Never throws. */
export async function revokeBestEffort(connectedCalendarId: string, provider: CalendarProviderName): Promise<void> {
  try {
    const cals = await db.select({ id: schema.calendars.id }).from(schema.calendars).where(eq(schema.calendars.connectedCalendarId, connectedCalendarId));
    const states = cals.length ? await db.select().from(schema.calendarSyncStates).where(inArray(schema.calendarSyncStates.calendarId, cals.map((c) => c.id))) : [];
    const p = getProvider(provider);
    for (const s of states) {
      if (!s.channelId) continue;
      await withCalendarToken(connectedCalendarId, provider, (t) => p.stopSubscription(t, { id: s.channelId!, resourceId: s.channelResourceId })).catch(() => undefined);
    }
  } catch { /* ignore */ }
  if (provider === "google") {
    try {
      const [row] = await db.select({ enc: schema.connectedCalendars.credentialsEnc }).from(schema.connectedCalendars).where(eq(schema.connectedCalendars.id, connectedCalendarId));
      if (row) {
        const c = decodeCreds(row.enc);
        await http("https://oauth2.googleapis.com/revoke", { form: { token: c.refreshToken ?? c.accessToken } }).catch(() => undefined);
      }
    } catch { /* ignore */ }
  }
}
