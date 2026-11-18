# Database design

Authoritative schema: `src/server/db/schema.ts` (Drizzle). Migrations: `drizzle/*.sql` (generated, never edit applied ones). DB-level integrity that Drizzle cannot express lives in `drizzle/constraints.sql`, applied idempotently by `scripts/migrate.ts` after the migrations.

## Table groups (from schema.ts)

- Auth and tenancy: user, session, account, verification, two_factor, organization, organization_member, invitation
- Availability: availability_schedule, availability_rule, availability_override, blocked_time
- Event types: event_type, event_host, event_question, booking_page_setting
- Bookings: booking, invitee, invitee_answer, booking_event, contact, contact_note
- Calendars/video: connected_calendar, calendar, calendar_sync_state, calendar_busy, video_connection
- Payments/billing: payment, refund, subscription_plan, subscription, usage_record
- Notifications/automation: reminder, notification_log, notification_template, workflow, workflow_step, workflow_execution, routing_form
- Platform: api_key, webhook_endpoint, webhook_delivery, page_view, audit_log

## Integrity rules

- All timestamps are `timestamptz` (UTC); the IANA time zone is stored alongside where relevant.
- `booking.block_range` is a generated `tstzrange(block_start, block_end, '[)')`. Exclusion constraint `booking_no_overlap` (GiST, needs `btree_gist`) prevents overlapping `confirmed` / `pending_payment` / `pending_confirmation` bookings per host where `exclusive_slot` is true. Group events set `exclusive_slot = false`; capacity is enforced in the service under an advisory lock.
- `booking_time_order` check: `ends_at > starts_at`, `block_end >= ends_at`, `block_start <= starts_at`.
- Under pgbouncer transaction pooling only transaction-scoped advisory locks are safe.

## Operations

- Migrations run via the `migrate` compose service directly against Postgres.
- Postgres is initialised with data checksums; tuned for 2 GB (see docker-compose.prod.yml).
- Backups and restore verification check the exclusion constraint survives a restore (BACKUP_AND_RESTORE.md).

An ER diagram is not yet produced.

## Scheduling engine: booking integrity design

- **Authoritative guard**: `booking_no_overlap` EXCLUDE (host_user_id, block_range) over `confirmed`/`pending_payment`/`pending_confirmation` rows with `exclusive_slot` (the list lives in `drizzle/constraints.sql`, which drops and re-adds the constraint idempotently on every `db:migrate`; `ACTIVE_STATUSES` in `scheduling/slots.ts` and `ACTIVE` in `services/booking.ts` mirror it). `block_range` = start-buffer..end+buffer, so buffers are protected too.
- **Service layer** (`src/server/services/booking.ts`): each create/reschedule runs in one transaction that first takes `pg_advisory_xact_lock` on `event:<id>` and every candidate `host:<userId>` (sorted, deadlock-free), re-runs the slot engine (`computeSlots`) inside the transaction, then inserts. A `23P01` from the constraint is mapped to `AppError('SLOT_UNAVAILABLE', 409)`.
- **Group events**: rows have `exclusive_slot = false`; capacity is checked under the event lock (count of active rows at the same `starts_at` < `capacity`). Overlap with a *different* start of the same event, or with any other event's bookings, still blocks the host.
- **Collective events**: one `booking` row per required host, all with identical times, each `exclusive_slot = true`, so the exclusion constraint protects every host's calendar. The primary host's row (first required host) holds `manage_token_hash` and `idempotency_key`; the other rows are linked by `external_event_ids->>'collectiveOf' = <primary booking id>` (no schema change). Cancel / reschedule / mark operate on the whole group; each host sees their own row (and invitee copy) in their bookings list. List UIs that must show one meeting per collective booking should hide rows with `external_event_ids ? 'collectiveOf'`.
- **Reschedule**: old rows are set to `rescheduled` (leaving the constraint) before the new rows are inserted; new primary row has `rescheduled_from_id` = old id. Nothing is deleted; `booking_event` keeps the history. **Cancel** sets `status = 'cancelled'` and never deletes.
- **Booking statuses**: `pending_payment` (slot held 15 min until paid), `pending_confirmation` (host approval requested; slot held, no expiry while the start is in the future), `confirmed`, `cancelled`, `rescheduled`, `completed`, `no_show`, `expired`. `pending_confirmation` was added by an additive migration (`ALTER TYPE ... ADD VALUE`, `drizzle/0005_*`); because Postgres cannot use a new enum value in the transaction that adds it, the exclusion constraint that references it is (re)created in `constraints.sql`, which runs after the migrations in a separate statement batch.
- **Approval flow** (`event_type.requires_confirmation`): create => `pending_confirmation`; paid events are **pay first**: `pending_payment` -> (payment settles) -> `pending_confirmation` (`markBooking`/payment settlement map "confirmed" through `statusAfterPayment`). Host **approve** => `confirmed` (events `booking.confirmed` + `approved: true`); host **decline** => `cancelled` with `cancelled_by = 'host'` and the reason in `cancel_reason` (event `booking.declined`; the refund policy refunds a paid booking in full because the host cancelled). Unanswered requests whose start passed become `expired` (worker job `expire-holds`). Reminders, workflows and calendar/video sync only run for `confirmed` rows, i.e. after approval.
- **Recurring series** (`event_type.recurrence = {count, interval: week|month}`, `booking.series_id`): `createBooking` computes all occurrence starts from the first start with Luxon calendar arithmetic in the primary host's schedule time zone (weekly = same weekday and local time across DST; monthly = same local day, clamped to the month end, each computed from the first start so a clamp never drifts), validates **every** occurrence with the slot engine inside the one transaction (same advisory locks), then inserts one `booking` row (own manage token hash, invitee row, answers, history) per occurrence sharing `series_id`. If any occurrence is unavailable the transaction aborts: `SLOT_UNAVAILABLE` with `details = {failedOccurrence, failedStartsAt, count}` and nothing is reserved; the exclusion constraint remains the backstop (`23P01` is mapped to the same error naming the occurrence). The idempotency key sits on occurrence 1 only; a replay returns the whole series. Only the first occurrence is bound by `max_horizon_days`. Series are not supported for group events (ignored) or paid events (rejected). Cancel/reschedule act on one occurrence; `scope: "series"` cancels every still-cancellable future occurrence in one transaction. Approve/decline of a series applies to all its pending occurrences.
- **Manage token**: random 32 bytes (base64url) returned once; only its SHA-256 hex is stored. An idempotent replay returns the existing booking with `manageToken: null`.
