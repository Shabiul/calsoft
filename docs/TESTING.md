# Testing

## Unit / integration
`npm test` (vitest). Integration tests live in `tests/integration` and need dev Postgres/Redis.

## End-to-end (Playwright)
Runs against an already running **production** build, system Edge (`channel: msedge`), default `http://localhost:3205`.

```
docker compose -f docker-compose.dev.yml up -d
npm run build
APP_URL=http://localhost:3205 BETTER_AUTH_URL=http://localhost:3205 npx next start -p 3205
APP_URL=http://localhost:3205 WORKER_HEALTH_PORT=4205 npm run worker     # notifications/reminders
npx playwright test
```
- `E2E_BASE_URL` overrides the URL; `E2E_CHANNEL=""` uses bundled chromium (`npx playwright install chromium`).
- Email uses the dev-log fallback; the tests assert `notification_log` rows (worker required).
- Data: every user is `<unique>@e2e.meetflow.test`; `cleanupUsers()` deletes users, event types, bookings and
  notification rows after each spec. Uses `DATABASE_URL` (default dev DB) via `pg`.

Specs (`tests/e2e`):
- `booking-flow.spec.ts`: host signup, availability, event type, copy link, integrations page shows "Requires credentials",
  guest (IST, no login) books, confirmation + DB booking/invitee/notification_log + ICS + host dashboard, reschedule
  (old row `rescheduled`, history kept, slot freed), cancel with reason (row preserved).
- `multi.spec.ts`: concurrency (exactly one winner), timezones (IST vs New York), mobile 390px, dark-mode smoke.
- `event-type-ui.spec.ts`: strict UI event-type creation (fails while the bug below exists).
- `approval-series.spec.ts`: requires-confirmation (request -> "Request sent, awaiting approval", request emails, slot held, host approves in the Scheduled events drawer -> approved email + reminders; second request declined with reason -> slot released) and a recurring series (recurrence toggled in the event-type form, "3 weekly sessions" preview, atomic booking, cancel one session, cancel the series from the manage page).
- `smoke.spec.ts`: health and headers.

`createEventType` falls back to a DB insert if `/dashboard/event-types/new` is broken, so the rest of the flow still runs.

## Known app bugs found by e2e
- `/dashboard/event-types/new` and `/dashboard/event-types/[id]` crash with the "This page couldn't load" error page. The
  server pages call `defaultFormState()` / `stateFromEventType()`, which are exported from the `"use client"` module
  `src/components/event-types/event-type-form.tsx`. Fix: move them to a non-client module, or pass raw data to the form.
