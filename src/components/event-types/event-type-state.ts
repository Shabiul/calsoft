import type { HostState } from "./host-picker";
import type { QuestionState } from "./question-builder";
import type { EventKind, LocationType } from "@/lib/validation/event-types";

export type FormState = {
  organizationId: string | null;
  title: string; slug: string; description: string; kind: EventKind;
  durationMinutes: number | null; locationType: LocationType; locationValue: string;
  bufferBeforeMinutes: number | null; bufferAfterMinutes: number | null; minNoticeMinutes: number | null; maxHorizonDays: number | null;
  slotIntervalMinutes: number | null; dailyLimit: number | null; weeklyLimit: number | null; capacity: number | null;
  scheduleId: string | null; requiresConfirmation: boolean; notetakerEnabled: boolean; cancellationPolicy: string; allowReschedule: boolean; minCancelNoticeMinutes: number | null;
  color: string; redirectUrl: string; priceMajor: string; priceCurrency: string; paymentProvider: "stripe" | "razorpay" | null;
  reminders: number[]; recurrenceOn: boolean; recurrenceCount: number | null; recurrenceInterval: "week" | "month";
  isActive: boolean; isOneOff: boolean;
  hosts: HostState[]; questions: QuestionState[];
  pageBrandColor: string; pageLogoUrl: string; pageHeadline: string; pageSuccess: string;
};

export const defaultFormState = (organizationId: string | null = null, hostUserId?: string): FormState => ({
  organizationId, title: "", slug: "", description: "", kind: "one_on_one", durationMinutes: 30, locationType: "google_meet", locationValue: "",
  bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 240, maxHorizonDays: 60, slotIntervalMinutes: null, dailyLimit: null, weeklyLimit: null,
  capacity: 1, scheduleId: null, requiresConfirmation: false, notetakerEnabled: false, cancellationPolicy: "", allowReschedule: true, minCancelNoticeMinutes: 0,
  color: "#6366f1", redirectUrl: "", priceMajor: "", priceCurrency: "USD", paymentProvider: null, reminders: [0, 10],
  recurrenceOn: false, recurrenceCount: 4, recurrenceInterval: "week", isActive: true, isOneOff: false,
  hosts: organizationId && hostUserId ? [{ userId: hostUserId, priority: 0, weight: 1, isRequired: true }] : [], questions: [],
  pageBrandColor: "", pageLogoUrl: "", pageHeadline: "", pageSuccess: "",
});

/** Build initial form state from a persisted event type. */
export function stateFromEventType(et: {
  organizationId: string | null; title: string; slug: string; description: string | null; kind: EventKind; durationMinutes: number;
  locationType: LocationType; locationValue: string | null; bufferBeforeMinutes: number; bufferAfterMinutes: number; minNoticeMinutes: number; maxHorizonDays: number;
  slotIntervalMinutes: number | null; dailyLimit: number | null; weeklyLimit: number | null; capacity: number; scheduleId: string | null;
  requiresConfirmation: boolean; notetakerEnabled: boolean; cancellationPolicy: string | null; allowReschedule: boolean; minCancelNoticeMinutes: number; color: string | null; redirectUrl: string | null;
  priceAmount: number | null; priceCurrency: string | null; paymentProvider: string | null; reminders: number[]; recurrence: { count: number; interval: "week" | "month" } | null;
  isActive: boolean; isOneOff: boolean;
  hosts: HostState[]; questions: { id: string; label: string; type: string; options: string[] | null; required: boolean }[];
  pageSettings: { brandColor: string | null; logoUrl: string | null; headline: string | null; successMessage: string | null } | null;
}): FormState {
  return {
    organizationId: et.organizationId, title: et.title, slug: et.slug, description: et.description ?? "", kind: et.kind, durationMinutes: et.durationMinutes,
    locationType: et.locationType, locationValue: et.locationValue ?? "", bufferBeforeMinutes: et.bufferBeforeMinutes, bufferAfterMinutes: et.bufferAfterMinutes,
    minNoticeMinutes: et.minNoticeMinutes, maxHorizonDays: et.maxHorizonDays, slotIntervalMinutes: et.slotIntervalMinutes, dailyLimit: et.dailyLimit, weeklyLimit: et.weeklyLimit,
    capacity: et.capacity, scheduleId: et.scheduleId, requiresConfirmation: et.requiresConfirmation, notetakerEnabled: et.notetakerEnabled, cancellationPolicy: et.cancellationPolicy ?? "", allowReschedule: et.allowReschedule,
    minCancelNoticeMinutes: et.minCancelNoticeMinutes, color: et.color ?? "#6366f1", redirectUrl: et.redirectUrl ?? "",
    priceMajor: et.priceAmount != null ? (et.priceAmount / 100).toFixed(2) : "", priceCurrency: et.priceCurrency ?? "USD",
    paymentProvider: et.paymentProvider === "stripe" || et.paymentProvider === "razorpay" ? et.paymentProvider : null,
    reminders: et.reminders, recurrenceOn: !!et.recurrence, recurrenceCount: et.recurrence?.count ?? 4, recurrenceInterval: et.recurrence?.interval ?? "week",
    isActive: et.isActive, isOneOff: et.isOneOff,
    hosts: et.hosts.map((h) => ({ userId: h.userId, priority: h.priority, weight: h.weight, isRequired: h.isRequired })),
    questions: et.questions.map((q) => ({ id: q.id, label: q.label, type: q.type as QuestionState["type"], options: q.options ?? [], required: q.required, key: q.id })),
    pageBrandColor: et.pageSettings?.brandColor ?? "", pageLogoUrl: et.pageSettings?.logoUrl ?? "", pageHeadline: et.pageSettings?.headline ?? "", pageSuccess: et.pageSettings?.successMessage ?? "",
  };
}
