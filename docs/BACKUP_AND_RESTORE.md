# Backup and restore

Status: scripts written and syntax-checked only. A real backup/restore drill has NOT been run yet; run one before launch.

## What is backed up

PostgreSQL only (`pg_dump -Fc`, custom format, compressed). Redis holds only queue state and is reconstructible (pending jobs may be lost; reminders are re-derivable from bookings). Caddy certificates in the `caddy_data` volume are re-issued automatically. `.env.production` and the age private key must be backed up by you separately (password manager). Losing `ENCRYPTION_KEY` makes stored OAuth tokens unreadable.

## Pipeline (`deploy/backup/backup.sh`, daily 03:17)

1. `pg_dump -Fc` streamed from the postgres container, piped into `age -r $BACKUP_AGE_RECIPIENT` (no plaintext ever hits disk).
2. Written to `$BACKUP_DIR/daily/meetflow-<UTC ts>.dump.age` plus a `.sha256`.
3. Sunday copy -> `weekly/`, 1st of month -> `monthly/`.
4. Retention (newest N kept): 7 daily, 4 weekly, 6 monthly (`BACKUP_RETENTION_*`).
5. `rclone copy` to `$RCLONE_REMOTE` (S3-compatible or Backblaze B2). Copy, not sync: local deletion never propagates. Objects older than 190 days are expired offsite.
6. Any failure calls the alert hook.

## One-time setup

```
age-keygen -o meetflow.key      # prints the public key (age1...) -> BACKUP_AGE_RECIPIENT
```

Store `meetflow.key` offline (password manager + second location); keep it OFF the VPS except while running a drill. `rclone config` creates the remote (use an application key restricted to one bucket, ideally with object lock / versioning).

## Verify (`deploy/backup/restore-verify.sh`, weekly)

Decrypts the newest backup, starts a throwaway `postgres:17-alpine` container with no network, `pg_restore --exit-on-error`, then checks: at least 20 tables, `booking_no_overlap` exclusion constraint and `btree_gist` present, no bookings with `ends_at <= starts_at`, counts users/bookings/orphan invitees. Alerts on failure; container and plaintext are always cleaned up.

## Disaster recovery (`deploy/restore.sh <file>`)

1. Provision a VPS with `vps-setup.sh`, restore code and `.env.production`, `rclone copy` the latest dump from offsite.
2. `BACKUP_AGE_IDENTITY=/path/meetflow.key deploy/restore.sh meetflow-....dump.age`: confirms by typing the DB name, takes a safety dump of the current DB, stops web/worker, restores with `--clean --if-exists --single-transaction`, re-runs migrations, restarts.
3. Check `/api/health?ready=1` and a test booking.

On a fresh host, bring up only `postgres` first (`docker compose ... up -d postgres`), then run restore.sh.

## Targets

RPO up to 24 h (daily dump). RTO: roughly 30-60 min including provisioning (unmeasured). For lower RPO add WAL archiving (pgBackRest/WAL-G) later.
