# Security

## Infrastructure (implemented in deploy/, not yet verified on a live server)

- Host: key-only SSH, root login off, `AllowUsers`, ufw (22/80/443), fail2ban, unattended security upgrades.
- Network: Postgres, pgbouncer and Redis on an internal Docker network, no published ports; Redis requires a password; Postgres uses scram-sha-256.
- Containers: web runs non-root, read-only rootfs, all capabilities dropped, `no-new-privileges`; resource limits on all services.
- TLS: Caddy automatic HTTPS, HSTS (2 years, preload), HTTP/3.
- Request limits: 10 MB body cap at Caddy.
- Secrets: only in `.env.production` (600) on the host; images contain no secrets (build uses placeholders). `.env*` is git-ignored except templates.
- Backups encrypted with age before leaving the process; offsite via rclone.

## Application headers (`next.config.ts`)

CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: SAMEORIGIN` (HSTS in production). `/embed/*` allows framing by any origin (`frame-ancestors *`). Known weakness: `script-src` includes `'unsafe-inline'` (Next inline bootstrap scripts); move to nonce-based CSP via the proxy later. Stripe and Razorpay origins are allow-listed; add new third-party origins deliberately.

## Application controls (owned by feature code; verify in review)

Server-side authorization on every action (`requireUser`, `requireOrgRole`), Zod validation at the boundary, AES-256-GCM for stored tokens, webhook signature verification (Stripe/Razorpay), rate limiting on auth and public booking, booking-overlap exclusion constraint in Postgres, no PII in logs, Sentry default PII off.

## Checklist before launch

- [ ] Rotate all placeholder secrets; unique values per environment
- [ ] Restore drill passed; age key stored offline
- [ ] OAuth redirect URIs and webhook URLs set to the production domain
- [ ] Rate limits and CSRF/origin checks confirmed on auth and booking endpoints
- [ ] Dependency audit (`npm audit`) reviewed; images pinned by digest
- [ ] Security headers verified with a scanner against the live domain
- [ ] Alerting verified (trigger a test alert)

Report vulnerabilities privately to the maintainer.
