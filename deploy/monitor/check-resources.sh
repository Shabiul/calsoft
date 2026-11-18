#!/usr/bin/env bash
# Disk, memory and container health alerts. Cron: */5 * * * * /opt/meetflow/deploy/monitor/check-resources.sh
# Alerts are de-duplicated for 1 hour via a state file so a full disk does not spam you.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../backup/common.sh
source "$DIR/../backup/common.sh"

DISK_ALERT_PCT="${DISK_ALERT_PCT:-85}"
MEM_ALERT_PCT="${MEM_ALERT_PCT:-90}"
STATE_DIR="${STATE_DIR:-/var/tmp/meetflow-monitor}"
mkdir -p "$STATE_DIR"

notify() { # key message
  local f="$STATE_DIR/$1"
  if [ ! -f "$f" ] || [ -n "$(find "$f" -mmin +60 2>/dev/null)" ]; then
    alert "$2"; touch "$f"
  fi
}

for mount in / /var/lib/docker; do
  mountpoint -q "$mount" 2>/dev/null || [ "$mount" = "/" ] || continue
  pct="$(df --output=pcent "$mount" | tail -n1 | tr -dc '0-9')"
  [ "$pct" -ge "$DISK_ALERT_PCT" ] && notify "disk$(echo "$mount" | tr / _)" "disk $mount at ${pct}% (threshold ${DISK_ALERT_PCT}%)"
done

mem_pct="$(free | awk '/^Mem:/ {printf "%d", ($2-$7)/$2*100}')"
[ "$mem_pct" -ge "$MEM_ALERT_PCT" ] && notify mem "memory used ${mem_pct}% (threshold ${MEM_ALERT_PCT}%)"

# Containers that are unhealthy, exited, or restarting (migrate is one-shot and excluded).
bad="$(docker ps -a --filter "label=com.docker.compose.project" --format '{{.Names}} {{.Status}}' \
  | grep -Ev 'migrate' | grep -E 'unhealthy|Exited|Restarting' || true)"
[ -n "$bad" ] && notify containers "unhealthy containers: $(echo "$bad" | tr '\n' ';')"

# Last backup freshness (> 26h old means the daily job is broken).
latest="$(find "$BACKUP_DIR/daily" -name 'meetflow-*.dump.age' -mmin -1560 2>/dev/null | head -n1 || true)"
[ -d "$BACKUP_DIR/daily" ] && [ -z "$latest" ] && notify backup "no backup newer than 26h in $BACKUP_DIR/daily"
exit 0
