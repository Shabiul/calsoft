#!/usr/bin/env bash
# DISASTER RECOVERY: restore an encrypted backup into the LIVE production database.
# Usage: restore.sh /path/to/meetflow-YYYYmmdd-HHMMSS.dump.age
# Requires BACKUP_AGE_IDENTITY (age private key file). Takes a safety dump of the current DB first.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup/common.sh
source "$DIR/backup/common.sh"

file="${1:-}"
[ -n "$file" ] && [ -f "$file" ] || { echo "usage: $0 <backup.dump.age>" >&2; exit 2; }
[ -n "${BACKUP_AGE_IDENTITY:-}" ] && [ -f "$BACKUP_AGE_IDENTITY" ] || { echo "set BACKUP_AGE_IDENTITY to the age key file" >&2; exit 2; }

echo "This will REPLACE the contents of database '$POSTGRES_DB' with: $file"
read -r -p "Type the database name to confirm: " ans
[ "$ans" = "$POSTGRES_DB" ] || { echo "aborted"; exit 1; }

umask 077
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
if [ -f "$file.sha256" ]; then ( cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" ); fi
age -d -i "$BACKUP_AGE_IDENTITY" -o "$work/db.dump" "$file"
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$work/db.dump" >/dev/null   # fails early if the dump is corrupt

mkdir -p "$BACKUP_DIR/pre-restore"
safety="$BACKUP_DIR/pre-restore/pre-restore-$(date -u +%Y%m%d-%H%M%S).dump"
log "safety dump of current DB -> $safety"
"${COMPOSE[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$safety" || log "WARNING: safety dump failed"

log "stopping web and worker"
"${COMPOSE[@]}" stop web worker

log "restoring"
"${COMPOSE[@]}" exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner --single-transaction < "$work/db.dump"

log "re-running migrations (idempotent) and starting app"
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d web worker
log "restore complete; check: curl -fsS https://\$APP_DOMAIN/api/health?ready=1"
