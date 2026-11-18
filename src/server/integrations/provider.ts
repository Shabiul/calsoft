import { googleProvider } from "./google";
import { microsoftProvider } from "./microsoft";
import type { CalendarProvider, CalendarProviderName } from "./types";

export type { CalendarProvider, CalendarProviderName, EventInput, EventResult, Interval, RemoteCalendar } from "./types";

export function getProvider(name: CalendarProviderName): CalendarProvider {
  if (name === "google") return googleProvider;
  if (name === "microsoft") return microsoftProvider;
  throw new Error(`Unknown calendar provider: ${String(name)}`);
}
