# Cloudflare deployment — October 7, 2026

Executed by Codex following the user's explicit instruction to run database migration and Cloudflare deployment. The earlier staging/review gates were not treated as a completed release review. This record proves the deployment actions and checks below; it does not mark all readiness gates passed.

## Target and deployed candidate

- Worker: `le-spinners`, default configured production environment.
- URL: <https://le-spinners.cejascarldindo.workers.dev>
- D1: `le-spinners`, ID `359085b7-5fbe-4d85-9db8-7ab2dc39ee57`.
- Private R2: `le-spinners-proofs`.
- New Worker version: `fd7a20f6-0819-4cf6-8c66-22fb4434d675`.
- Previous Worker version: `810f0f2e-bd42-41eb-9fed-809a5dd5a497`.
- Cron schedule deployed: `* * * * *`.

183 candidate source hashes matched the earlier clean-install verification. Required secret names were present, and remote D1/R2/origin/timezone bindings matched local configuration. The dry-run build passed. No secret rotation, recipient configuration, synthetic account creation or live refund/booking test was performed. Existing dashboard variables were preserved with `--keep-vars`.

Commands executed through the project's pinned Wrangler 4.143.1:

```sh
npm run db:migrate:remote
npm run deploy -- --keep-vars --message "Readiness implementation; migrations through 0016"
```

All eight pending migrations applied successfully: 0009 canonical dates, 0010 transition/refund identity, 0011 schedule revision, 0012 booking operations, 0013 outbox delivery, 0014 storage uploads, 0015 auth versions, and 0016 history indexes. Migration history confirms 0001–0016 applied; 0002 was already applied and was not rerun. Worker upload and trigger deployment succeeded, with 53 changed/new static assets uploaded.

## Backup and populated rehearsal

Before mutation, captured a full remote SQL export and D1 Time Travel bookmark. The release directory has restricted Windows access for the current user, SYSTEM and Administrators, and is ignored by Git:

`.wrangler/releases/2026-10-07T14-04-34-785Z/`

It contains the SQL backup, bookmark, prior deployment metadata, candidate manifest, command logs and redacted count/check evidence. Do not publish the SQL backup or rehearsal database: they contain production account/history data. The backup file is 95,442 bytes; its SHA-256 is `96fbd2f89ab0d6a5c4ca3f38046df942c3f5ed14ec40419f1fb2324d2b47629e`.

The exported production database was imported into an isolated local SQLite copy and upgraded through all eight pending migrations in approximately 1.85 seconds. Counts were preserved: three users, zero sessions, eight bookings, seven payment proofs, zero credits and zero credit transactions. Credential fields were unchanged, sessions were correctly versioned, proof references were adopted, and integrity/foreign-key checks passed. Import required foreign-key enforcement off during table creation, then back on for upgrade/checks; the original export and production database were unchanged by this rehearsal. This is an actual populated-export rehearsal, not a remote Time Travel restore exercise.

Recovery must pair a compatible Worker with the selected database state. The old Worker cannot safely create unversioned sessions after 0015, so restoring only the old code is not a complete rollback plan. Preserve post-release data and select a reviewed forward repair or coordinated database/Worker restore if recovery is needed. No restore was executed.

## Post-deployment checks

Thirteen live checks passed:

- `/`, `/staff/`, `/admin/`, `/revenue/`: HTTP 200 with CSP and `nosniff`.
- `/api/facility`, `/api/auth/session`: HTTP 200, API `no-store`, request IDs; anonymous session returned no user.
- Unauthenticated bookings, staff summary and admin accounting requests: HTTP 401 with security headers.
- Deployed `sw.js`, booking-time/history helpers and landing module exactly matched candidate contents.

Read-only remote inventories found zero candidates across 13 historical integrity checks, three credential-version checks, seven storage checks and five outbox checks. Foreign-key outputs were empty. Storage backfill tracks seven attached proofs and one attached QR. Seven email messages remain ready/queued; RESEND_API_KEY was absent during preflight, so provider delivery remains unconfigured. These checks do not prove authenticated user journeys, object decoding or provider acceptance.

The account, session, booking, proof and credit row counts remained unchanged after migration/deployment. The source application's normal cron/maintenance behavior is now active on the migrated database. No manual historical repair or account reset was performed.

## Readiness work still open

M08 intended-plan mixed capacity, L01 cost/retention acceptance, I02 separate staging/full operational/device checks and I03 business decisions remain open. Independent finding review, real authenticated portal checks, controlled email delivery, actual restore rehearsal, devices/PWA, accessibility and named operational acceptance remain required. Deployment success does not close these findings or pass G01–G12 automatically.

CLI behavior was checked against installed help and the official [D1 command reference](https://developers.cloudflare.com/d1/wrangler-commands/) and [Wrangler command index](https://developers.cloudflare.com/workers/wrangler/commands/).
