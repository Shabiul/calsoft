/**
 * Adapter for external-calendar busy time. The integrations agent owns `src/server/integrations/busy.ts`
 * (`getExternalBusy(userId, from, to) => Interval[]`). We import it lazily so scheduling compiles and runs
 * even when that module is absent (returns []). Failures are logged and treated as "no external busy" for
 * slot display; inject a stricter provider if you want fail-closed behaviour.
 */
import type { Interval } from "./availability";

export type BusyProvider = (userId: string, from: Date, to: Date) => Promise<Interval[]>;

type Raw = { start?: unknown; end?: unknown; startsAt?: unknown; endsAt?: unknown };
const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(String(v)).getTime());

export function normalizeIntervals(list: unknown): Interval[] {
  if (!Array.isArray(list)) return [];
  const out: Interval[] = [];
  for (const r of list as Raw[]) {
    const s = toMs(r.start ?? r.startsAt), e = toMs(r.end ?? r.endsAt);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ start: s, end: e });
  }
  return out;
}

export const defaultBusyProvider: BusyProvider = async (userId, from, to) => {
  try {
    const { getExternalBusy } = await import("../integrations/busy");
    return normalizeIntervals(await getExternalBusy(userId, from, to));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND" && !/Cannot find module|Failed to resolve|Failed to load/i.test(String((err as Error).message))) {
      console.warn("[scheduling] external busy lookup failed:", (err as Error).message);
    }
    return [];
  }
};
