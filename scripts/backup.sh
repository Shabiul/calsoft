#!/usr/bin/env bash
# MeetFlow database backup: a compressed pg_dump with rotation and a restore check.
#
#   DATABASE_URL_SESSION="postgres://...:5432/postgres" BACKUP_DIR=/opt/meetflow/backups ./scripts/backup.sh
#
# Use the Supabase SESSION pooler (port 5432) or the direct connection, never the transaction pooler (6543): pg_dump needs a
# real session. Without libpq extras in the URL (no "uselibpqcompat"), psql/pg_dump reject it.
# Schedule it daily, e.g. in crontab:   17 3 * * *  /opt/meetflow/scripts/backup.sh >> /var/log/meetflow-backup.log 2>&1
set -euo pipefail

: "${DATABASE_URL_SESSION:?set DATABASE_URL_SESSION to the session pooler or direct connection string}"
BACKUP_DIR="${BACKUP_DIR:-/opt/meetflow/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
MIN_BYTES="${MIN_BYTES:-10000}"

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/meetflow-$stamp.dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

# custom format: compressed, selective restore with pg_restore. Schemas Supabase manages itself are left out.
pg_dump --dbname="$DATABASE_URL_SESSION" --format=custom --compress=9 --no-owner --no-privileges \
  --exclude-schema=auth --exclude-schema=storage --exclude-schema=realtime --exclude-schema=vault --exclude-schema=extensions \
  --exclude-schema=graphql --exclude-schema=graphql_public --exclude-schema=pgsodium --exclude-schema=supabase_functions \
  --file="$tmp"

size="$(wc -c < "$tmp")"
if [ "$size" -lt "$MIN_BYTES" ]; then echo "backup suspiciously small ($size bytes), keeping nothing" >&2; exit 1; fi
# the archive must be readable and list its tables, otherwise it is not a backup
pg_restore --list "$tmp" | grep -q 'TABLE DATA public booking' || { echo "backup does not contain the booking table" >&2; exit 1; }

mv "$tmp" "$out"
trap - EXIT
find "$BACKUP_DIR" -name 'meetflow-*.dump' -type f -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $out ($size bytes), keeping $KEEP_DAYS days"

# Optional off-machine copy (set BACKUP_RCLONE_REMOTE, e.g. "s3:meetflow-backups"): a backup on the same server is not a safe backup.
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then rclone copy "$out" "$BACKUP_RCLONE_REMOTE" && echo "copied to $BACKUP_RCLONE_REMOTE"; fi
