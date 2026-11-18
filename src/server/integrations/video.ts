/**
 * Video conferencing. Google Meet (conferenceData) and Teams (Graph isOnlineMeeting) are generated as part of the
 * calendar event by google.ts / microsoft.ts. This file implements Zoom (OAuth + meetings API) and the passthrough
 * location types (custom url / in person / phone), which need no external API.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { http, ProviderError } from "./http";
import { withVideoToken } from "./tokens";

const ZOOM = "https://api.zoom.us/v2";

export interface ZoomMeetingInput { bookingId: string; topic: string; startsAt: Date; endsAt: Date; agenda?: string }
export interface ZoomMeeting { id: string; joinUrl: string }

export async function getZoomConnection(userId: string) {
  const [c] = await db.select().from(schema.videoConnections)
    .where(and(eq(schema.videoConnections.userId, userId), eq(schema.videoConnections.provider, "zoom"))).limit(1);
  return c;
}

const body = (i: ZoomMeetingInput) => ({
  topic: i.topic, type: 2, start_time: i.startsAt.toISOString().replace(/\.\d{3}Z$/, "Z"), timezone: "UTC",
  duration: Math.max(1, Math.round((i.endsAt.getTime() - i.startsAt.getTime()) / 60_000)), agenda: i.agenda,
  settings: { join_before_host: false, waiting_room: true },
});

export async function createZoomMeeting(connectionId: string, input: ZoomMeetingInput): Promise<ZoomMeeting> {
  return withVideoToken(connectionId, async (token) => {
    const r = await http<{ id: number | string; join_url: string }>(`${ZOOM}/users/me/meetings`, { token, json: body(input) });
    return { id: String(r.id), joinUrl: r.join_url };
  });
}

export async function updateZoomMeeting(connectionId: string, meetingId: string, input: ZoomMeetingInput): Promise<void> {
  await withVideoToken(connectionId, async (token) => {
    try {
      await http(`${ZOOM}/meetings/${meetingId}`, { token, method: "PATCH", json: body(input) });
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "not_found") throw e; // caller recreates
      throw e;
    }
  });
}

export async function deleteZoomMeeting(connectionId: string, meetingId: string): Promise<void> {
  await withVideoToken(connectionId, async (token) => {
    try {
      await http(`${ZOOM}/meetings/${meetingId}?schedule_for_reminder=false`, { token, method: "DELETE" });
    } catch (e) {
      // 404 = gone already; Zoom also answers 3001 (invalid) for already-deleted meetings.
      if (e instanceof ProviderError && (e.kind === "not_found" || e.kind === "gone")) return;
      throw e;
    }
  });
}

export type Passthrough = { meetingUrl?: string; location?: string };

/** Custom url / in-person / phone: no API needed. */
export function passthroughLocation(type: string | null | undefined, value: string | null | undefined, inviteePhone?: string | null): Passthrough {
  switch (type) {
    case "custom_url": return value ? { meetingUrl: value } : {};
    case "in_person": return value ? { location: value } : {};
    case "phone": return value ? { location: `Phone: ${value}` } : {};
    case "invitee_phone": return { location: inviteePhone ? `Host calls invitee: ${inviteePhone}` : "Host calls invitee" };
    default: return {};
  }
}
