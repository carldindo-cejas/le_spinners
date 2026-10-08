# Production deployment — 8 October 2026

Executed following the user's explicit instruction to apply migrations and deploy to production.

- Worker: `le-spinners`, configured default production environment.
- URL: https://le-spinners.cejascarldindo.workers.dev
- D1: `le-spinners`, `359085b7-5fbe-4d85-9db8-7ab2dc39ee57`.
- Private R2: `le-spinners-proofs`.
- Previous version: `387d8e75-9fe3-4940-8ec4-51e48857d1ee`.
- Deployed version: `da1a8466-b7bf-450a-bec8-7e1869d056ad`.
- Cron: every minute, `* * * * *`.

The authenticated account matched the established production target. Existing D1/R2/origin/timezone bindings and required secret names matched configuration. The resource-name preflight returned zero duplicate groups. A Time Travel recovery bookmark and previous-version metadata were recorded before mutation. Automatic approval review rejected a full SQL export because it would copy potentially sensitive production data to a local file without explicit authorization for that payload and destination; no SQL export was performed. Recovery evidence uses Time Travel and Wrangler's migration backup behavior instead.

The candidate dry run passed. Migrations **0017 booking configuration revision**, **0018 revenue export revision**, and **0019 resource name identity** all applied successfully. No earlier migration was rerun. The Worker and five changed static assets deployed together; `--keep-vars` preserved dashboard variables. No secret rotation, account reset, synthetic production booking, provider message, or financial test transaction was performed.

```sh
node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --remote
node node_modules/wrangler/bin/wrangler.js deploy --keep-vars --message "Concurrency audit fixes; migrations through 0019"
```

Fifteen live checks passed: player/staff/admin/revenue shells, health/facility/anonymous session, unauthenticated booking/admin/revenue rejection, security headers, and exact candidate hashes for all five changed assets. Remote migration listing reported no pending migrations. Read-only database checks confirmed three new migration records, zero duplicate resource groups, zero credit-ledger mismatches, zero duplicate submitted-proof groups, zero duplicate approval-event groups, `quick_check=ok`, and no foreign-key violations.

Local command logs, previous-version metadata, recovery bookmark, and live check results are stored under `.wrangler/releases/concurrency-2026-10-08T18-41-21/`, excluded from Git. The bookmark is a recovery reference, not a completed restore rehearsal; Worker rollback does not revert database state. These migrations are additive, but any recovery must preserve subsequent live writes and use a compatible Worker/database pair.

Staff should refresh cached consoles because approval/rejection now requires the reviewed `proofId`. The service-worker version and frontend changes are deployed. The [concurrency audit](concurrency-audit-2026-10-08.md) remains the evidence for local simultaneous-booking behavior; this deployment does not establish production load headroom or close its plan, staging, device, notification-delivery, and manual-payment-reconciliation conditions.
