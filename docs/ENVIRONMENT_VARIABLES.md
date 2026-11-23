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
- Supabase's own keys (`SUPABASE_*`) are not used by the app: it uses its own auth tables, not Supabase Auth.
- Text collation on Supabase is `en_US.UTF-8` (previously `C.UTF-8`): lists sort alphabetically rather than by character code.
