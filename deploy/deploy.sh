#!/usr/bin/env bash
# Deploy/upgrade on the VPS: build images, run migrations, restart, wait for readiness.
# Usage (from /opt/meetflow after updating the code):  deploy/deploy.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE="${ENV_FILE:-.env.production}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
C=(docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml)

"${C[@]}" config -q
"${C[@]}" build
"${C[@]}" up -d --remove-orphans
"${C[@]}" ps

domain="$(grep -E '^APP_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
for i in $(seq 1 30); do
  if curl -fsS -m 5 "https://$domain/api/health?ready=1" >/dev/null 2>&1; then echo "ready"; exit 0; fi
  sleep 5
done
echo "readiness check failed; inspect: ${C[*]} logs --tail=100" >&2
exit 1
