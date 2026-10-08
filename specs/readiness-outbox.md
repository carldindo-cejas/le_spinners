# M06 outbox recovery implementation

Implemented locally October 7, 2026 by Codex; independent reviewer, historical-data operator and staging operator remain unassigned. M06 is In review after the local checks below. Production readiness remains NOT READY. This batch does not send real messages, change cloud secrets, apply remote migrations or deploy.

## Delivery contract

[Resend's idempotency contract](https://resend.com/docs/dashboard/emails/idempotency-keys) retains keys for 24 hours and returns the original response for a matching request. Each email intent receives one random, persisted provider key and a frozen JSON payload on its first atomic claim. Retries reuse both. Changing settings or sender configuration does not change an already attempted message. The API credential fingerprint also remains fixed; a credential change sends the intent to review before any further provider call, because the application cannot establish that the new credential belongs to the original account.

The application stops automatic replay after **23 hours**, with an additional minute of admission margin, or after **five claims**. This is deliberately shorter than the documented provider window. It does not promise permanent provider deduplication or inbox delivery. Provider acceptance requires a successful response containing a valid provider message ID. Malformed success, timeout, network loss, conflicting idempotency response and uncertain previous attempts never become a definitive failure or an unqualified sent record.

[Resend's error reference](https://resend.com/docs/api-reference/errors) distinguishes concurrent idempotent requests from mismatched payloads, and rate limits from quota exhaustion. The implementation retries concurrency conflicts, 408, 5xx and 429 with exponential backoff and jitter. It honors Retry-After, persists a shared cooldown for 429, and delays daily/monthly quota exhaustion until the next UTC boundary plus a minute. A first-attempt explicit permanent rejection becomes Send rejected; rejection after an uncertain earlier attempt requires review. Raw provider messages and bodies are never logged or stored as errors.

## Durable ownership and bounded work

Migration **0013_outbox_delivery.sql** follows 0012 and adds delivery state, claim identities, lease, retry schedule, frozen payload, provider identity and credential fingerprint. Existing legacy status values remain compatible. The singleton delivery control row holds a shared email pause.

The claim is one transactional UPDATE with a bounded subquery and RETURNING. It increments attempts and fixes all replay data before network I/O. Only one live lease can own a row. Completion requires the matching random claim ID and an unexpired lease; shared cooldown updates additionally require the settled claim ID in the same batch. A late worker cannot adopt the winner's checkpoint or pause other sends using its stale response.

An acknowledgement failure leaves the durable lease for recovery. After its **60-second** lease, another pass can call the provider with the identical key and payload. An acknowledgement that committed but lost its D1 response remains accepted and is not reopened. Exhausted or expired uncertain attempts enter needs_review; at most eight such checkpoints are reaped per pass, including while sending is disabled.

Each flush admits at most **two** provider calls, with an **eight-second** timeout covering fetch and response reading, an **8 KiB** response limit, and an **18-second** admission budget. Slow claim I/O prevents a late provider call and leaves its claim recoverable. D1 latency and the rest of maintenance do not have a hard wall-clock guarantee; CPU, quota and runtime contention evidence remain M08/G07 work. A once-per-minute trigger can admit at most 2,880 sends per day before retries, pauses and contention; this is a ceiling, not measured capacity or an accepted service target.

## Truthful operator visibility

Admin Settings → Message delivery shows queue totals and the most recent 50 items for a selected state. Needs review and Send rejected filters can reveal older problems outside the initial recent view. It shows attempt counts, retry times, safe error codes, missing email configuration and provider cooldown. Legacy sent rows without a provider ID are labeled Recorded as sent; new acknowledged rows are Accepted by email provider. Neither proves inbox arrival. An expired lease is Recovery pending. SMS is explicitly SMS not connected and remains unsent.

`GET /api/admin/outbox?state=...` remains admin-only, validates the filter, retains existing response fields, and omits body, frozen payload, fingerprint, provider key and claim identities. State summaries are counts over the current outbox and may grow with history; their actual query cost and retention/pagination remain L01/L02/M08 work. No automatic or UI resend action is added for uncertain deliveries.

## Upgrade, rollback and recovery

Before rollout, rehearse 0013 on an authorized isolated copy, then run [scripts/outbox-inventory.sql](../scripts/outbox-inventory.sql) read-only against that upgraded copy. The script requires the new columns. Review unknown legacy attempts, retained recipients and queue age with an assigned operator. Migration preserves row IDs, status, attempts, bodies and sent timestamps, and replaces old provider error strings with safe review codes. Unattempted queued email becomes ready; attempted unacknowledged email and old failed email become needs_review because the old sender had no provider keys. Existing sent history remains recorded; queued SMS becomes unsupported. No legacy delivery or financial history is invented.

**Pause email sending and drain old-sender invocations before applying 0013 and switching Workers.** The old sender ignores the new states and provider keys and could resend quarantined or retried messages during a mixed-version rollout. Keep sending paused until only the new sender is active, migration is confirmed, and configuration/queue review is complete. Retain additive columns on rollback. Before rolling back to the old sender, disable its sending configuration and drain active invocations; restoring the old unkeyed sending behavior is unsafe. Rehearse this with isolated resources and an approved backup/restore plan under G03/G06 before a live rollout. These instructions are a future release procedure; no cloud configuration was changed here.

Recovery ownership and audit procedure must be accepted under G11:

1. Review a needs_review item using its intent, frozen message, attempt times, safe error code and provider account evidence. Restrict access to recipients/content and credentials. Do not interpret a queued legacy status as permission to resend.
2. If provider acceptance is confirmed, record the provider message ID and supporting evidence, and apply a conditional, audited state repair on a copy first. Do not send another message or fabricate inbox-delivery evidence.
3. If acceptance is conclusively ruled out, review whether the message is still relevant, correct configuration, and approve a new delivery intent with a new identity through the operational change procedure. Absence of an inbox message alone is insufficient evidence. An unresolved case stays needs_review.
4. For credential rotation, first prove that the replacement credential is for the same provider account; any controlled fingerprint repair must preserve the original key, payload and replay deadline and have an audit record. Otherwise leave the item for review.

There is no general repair endpoint or automatic cross-account replay. Provider-window expiry cannot safely be fixed by extending the stored deadline. Delivery webhooks, bounce tracking and operational alerts are not implemented in this batch. Preserve active leases, payloads and keys through reconciliation; agree retention before pruning terminal history. Frozen payloads duplicate message content and must receive the same privacy/access protections as the original outbox body.

## Local evidence and remaining checks

The preserved pre-M06 working tree contains 146 files plus a SHA-256 manifest at `.wrangler/readiness-outbox-baseline-20261007`; credentials and runtime state are excluded. The first eight `M06 regression:` probes produced **seven failures and one pass** on that baseline. After implementation, all **27 outbox tests** and **87 integrated readiness tests** pass with Node 24.14.0 and the real application SQL/functions. Tests use SQLite transaction semantics and a synthetic idempotent provider; they do not prove the live provider contract or Cloudflare scheduling behavior.

Coverage includes overlapping senders, provider acceptance followed by D1 failure, lost responses, stable payload/key after configuration changes, lease recovery, acknowledgement response loss, stale owners, global rate-limit cooldown, quota delay, malformed and oversized responses, fetch/body-read timeout, invocation admission, replay expiry, five-attempt exhaustion, explicit rejection, credential changes, fresh/populated migration, filtered private read models and admin authorization. The initial route probe failed because its harness omitted the execution context used for denial auditing; supplying that context fixed the test without weakening authorization.

Additional local checks:

- Typecheck passes. All 50 frontend JavaScript modules and the service worker pass syntax checks. Dry-run Worker bundle: **534.01 KiB / gzip 123.42 KiB**, without deployment.
- Fresh 0001–0013 migration/demo setup passes in `.wrangler/readiness-outbox-runtime-20261007` with example-only configuration and sending disabled. The migration regression separately upgrades populated 0012 data with five representative legacy states, preserving history and checking foreign keys.
- `node tests/outbox-ui.mjs` (package alias `npm run test:outbox-ui`) passes on the actual admin Settings screen with synthetic API data: acceptance/retry/SMS labels, queue totals, disabled configuration, provider pause, an older review item, failed refresh and no page errors. The first browser probe needed case-insensitive status assertions because the existing pill CSS renders uppercase; no product change was needed.
- A separate local D1/workerd probe applies the real migrations and stubs all provider calls. Overlapping claims produce one call; acceptance followed by an injected acknowledgement failure recovers through the expired lease with the same key/body. Three calls for two distinct intents produce two logical acceptances. The throwaway probe is in the ignored runtime directory with its own local database; it cannot make external provider calls.
- Baseline reproduction is repeatable with `SYSTEM_TEST_ROOT` pointing to the preserved snapshot and `node --test --test-name-pattern="M06 regression:" tests/readiness-outbox.mjs`; its exit 1 is expected (seven failed / one passed). The unchanged first eight probes pass on the current implementation. The final full readiness command passes 87 / 87.

- Integrated API smoke: **494 passed / zero failed**, actual Node process exit 0 through a direct child-process runner. The existing DEP0190 shell invocation warning is retained in the log; general clean-checkout/CI tooling remains L03 work.
- Final read-only outbox inventory: all five candidate counts are zero, provider pause is zero, and foreign-key check returns no violations on the synthetic local database. This is not a historical production inventory.

Redacted logs, local D1 probe result and source manifests under `.wrangler/readiness-outbox-*` are ignored local artifacts; preserve a reviewed candidate patch/commit and durable redacted staging evidence for release. Browser tooling remains an external installation under L03, as in E01/E02.

Still required for closure: independent review; historical queue reconciliation with a named owner; controlled provider acceptance/replay and sender/account verification; overlapping cron/restart tests in staging; migration/rollback/restore rehearsal; actual CPU/D1/query/queue-delay measurements and alert/recovery ownership. G06 remains pending. No real email or SMS has been sent by these tests.
