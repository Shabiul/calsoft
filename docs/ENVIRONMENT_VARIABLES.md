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
