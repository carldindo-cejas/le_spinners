# Growth, migration recovery and operational readiness

October 7, 2026. Implementer: Codex. Operations, retention, incident, release and business approval owners are **unassigned**. The initial evidence below precedes deployment. Later that day, the user explicitly authorized remote migration and deployment: 0009–0016 and Worker version `fd7a20f6-0819-4cf6-8c66-22fb4434d675` were deployed with backup/populated rehearsal and live checks. See [deployment record](deployment-2026-10-07.md). No historical data repair or account reset was performed; staging and acceptance gates remain open.

## I01: deployed applicability and safe account recovery

Configured Worker: `le-spinners`; D1 `le-spinners`, ID `359085b7-5fbe-4d85-9db8-7ab2dc39ee57`; R2 `le-spinners-proofs`. Wrangler's authenticated account matched the configured production account. Separate staging resource mapping has not been supplied.

Before the authorized deployment, read-only D1 commands recorded migrations 0001–0008. `0002_client_password_hmac.sql` was applied September 30, 2026 at 05:00:06 (D1 recorded timestamp). Three active accounts exist: one admin, two players. All three use `client_pbkdf2_hmac_v1`; none currently needs the pre-0002 reset. Current account counts cannot reconstruct how many users existed when 0002 ran. Its destructive legacy credential/session reset is historical on this target and must **not** be rerun or edited. The later authorized deployment applied additive migrations 0009–0016; remote migration listing now reports none pending.

Evidence: `.wrangler/readiness-remote-migrations.json`, `readiness-remote-accounts.json`, `readiness-remote-credential-schemes.json`. Each individual SELECT reports zero changes/rows written. `scripts/deployment-inventory.sql` contains only SELECT/PRAGMA operations; Wrangler's remote `--file` path returned an aggregate summary rather than individual query results, so individual `--command` queries were used for the conclusions above. No credential hashes, salts, tokens or secret values were retrieved.

The schema-0008-compatible `scripts/readiness-inventory.sql` also ran remotely as read-only commands: all 13 invalid-date, ledger, repeated-effect/refund, disruption and missing-effect candidate counts were zero, and foreign-key output was empty. Results are in `.wrangler/readiness-remote-integrity.json`. These counts flag specific anomalies; they do not establish every slot/object/provider invariant or replace independent historical reconciliation.

`tests/readiness-growth.mjs` creates an isolated populated pre-0002 SQLite database, backs it up, applies 0002–0016, verifies required reset/session revocation, recovers an existing player without changing role/membership/ownership, rejects stale recovery, restores the backup and checks integrity/foreign keys. The generated `.wrangler/migration-rehearsal-*/evidence.json` records elapsed time. This is a local synthetic rehearsal, not D1 Time Travel or a production restore.

`npm run recover-account` is a local-default operator CLI. It prompts for existing email, named operator/ticket, hidden temporary password and (remote only) hidden target pepper. It preserves role/status/membership/owned history, compares auth version, changes credentials, revokes sessions and records an audit entry. SQL files are temporary and removed in `finally`; credential SQL is never printed on failure. Remote execution requires explicit `--remote --env NAME` and an explicit DB mapping in that named environment. Never include passwords/pepper on the command line or in a ticket. The identity-verification/private-delivery process must be approved and performed by the operator. There is no forced-password-change flag; the user must change the temporary password through the existing profile flow.

Before a real upgrade, the named operator must inventory existing dates, effects, ledgers, slots, proof references and auth state using the previous finding inventories; reconcile anomalies with source evidence; record a verified backup/Time Travel bookmark and retention window; rehearse current 0009–0016 on an isolated representative copy; verify old/new Worker compatibility; record duration, invariants and recovery access. Additive indexes can be removed by a reviewed forward migration; schema/auth/financial changes require reviewed forward repair or a complete database/Worker recovery pair, rather than blindly rolling back only code. D1's [Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) defines platform restore behavior; verify current account support/window before execution.

## L01: measured indexes and conservative retention proposal

`tests/readiness-growth.mjs` benchmarks six/twelve-month synthetic histories of 18,000/36,000 messages, 90% system and 10% text, with fixed query semantics. It compares the original message scan against the partial covering `idx_message_unread` index, verifies exact unread counts and the existing rate-limit cleanup index, and records EXPLAIN plans/timing at `.wrangler/readiness-growth-measurements.json`. These are Node SQLite measurements; D1 billed reads/writes, runtime CPU, storage growth and index write cost remain staging measurements. The model intentionally isolates message-kind growth; it does not claim to model the production distribution of bookings/read markers.

Proposed retention, pending named owner acceptance:

| Data | Current safe behavior / proposed rule |
| --- | --- |
| Credit/refund ledger, booking/disruption events, audit and durable replay operations | Preserve. No automatic expiry/deletion; financial retention and maximum client-retry/reconciliation horizon must be accepted before archiving. |
| Proofs and historical QR/object references | Preserve referenced objects; reconcile new abandoned uploads using existing fenced bounded cleanup. Historical scan remains off until inventory/retention approval. |
| Messages and notifications | Preserve authorized older-history access via pagination. Archive only through a reviewed export/checksum/restore procedure, never by deleting unresolved financial or support context. |
| Outbox sent/error/manual-review and unconfigured SMS | Preserve diagnostic/replay evidence. Unconfigured SMS is unsupported delivery, remains visible and is not falsely acknowledged. Review growth weekly and before a plan threshold; do not silently purge or retry manual-review messages. |
| Expired sessions/rate limits | Existing bounded maintenance removes expired operational rows, at most 250 per pass. No new destructive financial/history cleanup. |

