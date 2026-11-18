#!/usr/bin/env bash
# Restore the newest (or given) backup into a THROWAWAY postgres container and run sanity queries.
# Needs the age private key: BACKUP_AGE_IDENTITY=/root/.age/meetflow.key  (keep it OFF the server in normal operation;
# copy it temporarily or run this on another machine with the dump downloaded via rclone).
# Usage: restore-verify.sh [/path/to/meetflow-*.dump.age]
# Cron (weekly): 30 4 * * 0 /opt/meetflow/deploy/backup/restore-verify.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$DIR/common.sh"

name="meetflow-restore-verify-$$"
work="$(mktemp -d)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
trap 'alert "restore-verify FAILED (line $LINENO)"' ERR

file="${1:-}"
if [ -z "$file" ]; then
  # shellcheck disable=SC2012
  file="$(ls -1t "$BACKUP_DIR"/daily/meetflow-*.dump.age 2>/dev/null | head -n1 || true)"
fi
[ -n "$file" ] && [ -f "$file" ] || { alert "no backup file found"; exit 1; }
[ -n "${BACKUP_AGE_IDENTITY:-}" ] && [ -f "$BACKUP_AGE_IDENTITY" ] || { alert "BACKUP_AGE_IDENTITY missing"; exit 1; }
log "verifying $file"

if [ -f "$file.sha256" ]; then
  ( cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" )
fi

umask 077
age -d -i "$BACKUP_AGE_IDENTITY" -o "$work/db.dump" "$file"

docker run -d --name "$name" --network none -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify \
  -v "$work:/restore:ro" postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U postgres -d verify >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$name" pg_isready -U postgres -d verify >/dev/null

# Extensions (btree_gist) are recreated by pg_restore; --no-owner because role names differ.
docker exec "$name" pg_restore -U postgres -d verify --no-owner --exit-on-error /restore/db.dump

q() { docker exec "$name" psql -U postgres -d verify -Atqc "$1"; }
fail() { alert "restore-verify sanity check failed: $1"; exit 1; }

tables="$(q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
[ "$tables" -ge 20 ] || fail "only $tables tables restored"
[ "$(q "select count(*) from pg_constraint where conname='booking_no_overlap'")" = "1" ] || fail "booking_no_overlap constraint missing"
[ "$(q "select count(*) from pg_extension where extname='btree_gist'")" = "1" ] || fail "btree_gist missing"
users="$(q 'select count(*) from "user"')"
bookings="$(q 'select count(*) from booking')"
bad="$(q "select count(*) from booking where ends_at <= starts_at")"
[ "$bad" = "0" ] || fail "$bad bookings with ends_at <= starts_at"
orphans="$(q 'select count(*) from invitee i left join booking b on b.id=i.booking_id where b.id is null')" || orphans="n/a"

log "tables=$tables users=$users bookings=$bookings orphan_invitees=$orphans"
log "restore-verify OK"
