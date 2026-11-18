# MeetFlow integrations setup

MeetFlow never fakes a connection. If a provider's `*_CLIENT_ID` / `*_CLIENT_SECRET` env vars are missing, the
Integrations page (`/dashboard/integrations`) shows "Requires credentials" and the exact redirect URI to register.
Nothing here is verified/approved by Google, Microsoft or Zoom on your behalf: you must complete each provider's
own verification steps described below before real (non-test) users can connect.

Replace `https://app.example.com` with your `APP_URL` (no trailing slash). For local dev, `http://localhost:3000` works for
OAuth (Google/Microsoft allow `http://localhost`; Zoom allows it for dev apps), but **push notifications require public
HTTPS**; without it MeetFlow polls every ~10 minutes and re-checks live at booking time.

## Environment

| Variable | Purpose |
|---|---|
| `ENCRYPTION_KEY` | base64 of 32 random bytes (`openssl rand -base64 32`). Encrypts stored OAuth tokens (AES-256-GCM) and signs OAuth state/webhook secrets. **Rotating it disconnects every integration.** |
| `APP_URL` | Public base URL; redirect URIs and webhook URLs derive from it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar + Meet |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Outlook calendar + Teams |
| `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | Zoom meetings |
| `CRON_SECRET` (optional) | Enables `POST /api/integrations/sync` (header `x-cron-secret`) which polls stale calendars and renews push channels. Call it every 10-15 min from cron, or call `syncAllDue()` from the worker. |

## Redirect URIs (exact)

- Google: `https://app.example.com/api/integrations/google/callback`
- Microsoft: `https://app.example.com/api/integrations/microsoft/callback`
- Zoom: `https://app.example.com/api/integrations/zoom/callback`

Webhook endpoints (registered automatically through the APIs; nothing to paste in consoles):
`/api/webhooks/google-calendar` (Google `events.watch`), `/api/webhooks/microsoft-graph` (Graph subscriptions, answers the
`validationToken` handshake).

## Google (Calendar + Meet)

1. https://console.cloud.google.com -> create/select a project.
2. APIs & Services -> Library -> enable **Google Calendar API**.
3. APIs & Services -> OAuth consent screen (Google Auth Platform -> Branding/Audience): User type **External**, set app name,
   support email, authorized domain (your domain), privacy policy and terms URLs, developer contact.
4. Data access / Scopes -> add:
   - `openid`, `.../auth/userinfo.email` (non-sensitive)
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.freebusy`
   - `https://www.googleapis.com/auth/calendar.events` (all three calendar scopes are **sensitive**)
5. Credentials -> Create credentials -> OAuth client ID -> **Web application**. Authorized redirect URI: the Google URI above.
   Copy the client id/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
6. Push notifications: Google only delivers to HTTPS URLs with a valid certificate. In the Search Console / domain verification
   section of the Cloud console, **verify ownership of your domain** (APIs & Services -> Domain verification) or `events.watch`
   returns an "unauthorized domain" error.
7. **Publishing status / verification**: while the app is in *Testing*, only listed test users can connect and refresh tokens expire after
   7 days (connections will flip to "Reconnect required"). To serve real users, click *Publish app* and submit for **OAuth verification**
   (required because the calendar scopes are sensitive): you need a verified domain, a public homepage, privacy policy, a scope
   justification and a demo video. Verification is performed by Google and can take days to weeks. Unverified apps show a warning screen
   and are capped at 100 users.
8. Google Meet links are created via `conferenceData` on the booking event: no extra scope or API. The host needs a Google destination
   calendar selected on the Integrations page.

## Microsoft (Outlook calendar + Teams)

1. https://entra.microsoft.com -> Identity -> Applications -> App registrations -> **New registration**.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (we use the `/common` endpoint).
3. Redirect URI: platform **Web**, the Microsoft URI above.
4. Certificates & secrets -> New client secret (copy the **Value**, not the ID) -> `MICROSOFT_CLIENT_SECRET`.
   Application (client) ID -> `MICROSOFT_CLIENT_ID`. Secrets expire (max 24 months): set a reminder.
