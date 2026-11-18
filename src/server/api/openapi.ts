/** OpenAPI 3.1 description of /api/v1. Served at /api/v1/openapi.json and rendered at /docs/api. */
type Op = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string;
  scope: string;
  tag: string;
  query?: [name: string, description: string, required?: boolean][];
  body?: string; // description of the JSON body
  status?: number;
};

const list = (tag: string, path: string, scope: string, what: string, query: Op["query"] = []): Op => ({
  method: "get", path, scope, tag, summary: `List ${what}`, query: [["limit", "1-100 (default 25)"], ["cursor", "Opaque cursor from next_cursor"], ...query],
});

export const OPERATIONS: Op[] = [
  list("Events", "/events", "event_types:read", "event types", [["include_archived", "true|false"], ["is_active", "true|false"]]),
  { method: "post", path: "/events", scope: "event_types:write", tag: "Events", summary: "Create an event type", body: "title, slug, duration_minutes, location_type, ... (snake_case)", status: 201 },
  { method: "get", path: "/events/{id}", scope: "event_types:read", tag: "Events", summary: "Get an event type" },
  { method: "patch", path: "/events/{id}", scope: "event_types:write", tag: "Events", summary: "Partially update an event type", body: "Any subset of the create fields" },
  { method: "delete", path: "/events/{id}", scope: "event_types:write", tag: "Events", summary: "Delete an event type", status: 204 },
  list("Availability", "/availability/schedules", "availability:read", "availability schedules"),
  { method: "post", path: "/availability/schedules", scope: "availability:write", tag: "Availability", summary: "Create a schedule", body: "name, time_zone, template?", status: 201 },
  { method: "get", path: "/availability/schedules/{id}", scope: "availability:read", tag: "Availability", summary: "Get a schedule with rules and overrides" },
  { method: "put", path: "/availability/schedules/{id}", scope: "availability:write", tag: "Availability", summary: "Replace a schedule", body: "name, time_zone, rules[{weekday,start,end}], overrides?" },
  { method: "delete", path: "/availability/schedules/{id}", scope: "availability:write", tag: "Availability", summary: "Delete a schedule", status: 204 },
  {
    method: "get", path: "/availability/slots", scope: "availability:read", tag: "Availability", summary: "Look up bookable slots for an event type",
    query: [["event_id", "Event type id", true], ["from", "ISO-8601 datetime", true], ["to", "ISO-8601 datetime (max 31 days after from)", true], ["time_zone", "IANA zone, default UTC"]],
  },
  list("Bookings", "/bookings", "bookings:read", "bookings", [["status", "booking status"], ["event_id", "filter by event type"], ["from", "starts_at >= (ISO)"], ["to", "starts_at < (ISO)"], ["invitee_email", "exact email"]]),
  { method: "post", path: "/bookings", scope: "bookings:write", tag: "Bookings", summary: "Create a booking (conflict-checked; 409 SLOT_UNAVAILABLE on double booking)", body: "event_id, starts_at, invitee{name,email,phone?,time_zone}, answers?, idempotency_key?", status: 201 },
  { method: "get", path: "/bookings/{id}", scope: "bookings:read", tag: "Bookings", summary: "Get a booking" },
  { method: "post", path: "/bookings/{id}/cancel", scope: "bookings:write", tag: "Bookings", summary: "Cancel a booking", body: "reason?" },
  { method: "post", path: "/bookings/{id}/reschedule", scope: "bookings:write", tag: "Bookings", summary: "Reschedule a booking", body: "starts_at, reason?" },
  { method: "get", path: "/calendars", scope: "calendars:read", tag: "Calendars", summary: "List connected calendars" },
  { method: "get", path: "/organizations", scope: "organizations:read", tag: "Organizations", summary: "List organizations the key can access" },
  { method: "get", path: "/organizations/{id}", scope: "organizations:read", tag: "Organizations", summary: "Get an organization" },
  { method: "get", path: "/organizations/{id}/members", scope: "organizations:read", tag: "Organizations", summary: "List organization members" },
  list("Contacts", "/contacts", "contacts:read", "contacts", [["email", "exact email"], ["search", "substring of name or email"]]),
  { method: "post", path: "/contacts", scope: "contacts:write", tag: "Contacts", summary: "Create a contact", body: "email, name?, phone?, time_zone?", status: 201 },
  { method: "get", path: "/contacts/{id}", scope: "contacts:read", tag: "Contacts", summary: "Get a contact" },
  { method: "patch", path: "/contacts/{id}", scope: "contacts:write", tag: "Contacts", summary: "Update a contact", body: "name?, phone?, time_zone?" },
  { method: "delete", path: "/contacts/{id}", scope: "contacts:write", tag: "Contacts", summary: "Delete a contact", status: 204 },
  list("Webhooks", "/webhooks", "webhooks:manage", "webhook endpoints"),
  { method: "post", path: "/webhooks", scope: "webhooks:manage", tag: "Webhooks", summary: "Create a webhook endpoint (secret returned once)", body: "url, events[]", status: 201 },
  { method: "get", path: "/webhooks/{id}", scope: "webhooks:manage", tag: "Webhooks", summary: "Get a webhook endpoint" },
  { method: "patch", path: "/webhooks/{id}", scope: "webhooks:manage", tag: "Webhooks", summary: "Update a webhook endpoint", body: "url?, events?, is_active?" },
  { method: "delete", path: "/webhooks/{id}", scope: "webhooks:manage", tag: "Webhooks", summary: "Delete a webhook endpoint", status: 204 },
  { method: "get", path: "/webhooks/{id}/deliveries", scope: "webhooks:manage", tag: "Webhooks", summary: "Recent deliveries", query: [["limit", "1-100"]] },
  { method: "post", path: "/webhooks/{id}/rotate-secret", scope: "webhooks:manage", tag: "Webhooks", summary: "Rotate the signing secret" },
];

const errorRef = { $ref: "#/components/schemas/Error" };
const errResp = (description: string) => ({ description, content: { "application/json": { schema: errorRef } } });

export function buildOpenApi(baseUrl = "") {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const o of OPERATIONS) {
    const parameters: unknown[] = [...(o.path.includes("{id}") ? [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }] : [])];
    for (const [name, description, required] of o.query ?? []) parameters.push({ name, in: "query", description, required: !!required, schema: { type: "string" } });
    const status = String(o.status ?? 200);
    (paths[o.path] ??= {})[o.method] = {
      tags: [o.tag], summary: o.summary, description: `Required scope: \`${o.scope}\``, "x-required-scope": o.scope, parameters,
      ...(o.body ? { requestBody: { required: true, description: o.body, content: { "application/json": { schema: { type: "object" } } } } } : {}),
      responses: {
        [status]: { description: status === "204" ? "No content" : "Success", ...(status === "204" ? {} : { content: { "application/json": { schema: { type: "object" } } } }) },
        "401": errResp("Missing or invalid API key"), "403": errResp("Insufficient scope or suspended account"),
        "404": errResp("Not found (also returned for resources of other tenants)"), "422": errResp("Validation error"),
        "429": errResp("Rate limit exceeded"),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "MeetFlow REST API", version: "1.0.0", description: "Bearer API-key authenticated scheduling API. See /docs/api." },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "API key (mf_live_...) created under Settings > API keys" } },
      schemas: {
        Error: {
          type: "object", required: ["error"],
          properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: {}, request_id: { type: "string" } } } },
        },
      },
    },
  };
}
