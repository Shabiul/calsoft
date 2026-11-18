export type CalendarProviderName = "google" | "microsoft";
export type OAuthProviderName = CalendarProviderName | "zoom";

export interface Interval { start: Date; end: Date }

export interface RemoteCalendar { externalId: string; name: string; primary: boolean; writable: boolean }

export interface EventInput {
  bookingId: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  location?: string;
  attendees: { email: string; name?: string }[];
  /** Ask the calendar provider to generate its native meeting (Meet for google, Teams for microsoft). */
  nativeMeeting?: boolean;
  /** Existing join url (Zoom/custom) to put in the event. */
  meetingUrl?: string;
}

export interface EventResult { id: string; meetingUrl?: string }

export interface SubscriptionInfo { id: string; resourceId?: string; expiresAt: Date }

export interface ChangeSet {
  /** busy === null means the event was removed / no longer blocks time. */
  changes: { id: string; busy: Interval | null }[];
  nextSyncToken: string | null;
  /** true when the result is a complete listing (cache must be replaced). */
  reset: boolean;
}

export interface CalendarProvider {
  name: CalendarProviderName;
  getCalendars(token: string): Promise<RemoteCalendar[]>;
  getBusyIntervals(token: string, calendarId: string, from: Date, to: Date): Promise<Interval[]>;
  createEvent(token: string, calendarId: string, input: EventInput): Promise<EventResult>;
  updateEvent(token: string, calendarId: string, eventId: string, input: EventInput): Promise<EventResult>;
  /** Must treat already-deleted events as success. */
  deleteEvent(token: string, calendarId: string, eventId: string): Promise<void>;
  /** Create or renew a push subscription. Returns null when unsupported (e.g. non-HTTPS app url). */
  refreshSubscription(token: string, args: {
    calendarId: string; existing?: { id: string; resourceId?: string | null } | null; notificationUrl: string; secret: string;
  }): Promise<SubscriptionInfo | null>;
  stopSubscription(token: string, sub: { id: string; resourceId?: string | null }): Promise<void>;
  listChanges(token: string, calendarId: string, args: { syncToken?: string | null; from: Date; to: Date }): Promise<ChangeSet>;
}

export interface TokenSet { accessToken: string; refreshToken?: string; expiresAt: number }
