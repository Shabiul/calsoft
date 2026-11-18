# MeetFlow

Calendly-style scheduling SaaS. Next.js 16 (App Router), TypeScript, Tailwind v4, Drizzle + Postgres 17, BullMQ + Redis, Better Auth.

Status: under active development. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for what is and is not verified.

## Quick start (development)

```bash
cp .env.example .env.local
docker compose -f docker-compose.dev.yml up -d   # Postgres :54329, Redis :63799
npm install --legacy-peer-deps
npm run db:migrate                               # drizzle migrations + drizzle/constraints.sql
npm run dev                                      # http://localhost:3000
npm run worker                                   # BullMQ worker (separate terminal)
```

Scripts: `npm run typecheck`, `npm run lint`, `npm test` (vitest, needs Postgres + Redis), `npx playwright test` (e2e).

## Documentation

| Doc | Purpose |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering and shared contracts |
| [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) | Scope and phases |
| [docs/DATABASE_DESIGN.md](docs/DATABASE_DESIGN.md) | Schema and integrity rules |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model and checklist |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | VPS deployment (Docker Compose + Caddy) |
| [docs/BACKUP_AND_RESTORE.md](docs/BACKUP_AND_RESTORE.md) | Backups, offsite, restore drills |
| [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md) | Every env var |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy and commands |
| [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) | Public API (skeleton) |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | Honest status checklist |

## Production in one paragraph

`docker-compose.prod.yml` runs caddy (TLS), web (Next standalone), worker, one-shot migrate, pgbouncer, postgres 17 and redis on a single VPS. Only caddy publishes ports (80/443). See DEPLOYMENT.md.