Proposed review triggers: unread/list p95 exceeds the agreed budget, any backlog grows over three successive cron windows, or projected usage/storage reaches 70% of the selected plan allowance. Alert recipients, legal/business retention periods, archive destination and restore RTO/RPO remain unassigned/unaccepted. L01 stays In progress until measured intended-runtime cost and accepted retention are recorded.

## I02: configuration evidence, staging and incident procedures

Read-only deployed checks found the two required secret **names**, FILE_SIGNING_SECRET and PASSWORD_PEPPER, present; no RESEND_API_KEY was listed. This does not verify secret contents, rotation custody or provider configuration. Proof bucket: r2.dev public access disabled, no custom domains; eight objects / approximately 11.2 MB. Evidence: `.wrangler/readiness-remote-secret-names.json`, `readiness-remote-r2-public.log`, `readiness-remote-r2-domains.log`, `readiness-remote-r2-info.log`. Current `APP_ORIGIN` is the exact configured HTTPS Worker origin. Live cookie/CSP/signed-link/expiry behavior remains G04 work.

Configuration enables Worker logs and traces; generated bindings require the signing secret and pepper. Enablement is not proof of retained/redacted logs or working alerts. Follow Cloudflare's [observability documentation](https://developers.cloudflare.com/workers/observability/) for actual dashboards and request correlation. Do not record passwords, client hashes, session tokens, signed URLs, screenshot bytes or unnecessary customer data. Assign restricted log access and an accepted retention period.

G01 must identify a separate named staging Worker, D1, private R2, exact HTTPS APP_ORIGIN, account/plan and controlled email sender/recipient. Review every environment binding; D1/R2/secrets are explicitly mapped per environment. Test secrets are distinct from production. Synthetic fixtures do not authorize use of existing production resources. Provision/deploy commands remain pending that mapping and operator approval; there is deliberately no guessed live staging ID in configuration.

Proposed dashboards/alerts to configure and test under G11: request errors/latency by endpoint, unexpected login 429s, failed cron/checkpoint age, maintenance/outbox/storage backlog and oldest age, manual-review counts, provider cooldown/errors, DB row reads/writes and storage/CPU/quota headroom. Use platform request IDs/traces to correlate incidents without adding personal data to logs. Candidate thresholds must be accepted and alert delivery demonstrated, with named incident/release owners.

Incident procedures:

1. **Booking/credit anomaly:** stop rollout; preserve request/operation IDs and redacted inventories; compare durable operations, ledger and external payment evidence. Do not delete a suspected duplicate or manually edit a balance. Reviewed repair records must preserve the audit trail.
2. **Outbox/provider ambiguity:** inspect claims/lease/cooldown/manual-review status and provider acceptance under the original idempotency key. Keep frozen request identity; never assign a new key merely to make an ambiguous send retry. Controlled provider recovery remains G06.
3. **Storage deletion or attachment incident:** pause cleanup through its existing flag, preserve proof/QR references and tombstones, compare DB references with read-only object HEADs, then review reconciliation before resuming. Never enable legacy scanning during an unreviewed retention incident.
4. **Credential compromise:** verify account/operator identity, recover the existing account with version fencing, confirm prior sessions reject, and separately review pepper rotation (which requires credential migration/recovery planning). Retain a restricted recovery ticket; never put the pepper in logs.
5. **Cron/quota incident:** inspect bounded checkpoints and queue age; reduce/stop synthetic load, verify the selected plan's actual metrics and catch-up behavior, and resume bounded processing only after reconciliation. A local zero-error test does not demonstrate plan headroom.
6. **Release recovery:** preserve the exact candidate/config/migration list and backup/bookmark. Select the reviewed forward repair or restore, pair database state with compatible Worker code, run restricted smoke/invariants, record downtime/data loss and obtain the release owner's decision.

## M08/G07: executable local capacity measurement

`tests/capacity.mjs` permits localhost only, performs 20/35/50 concurrent read ramps using a synthetic seeded account, then a configurable soak (standalone default 1,800 seconds; CI 15). It records endpoint p50/p95/p99 and HTTP errors. Fifty distinct shared-IP sign-ins are covered separately by M13 regressions. The initial local read ramp had no HTTP errors but facility p95 exceeded the previously proposed one-second target; shared-host measurements are diagnostic, not accepted service performance.

G07 still requires the full mixed-write/upload/refund/disruption/cron workload for 30 minutes on the intended isolated staging plan, actual CPU/memory-limit and billed D1/R2/queue metrics, invariants, usage projections and agreed headroom. The local read harness does not pass that gate. G08 real Android/iOS/PWA and G09 assistive-technology review remain pending.

## I03: decisions still required

Current member pricing follows `membership`, without automatic `member_until` expiry. Desk bookings belong to their staff account even when `booker_name` differs, so owner-overlap restrictions apply to that account. These were identified as business decisions in the audit. No answer/accepted replacement policy or named approver has been supplied; these behaviors are preserved.

The report now separates verified cash including later cancellations, recorded external credit refunds, active and unexpired credit balances, and credit-funded confirmed/completed value through admin-only `/api/admin/revenue/accounting`. The existing period report remains status-based collected payments and excludes later-cancelled bookings; its explanatory text no longer claims there are no refund records. The accounting summary is lifetime recorded data, separate from the selected period. Tests cover cancelled verified cash retained as credit, a credit-funded replacement, refunds, expiration visibility and admin-only access. Neither report proves external settlement or an accepted accounting liability policy.

Required acceptance record: named decision owner/date; whether membership automatically expires and how renewal works; how different simultaneous desk customers acquire ownership/overlap restrictions; cash/credit/refund recognition and retention; launch-critical scope; corresponding acceptance tests or explicitly approved deferral. I03 and G10 remain open until that record exists.
