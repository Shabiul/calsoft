# Deployment (single VPS, Docker Compose)

Target: Hostinger KVM-2 class (2 vCPU, 8 GB RAM, NVMe), Ubuntu 22.04/24.04 LTS. Status: scripts written, NOT yet exercised on a real VPS.

## Topology

```
Internet -> caddy (80/443, auto TLS) -> web:3000 --\
                                        worker -----+-> pgbouncer:5432 -> postgres:5432   (network `data`, internal)
                                        migrate ----+-> postgres (direct) ; web/worker -> redis (password)
```

- Only caddy publishes ports. `data` is a Docker `internal` network (no egress, no published ports). web/worker also join `app` for outbound calls (Stripe, Google, SMTP).
- pgbouncer runs in transaction pooling mode: server code must use transaction-scoped advisory locks (`pg_advisory_xact_lock`), no session state, no `LISTEN`.
- Redis: password, AOF, `maxmemory-policy noeviction` (required by BullMQ), 200 MB cap.
- Memory budget (limits): postgres 2 G, web 1.5 G, worker 768 M, redis 256 M, pgbouncer 64 M, caddy 128 M (~4.7 G of 8 G, headroom for page cache and builds).
- Logs: json-file, 10 MB x 5 per container.

## First-time setup

1. Point DNS (`A` for the domain and `www`) at the VPS.
2. As root: `ADMIN_USER=deploy ADMIN_SSH_PUBKEY="ssh-ed25519 ..." bash deploy/vps-setup.sh`. It installs ufw (22/80/443 only), key-only SSH, no root login, fail2ban, unattended-upgrades, 2 GB swap, Docker, age, rclone. It aborts before locking SSH if no key is installed. Verify a second SSH login before closing the first.
3. Copy the repo to `/opt/meetflow` (git clone or rsync), then `cp deploy/.env.production.example .env.production; chmod 600 .env.production` and fill every `REPLACE_` value (see ENVIRONMENT_VARIABLES.md).
4. `deploy/deploy.sh` builds images, runs migrations (one-shot `migrate` service, direct to Postgres), starts everything and waits for `/api/health?ready=1`.

Manual equivalent: `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build`.

## Upgrades and rollback

- Upgrade: update code, run `deploy/deploy.sh`. Migrations run before web/worker start (`service_completed_successfully`).
- Rollback code: check out the previous revision and re-run deploy. Migrations are forward-only; take a backup first (`deploy/backup/backup.sh`) and restore if a migration must be undone.

## Cron (root)

```
17 3 * * *  /opt/meetflow/deploy/backup/backup.sh >> /var/log/meetflow-backup.log 2>&1
30 4 * * 0  BACKUP_AGE_IDENTITY=/root/.age/meetflow.key /opt/meetflow/deploy/backup/restore-verify.sh >> /var/log/meetflow-verify.log 2>&1
*/5 * * * * /opt/meetflow/deploy/monitor/check-resources.sh
*/10 * * * * /opt/meetflow/deploy/monitor/check-auth-failures.sh
```

Alerts go to `ALERT_WEBHOOK_URL` (Slack/Discord-compatible `{"text": ...}`) and/or `ALERT_EMAIL` (needs `mail`).

## Health endpoints

- `GET /api/health` liveness (used by Docker and Caddy).
- `GET /api/health?ready=1` readiness: checks Postgres and Redis, 503 if either is down.

Add an external uptime monitor (UptimeRobot, Better Stack) on the readiness URL.

## Known limitations

- Single host: no HA. Recovery relies on tested backups (BACKUP_AND_RESTORE.md).
- Docker-published ports bypass ufw; that is why only caddy publishes any.
- `edoburu/pgbouncer:latest` and other images are not digest-pinned; pin digests before a serious launch.
- OAuth redirect URIs (Google/Microsoft/Zoom) and webhook endpoints (Stripe/Razorpay) must be configured with the production domain by hand.
