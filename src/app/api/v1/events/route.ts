import { z } from "zod";
import { apiRoute, created, paginateSorted, paginationQuery } from "@/server/api/handler";
import { eventBodyToInput, serializeEvent } from "@/server/api/resources";
import { createEventType, listEventTypes } from "@/server/services/event-types";

export const GET = apiRoute({ scope: "event_types:read" }, async (c) => {
  const q = c.query(paginationQuery.extend({ include_archived: z.enum(["true", "false"]).default("false"), is_active: z.enum(["true", "false"]).optional() }));
  let rows = await listEventTypes({ userId: c.key.userId }, { organizationId: c.key.organizationId, includeArchived: q.include_archived === "true" });
  if (q.is_active) rows = rows.filter((r) => r.isActive === (q.is_active === "true"));
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  const p = paginateSorted(rows, q, (r) => [r.createdAt, r.id]);
  return { ...p, data: p.data.map((r) => serializeEvent(r, { host_count: r.hostCount })) };
});

export const POST = apiRoute({ scope: "event_types:write" }, async (c) => {
  const body = await c.body(z.record(z.string(), z.unknown()));
  const input = eventBodyToInput(body);
  if (c.key.organizationId && input.organizationId === undefined) input.organizationId = c.key.organizationId;
  const et = await createEventType({ userId: c.key.userId }, input);
  c.setAudit("event_type.created", { type: "event_type", id: et.id });
  return created(serializeEvent(et));
});
