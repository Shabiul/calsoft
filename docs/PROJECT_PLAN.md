# Project plan

Goal: a self-hostable Calendly-style scheduling product (MeetFlow) for individuals and teams, deployable on a single VPS.

## Scope (from the schema and architecture contract)

1. Auth and accounts: email/password, social login, 2FA, organizations, roles, invitations.
2. Availability: schedules, weekly rules, date overrides, blocked time, time-zone correct slot generation.
3. Event types: one-on-one, group (capacity), round-robin/collective hosts, custom questions, booking page settings.
4. Booking lifecycle: create (idempotent, conflict-safe), reschedule, cancel, mark no-show, manage links by token.
5. Integrations: Google/Microsoft calendars (busy sync, event create), Zoom/Meet links.
6. Payments: Stripe and Razorpay, refunds.
7. Notifications and workflows: reminders, email templates, webhooks, workflow automation, routing forms.
8. Platform: API keys, webhooks, analytics (page views), audit log, subscription plans and usage.
9. Operations: Docker deployment, backups, monitoring, CI.

## Phases

| Phase | Content | State |
| --- | --- | --- |
| 0 | Schema, architecture contract, dev infra | done (see IMPLEMENTATION_STATUS) |
| 1 | Auth, shell, availability, event types, booking engine | in progress (other agents) |
| 2 | Integrations, notifications, worker | in progress |
| 3 | Payments, workflows, API, billing | planned |
| 4 | Hardening: e2e suite, security review, load test, restore drill | planned |
| 5 | Launch on VPS | planned |

State reflects delegated work in progress; confirm against IMPLEMENTATION_STATUS.md.