5. API permissions -> Add -> Microsoft Graph -> **Delegated**: `offline_access`, `openid`, `email`, `User.Read`, `Calendars.ReadWrite`.
   None need admin consent for personal accounts; some organizations restrict user consent: their admin can grant it tenant-wide.
6. Teams meeting links: created via `isOnlineMeeting` on the event (work/school accounts with Teams licenses only; personal Outlook.com
   accounts cannot create Teams meetings). No extra permission required.
7. Webhooks: Graph validates `/api/webhooks/microsoft-graph` (must be public HTTPS, answering the `validationToken` query within 10 s).
   Subscriptions last ~70 hours and are renewed by `syncAllDue()` / the cron endpoint.
8. **Publisher verification**: unverified multi-tenant apps show an "unverified" label and many organizations block user consent for them.
   Complete Entra -> Branding & properties -> *Publisher domain* + **Microsoft Partner Network (MPN/Partner Center) verification** to remove it.
   This is performed by Microsoft; MeetFlow does not claim it.

## Zoom

1. https://marketplace.zoom.us -> Develop -> Build App -> **General App** (OAuth, user-managed).
2. App name; OAuth redirect URL: the Zoom URI above; add it to the OAuth allow list too. Enable **Use PKCE** if offered.
3. Scopes (Scopes tab, granular): `meeting:write:meeting`, `meeting:update:meeting`, `meeting:delete:meeting`, `user:read:user`.
4. Copy Client ID / Client Secret -> `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET`.
5. Development credentials work only for your own account. For other users, complete the *Publish* section (listing info, privacy policy,
   support URLs, security questionnaire) and submit for **Zoom Marketplace review** (or distribute as an unlisted/"Account-level" app inside one
   organization). Zoom performs the review.
6. Each booking gets its own meeting (`POST /users/me/meetings`), updated on reschedule, deleted on cancel. Zoom rotates refresh tokens;
   MeetFlow persists the new one on every refresh.

## How it behaves

- **Conflict checks**: only calendars with "Check conflicts" on (primary is on by default) block slots. `getExternalBusy(userId, from, to)`
  (`src/server/integrations/busy.ts`) unions the synced cache and a live provider query; on provider failure it falls back to the cache.
  Connections in `needs_reauth` are skipped (never silently treated as busy or free-forever: the UI shows "Reconnect required").
- **New bookings**: `afterBookingCreated/Updated/Cancelled(bookingId)` in `booking-sync.ts` create/patch/delete the event on the host's destination
  calendar and the Zoom meeting. Ids live in `booking.external_event_ids` (`cal:<calendar id>`, `zoom`), join link in `booking.meeting_url`.
  The calls never throw. They are idempotent (deterministic Google event ids, Graph `transactionId`, per-booking advisory lock).
  Failures are logged to `booking_event` (`integration_sync_failed`) and retryable ones are enqueued on queue `scheduler` as job
  `integration-booking-sync` (`{bookingId, attempt}`); the worker must call `processIntegrationJob(data)`.
- **Revoked / expired tokens**: a refresh that returns `invalid_grant` (or a repeated 401) sets `connected_calendar.status = 'needs_reauth'`.
  Transient errors (5xx, 429, network) never flip the status.
- **Own bookings**: events MeetFlow creates are tagged (`meetflowBookingId` extended property / `MeetFlow` category) and are not re-imported as busy.

## Not covered / limitations

- Collective and round-robin events create the external event only for the booking's `host_user_id`.
- The busy cache window is now-1 day .. +120 days; the live check covers anything beyond it only when callers query that range.
- Zoom meeting creation is not idempotent on Zoom's side; a crash between creating the meeting and saving its id can orphan one meeting.
