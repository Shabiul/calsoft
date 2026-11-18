#!/usr/bin/env bash
# Daily encrypted logical backup: pg_dump custom format -> age encryption -> local retention -> rclone offsite.
# Cron (root): 17 3 * * * /opt/meetflow/deploy/backup/backup.sh >> /var/log/meetflow-backup.log 2>&1
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$DIR/common.sh"

trap 'alert "backup FAILED (line $LINENO)"' ERR

command -v age >/dev/null || { alert "age is not installed"; exit 1; }
[ -n "${BACKUP_AGE_RECIPIENT:-}" ] || { alert "BACKUP_AGE_RECIPIENT not set"; exit 1; }

umask 077
mkdir -p "$BACKUP_DIR"/{daily,weekly,monthly}
ts="$(date -u +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/daily/meetflow-$ts.dump.age"
tmp="$out.partial"

log "dumping $POSTGRES_DB"
# Dump straight from the postgres container (direct connection, not pgbouncer). Never touches disk unencrypted.
"${COMPOSE[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --compress=6 \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$tmp"

# A truncated stream would still produce a file; sanity-check size.
size="$(stat -c %s "$tmp")"
[ "$size" -gt 1024 ] || { rm -f "$tmp"; alert "backup suspiciously small (${size}B)"; exit 1; }
mv "$tmp" "$out"
( cd "$BACKUP_DIR/daily" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )
log "wrote $out (${size} bytes)"

# Promote to weekly (Sunday) / monthly (1st) copies.
[ "$(date -u +%u)" = "7" ] && cp -p "$out" "$out.sha256" "$BACKUP_DIR/weekly/"
[ "$(date -u +%d)" = "01" ] && cp -p "$out" "$out.sha256" "$BACKUP_DIR/monthly/"

# Retention: keep the newest N dumps in each tier.
prune() { # dir keep
  # shellcheck disable=SC2012
  ls -1t "$1"/meetflow-*.dump.age 2>/dev/null | tail -n +"$(($2 + 1))" | while read -r f; do
    log "prune $f"; rm -f "$f" "$f.sha256"
  done
}
prune "$BACKUP_DIR/daily" "$BACKUP_RETENTION_DAILY"
prune "$BACKUP_DIR/weekly" "$BACKUP_RETENTION_WEEKLY"
prune "$BACKUP_DIR/monthly" "$BACKUP_RETENTION_MONTHLY"

# Offsite: copy (never sync, so a wiped local dir cannot delete offsite history); expire old objects separately.
if [ -n "${RCLONE_REMOTE:-}" ]; then
  command -v rclone >/dev/null || { alert "rclone not installed but RCLONE_REMOTE set"; exit 1; }
  log "uploading to $RCLONE_REMOTE"
  rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE" --include "meetflow-*.dump.age*" --transfers 2 --retries 3
  rclone delete "$RCLONE_REMOTE" --include "meetflow-*.dump.age*" --min-age 190d || true
else
  log "RCLONE_REMOTE not set; skipping offsite upload (LOCAL ONLY - not a real backup)"
fi
log "backup OK"
