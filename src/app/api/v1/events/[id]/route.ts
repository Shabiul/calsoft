import { z } from "zod";
import { apiRoute, hideForbidden, requireUuid } from "@/server/api/handler";
import { eventBodyToInput, serializeEvent } from "@/server/api/resources";
import { deleteEventType, getEventType, updateEventType, type EventTypeDetail } from "@/server/services/event-types";

type P = { id: string };
const detail = (et: EventTypeDetail) => serializeEvent(et, {
  hosts: et.hosts.map((h) => ({ user_id: h.userId, name: h.name, priority: h.priority, weight: h.weight, is_required: h.isRequired })),
  questions: et.questions, price_amount: et.priceAmount, price_currency: et.priceCurrency,
});

/** Current event type expressed as service input so PATCH can merge partial bodies. */
function toInput(et: EventTypeDetail): Record<string, unknown> {
  return {
    organizationId: et.organizationId, title: et.title, slug: et.slug, description: et.description, kind: et.kind,
    durationMinutes: et.durationMinutes, locationType: et.locationType, locationValue: et.locationValue,
    bufferBeforeMinutes: et.bufferBeforeMinutes, bufferAfterMinutes: et.bufferAfterMinutes, minNoticeMinutes: et.minNoticeMinutes,
    maxHorizonDays: et.maxHorizonDays, slotIntervalMinutes: et.slotIntervalMinutes, dailyLimit: et.dailyLimit, weeklyLimit: et.weeklyLimit,
    capacity: et.capacity, scheduleId: et.scheduleId, requiresConfirmation: et.requiresConfirmation, cancellationPolicy: et.cancellationPolicy,
    allowReschedule: et.allowReschedule, minCancelNoticeMinutes: et.minCancelNoticeMinutes, color: et.color, redirectUrl: et.redirectUrl,
    priceAmount: et.priceAmount, priceCurrency: et.priceCurrency, paymentProvider: et.paymentProvider, reminders: et.reminders,
    recurrence: et.recurrence, isActive: et.isActive, isOneOff: et.isOneOff,
    hosts: et.hosts.map((h) => ({ userId: h.userId, priority: h.priority, weight: h.weight, isRequired: h.isRequired })),
    questions: et.questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options, required: q.required })),
    pageSettings: et.pageSettings,
  };
}

export const GET = apiRoute<P>({ scope: "event_types:read" }, async (c) =>
  detail(await hideForbidden(getEventType({ userId: c.key.userId }, requireUuid(c.params.id, "Event type")))));

export const PATCH = apiRoute<P>({ scope: "event_types:write" }, async (c) => {
  const id = requireUuid(c.params.id, "Event type");
  const actor = { userId: c.key.userId };
  const body = await c.body(z.record(z.string(), z.unknown()));
  const cur = await hideForbidden(getEventType(actor, id));
  const et = await updateEventType(actor, id, { ...toInput(cur), ...eventBodyToInput(body) });
  c.setAudit("event_type.updated", { type: "event_type", id }, { fields: Object.keys(body) });
  return detail(et);
});

export const DELETE = apiRoute<P>({ scope: "event_types:write" }, async (c) => {
  const id = requireUuid(c.params.id, "Event type");
  await hideForbidden(deleteEventType({ userId: c.key.userId }, id));
  c.setAudit("event_type.deleted", { type: "event_type", id });
  return new Response(null, { status: 204 });
});
