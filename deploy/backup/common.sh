#!/usr/bin/env bash
# Shared helpers, sourced by the other scripts. Reads the production env file.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/meetflow}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$APP_DIR/docker-compose.prod.yml")

if [ -f "$ENV_FILE" ]; then
  # Only export the vars we need; avoids `source`-ing arbitrary values with spaces/brackets.
  for v in POSTGRES_USER POSTGRES_DB BACKUP_DIR BACKUP_AGE_RECIPIENT BACKUP_AGE_IDENTITY \
           BACKUP_RETENTION_DAILY BACKUP_RETENTION_WEEKLY BACKUP_RETENTION_MONTHLY RCLONE_REMOTE \
           ALERT_WEBHOOK_URL ALERT_EMAIL DISK_ALERT_PCT MEM_ALERT_PCT; do
    line="$(grep -E "^${v}=" "$ENV_FILE" | tail -n1 || true)"
    [ -n "$line" ] && export "${v}=${line#*=}"
  done
fi

POSTGRES_USER="${POSTGRES_USER:-meetflow}"
POSTGRES_DB="${POSTGRES_DB:-meetflow}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/meetflow}"
BACKUP_RETENTION_DAILY="${BACKUP_RETENTION_DAILY:-7}"
BACKUP_RETENTION_WEEKLY="${BACKUP_RETENTION_WEEKLY:-4}"
BACKUP_RETENTION_MONTHLY="${BACKUP_RETENTION_MONTHLY:-6}"

log() { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$(basename "$0")" "$*"; }

alert() {
  local msg="meetflow@$(hostname): $*"
  log "ALERT: $msg"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -fsS -m 10 -H 'Content-Type: application/json' \
      -d "{\"text\":\"${msg//\"/\\\"}\"}" "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  if [ -n "${ALERT_EMAIL:-}" ] && command -v mail >/dev/null 2>&1; then
    printf '%s\n' "$msg" | mail -s "MeetFlow alert" "$ALERT_EMAIL" || true
  fi
}
