#!/usr/bin/env bash
# Alert on bursts of failed SSH logins and on fail2ban bans. Cron: */10 * * * *
# Also flags app-level auth abuse by counting 401/429 responses in the last Caddy log window.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../backup/common.sh
source "$DIR/../backup/common.sh"

SSH_FAIL_THRESHOLD="${SSH_FAIL_THRESHOLD:-30}"
HTTP_AUTH_FAIL_THRESHOLD="${HTTP_AUTH_FAIL_THRESHOLD:-100}"

ssh_fails="$(journalctl -u ssh -u sshd --since '10 min ago' --no-pager 2>/dev/null \
  | grep -cE 'Failed password|Invalid user|authentication failure' || true)"
[ "${ssh_fails:-0}" -ge "$SSH_FAIL_THRESHOLD" ] && alert "$ssh_fails failed SSH auth events in 10 min"

if command -v fail2ban-client >/dev/null 2>&1; then
  banned="$(fail2ban-client status sshd 2>/dev/null | awk -F: '/Currently banned/ {gsub(/ /,"",$2); print $2}')"
  [ "${banned:-0}" -ge 5 ] && alert "fail2ban currently banning $banned IPs on sshd"
fi

http_fails="$("${COMPOSE[@]}" logs --since 10m caddy 2>/dev/null \
  | grep -E '"status": ?(401|429)' | grep -cE '/api/auth|/login' || true)"
[ "${http_fails:-0}" -ge "$HTTP_AUTH_FAIL_THRESHOLD" ] && alert "$http_fails 401/429 auth responses in 10 min"
exit 0
