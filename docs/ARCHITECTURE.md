# MeetFlow Architecture & Agent Contract

Stack: Next.js 16 (App Router, READ node_modules/next/dist/docs before using APIs — it differs from older versions;
e.g. middleware may be `proxy.ts`), TS strict, Tailwind v4, Drizzle + Postgres 17, BullMQ + Redis, Better Auth.
Dev infra: `docker compose -f docker-compose.dev.yml up -d` (PG :54329, Redis :63799). Env in `.env.local`.
DB: `npm run db:generate` then `npm run db:migrate` (runs drizzle migrations + drizzle/constraints.sql).
Schema is `src/server/db/schema.ts` (authoritative). Additive changes to the schema are allowed ONLY for your own
feature tables/columns; never rename/remove existing ones; regenerate migration, never edit applied migrations.

## Layering
- `src/server/**`  business logic. NO React, NO next/headers inside pure services (take userId/tenant as args).
- `src/app/**`     transport/UI only: server actions & route handlers validate with Zod, authorize, call services.
- Services return typed results or throw `AppError(code, message, status)` from `src/server/errors.ts`.
- Authorization is server-side always (`requireUser()`, `requireOrgRole(orgId, min)`).
- All timestamps UTC `timestamptz`; keep IANA tz alongside. Use Luxon for tz math.

## Shared contracts (names are fixed so agents can work in parallel)
- `src/server/errors.ts`: `class AppError extends Error { code; status }` (owner: core agent, create first)
- `src/lib/auth-session.ts`: `getSession()`, `requireUser(): Promise<SessionUser>` (redirects/throws 401), `requireSuperadmin()`. (owner: auth agent, create FIRST)
- `src/lib/crypto.ts`: `encrypt(str)`, `decrypt(str)` AES-256-GCM using ENCRYPTION_KEY; `sha256(str)`; `randomToken()`. (owner: integrations agent, create FIRST)
- `src/server/queue/index.ts`: `getQueue(name)`, queue names, `enqueue(name, job, opts)`; `emitEvent(type, payload)` fans out to webhooks+workflows+notifications. (owner: worker agent, create FIRST)
- `src/server/scheduling/slots.ts`: `getAvailableSlots({eventTypeId, from, to, inviteeTimeZone, excludeBookingId?}) => Promise<{startsAt: string(ISO UTC), hostUserId: string}[]>`
- `src/server/services/booking.ts`: `createBooking(input)`, `rescheduleBooking`, `cancelBooking`, `markBooking(status)`, `getBookingByManageToken`.
  createBooking input: `{eventTypeId, startsAt(ISO), invitee:{name,email,phone?,timeZone}, answers?, idempotencyKey?}`
  Returns `{booking, manageToken}`. Throws AppError('SLOT_UNAVAILABLE',..,409) on conflict.
- `src/server/integrations/provider.ts`: `CalendarProvider` interface { getCalendars, getBusyIntervals, createEvent, updateEvent, deleteEvent, refreshSubscription } + `getProvider(name)`; `src/server/integrations/busy.ts`: `getExternalBusy(userId, from, to) => Interval[]` (merges cached + live check).
- `src/components/ui/*`: shadcn-style primitives (Button, Input, Label, Textarea, Select, Dialog, Sheet, DropdownMenu, Tabs, Switch, Checkbox, Badge, Card, Skeleton, Tooltip, Toaster/sonner, EmptyState, DataTable-lite). (owner: auth/shell agent, create FIRST and quickly)
- Public routes: `/[username]`, `/[username]/[eventSlug]`, `/booking/[token]` (manage). Reserved usernames must be blocked (`login, signup, dashboard, api, booking, admin, embed, ...`).
- App routes live under `src/app/(app)/dashboard/...`; auth under `src/app/(auth)/...`.

## Rules
- Never fake data; empty states instead. Every button works. Handle error states. No `any` without reason.
- Don't touch files owned by other agents; if you need a contract change, add a small adapter on your side and note it in your report.
- Each agent: write tests (vitest) for its logic, run `npm run typecheck` on files you own (other agents' in-progress errors are not yours), and finish with a concise report: files, tests run+results, gaps, creds needed.
- Do NOT run `npm install` of new packages without need; if you must, use `npm i <pkg> --legacy-peer-deps` and only once. Do NOT run `next build` or `next dev` on the shared port concurrently (use PORT env unique to you if you need a dev server).
- Don't wipe the dev DB. Tests must create their own isolated data (unique ids) and clean up.
