import type { ScheduleDetail, ScheduleSummary } from "@/server/services/availability";

export function scheduleOut(s: ScheduleDetail | ScheduleSummary) {
  return {
    id: s.id, name: s.name, time_zone: s.timeZone, is_default: s.isDefault, rules: s.rules,
    ...("overrides" in s ? { overrides: s.overrides } : {}), updated_at: s.updatedAt.toISOString(),
  };
}
