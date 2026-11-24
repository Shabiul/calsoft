# Environment variables

Dev: `.env.local` (from `.env.example`). Production: `/opt/meetflow/.env.production` (from `deploy/.env.production.example`), chmod 600. In production `DATABASE_URL` and `REDIS_URL` are composed by `docker-compose.prod.yml` from the `POSTGRES_*` and `REDIS_PASSWORD` values, so do not set them there.

| Variable | Required | Notes |
| --- | --- | --- |
| APP_NAME | no | Display name, default MeetFlow |
| APP_URL | yes | Public origin, e.g. https://meet.example.com (auth callbacks, email links) |
| APP_DOMAIN | prod | Hostname for Caddy/TLS |
| ACME_EMAIL | prod | Let's Encrypt contact |
| DATABASE_URL | yes (dev) | Postgres URL. Prod: via pgbouncer; migrations go direct |
| POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD | prod | Password: `openssl rand -hex 32` |
| REDIS_URL | yes (dev) | BullMQ and rate limits |
| REDIS_PASSWORD | prod | `openssl rand -hex 32` |
| BETTER_AUTH_SECRET | yes | >= 32 chars; rotating invalidates sessions |
| ENCRYPTION_KEY | yes | base64 of 32 bytes; encrypts stored OAuth tokens; losing it loses them |
| GOOGLE_CLIENT_ID / _SECRET | optional | Google Calendar + Meet |
| MICROSOFT_CLIENT_ID / _SECRET | optional | Outlook calendar |
| ZOOM_CLIENT_ID / _SECRET | optional | Zoom links |
| ALLOWED_EMAIL_DOMAINS | **required** | Comma-separated company email domains (e.g. `acme.com,acme.in`). Only Zoho accounts on these domains can sign in; new employees get an account on first sign-in. Unset = nobody new can sign in. Also gates team invitations and API keys. Platform superadmins are exempt |
| ZOHO_CLIENT_ID / _SECRET / ZOHO_DC | **required** | Sign-in (Zoho is the only login: no sign-up form, no passwords) and Zoho Calendar + Meeting. Register both redirect URIs on the Zoho client: `<APP_URL>/api/auth/callback/zoho` and `<APP_URL>/api/integrations/zoho/callback`. ZOHO_DC = data center of the Zoho account (com, in, eu, com.au, jp, ca, sa, uk). Set on web and worker |
| RESEND_API_KEY or SMTP_URL | one needed for email | |
| EMAIL_FROM | yes for email | `Name <addr>` |
| RAZORPAY_KEY_ID / _KEY_SECRET / _WEBHOOK_SECRET | optional | Payments (INR) |
| STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET | optional | Payments |
| SENTRY_DSN | optional | Sentry initialises only when set |
| SENTRY_TRACES_SAMPLE_RATE | optional | default 0.05 |
| BACKUP_DIR, BACKUP_AGE_RECIPIENT, BACKUP_AGE_IDENTITY, BACKUP_RETENTION_DAILY/WEEKLY/MONTHLY, RCLONE_REMOTE | prod | Backup scripts only |
| ALERT_WEBHOOK_URL, ALERT_EMAIL, DISK_ALERT_PCT, MEM_ALERT_PCT | optional | Monitor scripts only |
| E2E_BASE_URL | test | Run Playwright against an existing server |

Note: the web/worker containers load the whole `.env.production` (`env_file`), including backup/alert values; those are harmless but keep the file at 600. `BACKUP_AGE_IDENTITY` (private key path) should not be set in it permanently.

## Using Supabase Postgres

Production runs on Supabase (PostgreSQL 17, ap-southeast-1). `DATABASE_URL` is the **transaction pooler** (port 6543):

```
postgresql://postgres.<project-ref>:<db-password>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true
```

- `uselibpqcompat=true` is required. Without it node-postgres verifies the pooler's certificate against Node's CA list and fails with "self-signed certificate in certificate chain".
- Run migrations (`npm run db:migrate`) and `pg_dump`/`psql` through the **session pooler** (same host, port 5432), not 6543.
- The app only uses transaction-scoped advisory locks (`pg_advisory_xact_lock`), so it is safe behind the transaction pooler. Do not add session-level locks, `LISTEN`, or named prepared statements.
- `drizzle/constraints.sql` revokes all privileges on the `public` schema from Supabase's `anon` / `authenticated` roles (its REST API is otherwise reachable with the publishable key). The app connects as the table owner and needs neither. The block is a no-op on non-Supabase databases.
- `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` turn on **Supabase Auth sign-in** (emailed code, password, magic link) on the login page. Supabase only proves who the person is; MeetFlow keeps its own sessions and users. The secret key is not used by the app.
- Text collation on Supabase is `en_US.UTF-8` (previously `C.UTF-8`): lists sort alphabetically rather than by character code.

## Sign-in, admins and alerts

| Variable | Purpose |
| --- | --- |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated company domains. Zoho and Supabase (email) sign-in accept only these (plus superadmins). Google is open. |
| `SUPERADMIN_EMAILS` | Comma-separated emails that become platform superadmins at their next sign-in (full `/admin` access). Only verified emails count. |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Enable Supabase Auth sign-in. In the Supabase dashboard: enable the Email provider (keep "Confirm email" on), put `{{ .Token }}` in the Magic Link and Confirm signup templates, add `<APP_URL>/auth/supabase` to the redirect URLs, and set up custom SMTP (the built-in sender allows only a few emails an hour). |
| `ALERT_EMAILS` | Who gets operational alerts (failing emails, late reminders, stuck queue). Falls back to `SUPERADMIN_EMAILS`. At most one alert per hour. |

### Uptime and backups

- `.github/workflows/uptime.yml` calls `/api/health?ready=1&worker=1` every 10 minutes (website, Postgres, Redis, worker heartbeat). A failure emails the repository owner. Set the repository variable `UPTIME_URL` to monitor another address.
- `scripts/backup.sh` writes a compressed `pg_dump` with 14-day rotation and checks that the archive lists the booking table. Run it daily from cron on the worker host using the **session pooler** URL, and set `BACKUP_RCLONE_REMOTE` to copy the file off the machine.
