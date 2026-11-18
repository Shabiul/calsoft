# MeetFlow REST API v1

Base path: `/api/v1`. Machine-readable spec: `GET /api/v1/openapi.json` (OpenAPI 3.1). Human docs: `/docs/api`.

## Authentication
Create a key in Dashboard > Settings > API keys (plaintext shown once). Send it as a bearer token:

```
curl -H "Authorization: Bearer mf_live_xxx" https://HOST/api/v1/events
```

Keys belong to a user (and optionally an organization) and carry scopes. A request can only ever see/modify
resources of the key's user (and key org). Cross-tenant ids return `404` (never `403`) so existence is not leaked.
Keys of suspended or deleted accounts get `403 ACCOUNT_SUSPENDED`.

### Scopes
| Scope | Grants |
|---|---|
| `event_types:read` / `event_types:write` | `/events` |
| `availability:read` / `availability:write` | schedules, `/availability/slots` |
| `bookings:read` / `bookings:write` | `/bookings` (create, cancel, reschedule) |
| `contacts:read` / `contacts:write` | `/contacts` |
| `calendars:read` | `/calendars` |
| `organizations:read` | `/organizations` |
| `webhooks:manage` | `/webhooks` |

## Conventions
- JSON, snake_case. Timestamps are ISO-8601 UTC.
- **Errors**: `{"error":{"code":"VALIDATION","message":"...","details":[{"path":"event_id","message":"..."}],"request_id":"req_..."}}`.
  Codes: `UNAUTHORIZED` 401, `INSUFFICIENT_SCOPE`/`ACCOUNT_SUSPENDED`/`FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT`/`SLOT_UNAVAILABLE`/`SLUG_TAKEN` 409, `VALIDATION` 422, `RATE_LIMITED` 429, `INTERNAL` 500.
- **Request ids**: every response carries `X-Request-Id` (a valid incoming one is echoed).
- **Rate limiting** per key (default 120 req/min, env `API_RATE_LIMIT`): `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix seconds); `429` adds `Retry-After`.
- **Pagination**: `?limit=1..100&cursor=...` returns `{ "data": [...], "has_more": true, "next_cursor": "..." }`.
- **Idempotency**: `POST /bookings` accepts `Idempotency-Key` header or `idempotency_key` body field; replays return `200` with the original booking (scoped per API key).
- **Audit**: every mutating call is written to `audit_log` (actor, action, entity, key id, request id, IP).

## Endpoints
| Method & path | Scope | Notes |
|---|---|---|
| `GET /events` | event_types:read | `include_archived`, `is_active` filters |
| `POST /events` | event_types:write | snake_case fields (title, slug, duration_minutes, location_type, ...) |
| `GET/PATCH/DELETE /events/{id}` | read/write | PATCH merges onto current values |
| `GET /availability/schedules`, `POST` | availability:read/write | |
| `GET/PUT/DELETE /availability/schedules/{id}` | availability:read/write | PUT replaces name, time_zone, rules, overrides |
| `GET /availability/slots?event_id&from&to&time_zone` | availability:read | max 31 day range |
| `GET /bookings` | bookings:read | filters `status, event_id, from, to, invitee_email` |
| `POST /bookings` | bookings:write | goes through the booking service: `409 SLOT_UNAVAILABLE` on conflicts; returns `manage_token` once |
| `GET /bookings/{id}` | bookings:read | |
| `POST /bookings/{id}/cancel` | bookings:write | body `{reason?, scope?: "occurrence"|"series"}`; `series` cancels every future occurrence of the booking's recurring series |
| `POST /bookings/{id}/approve` | bookings:write | host approves a `pending_confirmation` request (a series is approved as a whole); idempotent |
| `POST /bookings/{id}/decline` | bookings:write | body `{reason?}`; declines a `pending_confirmation` request: slot released, invitee emailed, paid bookings refunded; status becomes `cancelled` (`cancelled_by: "host"`) |
| `POST /bookings/{id}/reschedule` | bookings:write | body `{starts_at, reason?}` |
| `GET /calendars` | calendars:read | connected calendars (no credentials) |
| `GET /organizations`, `/{id}`, `/{id}/members` | organizations:read | |
| `GET/POST /contacts`, `GET/PATCH/DELETE /contacts/{id}` | contacts:read/write | `email`, `search` filters |
| `GET/POST /webhooks`, `GET/PATCH/DELETE /webhooks/{id}` | webhooks:manage | secret returned once on create |
| `GET /webhooks/{id}/deliveries`, `POST /webhooks/{id}/rotate-secret` | webhooks:manage | |

Booking `status` values: `pending_payment`, `pending_confirmation` (event has `requires_confirmation`; waiting for approve/decline), `confirmed`, `cancelled`, `rescheduled`, `completed`, `no_show`, `expired`. Webhook events additionally include `booking.declined`; webhook `booking` objects carry `series_id`.
Creating a booking for a recurring event type books the whole series atomically: the response has the first occurrence at the top level plus `series: [...]` (every occurrence with its own `manage_token`, shared `series_id`). If any occurrence is unavailable the call fails with `409 SLOT_UNAVAILABLE` and `error.details.failedOccurrence/failedStartsAt`; nothing is booked. The `Idempotency-Key` covers the whole series.

### Create a booking
```
curl -X POST https://HOST/api/v1/bookings -H "Authorization: Bearer mf_live_xxx" -H "Idempotency-Key: abc-123" \
  -H "Content-Type: application/json" \
  -d '{"event_id":"<uuid>","starts_at":"2026-12-01T15:00:00Z","invitee":{"name":"Ada","email":"ada@example.com","time_zone":"Europe/London"}}'
```

## Super-admin area
`/admin` (requires `platform_role = superadmin`): users (search, suspend/reactivate; suspension revokes sessions and blocks sign-in),
organizations, plans (limits JSON editor) and subscriptions, booking statistics, system health (DB, Redis, queues, worker heartbeat,
failed jobs, webhook failures), audit log viewer, platform configuration. All admin mutations are audited.
