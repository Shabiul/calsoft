# Implementation status

Legend: [x] verified (by what), [~] written but NOT verified, [ ] not done. Updated by the infrastructure agent on 2026-11-17; feature areas owned by other agents are marked unknown here and must be updated by them.

## Infrastructure and delivery

- [x] `docker compose -f docker-compose.prod.yml config` validates with the example env file
- [x] Web Dockerfile: `docker build -t meetflow-web .` succeeds (2026-11-17); image never run
- [x] Worker Dockerfile: `docker build -f Dockerfile.worker` succeeds; container never run
- [~] Compose stack runtime (health ordering, pgbouncer scram auth, redis password, internal network): never started
- [~] Caddyfile (TLS, headers, limits): not validated with `caddy validate`, no real domain tested
- [x] Shell scripts pass `bash -n` syntax check; shellcheck not run (not installed)
- [~] vps-setup.sh: never run on Ubuntu
- [~] backup.sh / restore-verify.sh / restore.sh: never run; no restore drill performed
- [~] monitor scripts: never run
- [~] next.config.ts security headers (CSP etc.): not checked in a browser; CSP uses `'unsafe-inline'`
- [~] `/api/health` + readiness: not run
- [~] Sentry via `src/instrumentation.ts`: only active with SENTRY_DSN; no DSN tested
- [~] CI workflow: not run on GitHub
- [~] Playwright skeleton: smoke tests not run; full e2e flow not written

## Product features (status as of 2026-11-17)

Verification so far: `tsc --noEmit` clean, `eslint` 0 errors, `vitest` 364 tests / 28 files pass against real Postgres + Redis, `next build` succeeds, both Docker images build. Playwright (Edge, production build + worker): 10/10 pass (8 original + approval flow + recurring series, 2026-11-18) — full flow (signup -> availability -> event type via UI -> guest books -> dashboard -> ICS -> reschedule -> cancel, history preserved, notification rows written by worker), two-browser same-slot race (exactly one wins), IST vs New York rendering, 390px mobile, dark mode. A render/click sweep of every dashboard, admin, docs and public route found and fixed 7 defects (see git history); payment, OAuth and calendar-connect flows were not clicked through. New accounts now get a default Mon-Fri 9-5 schedule.

| Area | State | Evidence / caveat |
|---|---|---|
| Schema, migrations, `booking_no_overlap` EXCLUDE constraint | [x] | Real DB; overlapping insert rejected (23P01) |
| Scheduling engine (slots, tz, DST, buffers, limits, min notice/horizon) | [x] | Unit tests incl. NY/London DST boundaries, Kolkata |
| Double-booking prevention | [x] | 10 concurrent createBooking -> 1 success; same via REST API; group capacity race |
| Booking create / reschedule / cancel / mark, history kept | [x] | Integration tests; public UI exercised in Edge |
| Requires-confirmation bookings (`pending_confirmation`) | [x] | Real-DB tests: slot held while pending (also at DB level: exclusion constraint includes the status), release on decline, 6 concurrent requests -> 1 wins, approve idempotent, withdraw, paid-then-approval, unanswered requests expire; emails (request received, approval request, approved, declined) via handler tests + e2e with worker; reminders/calendar/workflows only after approval; host approve/decline in the Scheduled drawer (e2e), `POST /api/v1/bookings/{id}/approve|decline`. Rule: **pay first, then host approval**. Caveats: the "approved"/"declined" emails carry no manage link (only the hash of the token is stored; the link in the request email stays valid); an expired request notifies the invitee with the "declined" template; approve/decline of a series applies to all its pending sessions |
| Recurring bookings (`event_type.recurrence`, `booking.series_id`) | [x] | Real-DB tests: N sessions reserved atomically in one transaction under the same advisory locks, all-or-nothing with the failing session reported (blocked by another booking and by blocked time), DST (America/New_York across 2026-03-08 and 2026-11-01 keep 09:00 local), month-end clamp, cancel one vs series (notice window respected per session), reschedule one keeps the series id, concurrent overlapping series -> exactly one wins, replay of the idempotency key returns the series; e2e: recurrence set via the event-type form, "3 weekly sessions" preview, booking, cancel. Caveats: paid recurring events are rejected (one price per series is undefined), group events never recur, only the first session is bound by max horizon, the series time zone is the primary host's schedule zone, one confirmation email per series (link = first session), each session has its own manage token returned only at creation |
| Round-robin, collective, group | [x] | Real-DB tests; collective = one row per host |
| Auth: email/password, reset, username, 2FA | [~] | signup/login/reset verified; 2FA enrolment, avatar upload, account deletion untested |
| Google / Microsoft OAuth sign-in | [~] | Needs client credentials; never run |
| Calendar integrations (Google, Microsoft, Zoom, Meet, Teams) | [~] | Mocked-HTTP tests only; NOT verified against real providers; needs credentials + provider verification |
| Payments (Razorpay, Stripe), refunds, reconciliation | [~] | State machine + signatures + DB flows tested with faked SDK calls; not run against real/test accounts |
| Billing / subscriptions | [~] | Same as payments; plan->provider price mapping has no admin UI |
| Worker, reminders, notifications, workflows, outgoing webhooks | [x] | Real Redis/PG integration tests incl. worker restart; email provider unverified (dev-log fallback; needs RESEND_API_KEY or SMTP_URL) |
| Public booking pages, manage page, ICS, embeds | [x]/[~] | Verified in Edge; widget.js not tested on a third-party page |
| Teams / organizations / invites | [~] | Service tests pass; UI not browser-verified |
| Contacts, routing forms, analytics | [~] | Service tests pass; UI not browser-verified |
| REST API v1 + OpenAPI | [x] | Handler-level tests (auth, scopes, rate limit, tenant isolation); routes not exercised over HTTP |
| Super-admin | [~] | Service tests pass; pages not browser-verified |

Honest limitations: public 404 pages return HTTP 200 + noindex (Cache Components streaming); user/org handle race closed only on the org side; calendar view uses browser tz; no load/performance measurement or external security review yet.

## Known gaps

- No offsite backup destination configured; no uptime monitor; no image digest pinning
- No nonce-based CSP
- No load testing, no security review, no ER diagram
