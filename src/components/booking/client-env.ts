"use client";

import { useSyncExternalStore } from "react";
import { detectHour12, detectTimeZone } from "./format";

const noopSub = () => () => {};

/** false during SSR/hydration, true on the client afterwards (no setState-in-effect needed). */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSub, () => true, () => false);
}

/** Browser time zone (Intl) and locale 12/24h default. SSR snapshot is UTC / 12h and swaps after hydration. */
export function useBrowserEnv(): { tz: string; hour12: boolean } {
  const s = useSyncExternalStore(noopSub, () => `${detectTimeZone()}|${detectHour12() ? 1 : 0}`, () => "UTC|1");
  const [tz, h] = s.split("|");
  return { tz: tz!, hour12: h === "1" };
}

/** Tiny localStorage-backed store with cross-component notification. Never throws. */
export function createLocalStore(key: string) {
  const listeners = new Set<() => void>();
  const read = (): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => { if (e.key === key) cb(); };
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
    },
    get: read,
    set(v: string) { try { localStorage.setItem(key, v); } catch { /* ignore */ } listeners.forEach((l) => l()); },
    use(): string | null { return useSyncExternalStore(this.subscribe, read, () => null); },
  };
}

export const themeStore = createLocalStore("mf-theme");
export const hour12Store = createLocalStore("mf-h12");

function subscribeDark(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
export function useSystemDark(): boolean {
  return useSyncExternalStore(subscribeDark, () => window.matchMedia("(prefers-color-scheme: dark)").matches, () => false);
}
