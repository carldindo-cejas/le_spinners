# Booking recovery and bounded maintenance — M07 / M08

Implemented locally October 7, 2026. M07 is awaiting review and historical-data/staging verification. M08 remains in progress pending runtime measurements and plan acceptance. This change does not establish production readiness.

## Creation and replay contract

Migration `0012_booking_operations.sql` follows 0011. `POST /api/bookings`, `POST /api/admin/bookings`, and `POST /api/staff/bookings` require `Idempotency-Key`: 8–100 letters, digits, underscores or hyphens. Missing/invalid headers return 422. Integrations must update before rollout.

`booking_operations` scopes a key to the authenticated actor and player/console operation kind. Its SHA-256 request hash covers resource/date, sorted unique starts and player credit intent, or console rate/payment/booker. IP and current prices are excluded: IP may change during retry, and current prices/credit balances must not prevent recovering a committed booking. Different payloads under the same key return 409 `IDEMPOTENCY_KEY_REUSED`.

The operation, booking, slots, credit redemptions, events, system messages, notices, email outbox intent and console audit commit in one D1 batch. Every creation effect requires the newly generated booking ID to exist. A refused booking creates no effects or operation. Only the active-slot unique constraint is translated to a slot race; unrelated unique failures propagate and roll back.

Replay looks up the durable operation before availability, date/window, quote or balance validation, and again after failures, including a competing commit during validation. It returns the original booking ID with its **current** authorized detail/status. It never extends an expired hold or books a replacement automatically. Concurrent matching requests converge; changed-payload reuse cannot create another booking. If D1 is unavailable during recovery, the caller must retry the same key once it is available.

Both browser creation screens use `core/booking-request.js`. A pending payload/key survives network/server errors, malformed success responses and reloads in the same tab through sessionStorage, with an in-memory fallback if storage is unavailable. For players, the court/date/starts identify a pending intent: a changed credit quote after an ambiguous commit must first recover the original stored payload. Console intent includes all submitted fields. A successful response clears the pending identity; a definitively rejected 4xx clears it except timeout/throttle responses. Different selections are distinct intents. A new tab or unavailable storage cannot recover an old pending key; check booking history before initiating another intent.

Server keys are retained for the lifetime of their bookings. No pruning job was added. Future L02 deletion/retention work must handle operation references together with booking history. Trusted one-off library calls may omit a key and receive a generated identity; retry-capable callers must supply one. Deploy migration first, then coordinated Worker/client updates. An old cached client will receive 422 until it fetches the new code. Test the service-worker upgrade under G08. Rolling back the Worker leaves the additive table/indexes intact but restores the old recovery defects.

[Cloudflare's D1 batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) provides sequential transactional execution and rollback of a failed sequence. The local SQLite harness tests that contract with injected failures; it does not emulate Cloudflare resource accounting or replica/isolate behavior. Provider delivery is covered separately by [M06 outbox recovery](readiness-outbox.md); a durable queued email alone does not establish provider acceptance.

## Maintenance checkpoints and polling

Expiry, warnings and completion select at most **8 bookings per pass**, ordered by expiry or end time. Conditional updates recheck eligibility and persist a fresh random transition ID. All dependent events/messages/notices and expiry credit returns use that identity in the same transaction. A loser writes no effects; a rollback leaves the booking eligible next pass; a lost committed response leaves a complete checkpoint so the next pass skips it. No separate lease is needed for these entirely transactional database effects.

Creation limits synchronous expiry to the requested resource/day. Larger delayed backlogs can require additional maintenance passes before every stale active-slot index entry is released; this may temporarily return a slot conflict. Catch-up is bounded and does not loop through an entire backlog inside a customer request. Cron and lazy reads resume the remaining eligible rows. Fifty due bookings take seven successful passes; cron alone can take roughly seven ticks, and lazy reads can accelerate this. Warning windows can be missed under a large backlog; monitor queue age and tune only after G07. Per-isolate lazy throttling is an optimization, not a fleet-wide lock or quota guarantee.

Credit reconciliation selects at most 8 ended booking IDs, with at most 10 credit redemptions per booking. Deferred disruption cleanup selects at most 8 item pairs and resolves staff notices in the same batch. Hourly housekeeping removes at most 250 expired sessions and 250 old throttle counters per pass. Partial indexes support candidate discovery across closed history. LIMIT bounds changes; actual scanned rows, index maintenance and trigger work still require measurement. Applying a large disruption is still a separate unbounded affected-scope operation requiring the 1/10/12/50 G07 measurements; this change bounds deferred cleanup, not disruption application.

The shared poll utility allows one in-flight call per poll, pauses hidden/offline tabs and tabs idle for five minutes, and resumes on visibility, reconnect or pointer/key/scroll activity. Thrown failures double the next interval up to five minutes; success resets it. Disposal removes its timers/listeners, including when a request is still running. This does not cancel in-flight screen work or fix stale route rendering (M03/M04). Existing screen loaders that swallow errors do not signal backoff; badge polls propagate errors for backoff, while manual badge refreshes stay best effort.

Player and console badge polling changes from 15 seconds to 60 seconds. Simultaneous timer/manual badge refreshes share one promise. Screen-specific intervals remain 10–60 seconds; public calendar refresh remains 30 seconds. Every individual poll is coalesced, but different endpoints still need distinct requests. An open console mini-chat can add another poll.

## Workload budget and intended platform plan

Checked official limits October 7, 2026: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and [D1 billing](https://developers.cloudflare.com/d1/platform/pricing/). Free has 100,000 Worker requests/day and 10 ms CPU per HTTP/cron invocation; D1 lists 50 queries/invocation, 5 million rows read/day and 100,000 rows written/day. Paid D1 lists 1,000 queries/invocation. Billing includes scanned rows and index writes. These published limits are not verified account configuration.

Conservative request projection for **50 continuously active users over 8 hours**, one authenticated screen plus badges, excludes initial loads, mutations, uploads, retries, mini-chat and cron. Hidden/idle pauses reduce demand; do not assume those savings for launch capacity.

| Screen interval | Screen requests/user/min | Badge requests/user/min | Projected total/day |
| --- | --- | --- | --- |
| 30 seconds | 2 | 1 | 72,000 |
| 20 seconds | 3 | 1 | 96,000 |
| 15 seconds | 4 | 1 | 120,000 |
| 10 seconds (live chat/detail) | 6 | 1 | 168,000 |

The previous 15-second badge timer alone added 96,000 requests to this workload; the new timer adds 24,000. Mixed-screen demand must be measured, not inferred from the lowest row. Full maintenance can include an expiry batch of 37 statements, warning batch of 17 and completion batch of 9, plus candidate/settings/reconciliation/delivery work; eight rows is not a claim that the whole invocation fits Free limits. SQL statement counts are an engineering bound, not measured D1/Worker metering.

**Proposed intended staging/launch plan: Workers Paid with D1 Paid.** Account selection, cost acceptance and actual plan verification remain open under I02/G07; no account or billing change was made. If Free is required, first redesign invocation scheduling and polling volume, then demonstrate CPU/query/row/request headroom on that plan. The audit's artificial SQL-statement cap is not a platform measurement.

G07 must run the 20/35/50-user ramp and 30-minute soak; 1/10/12/50 expiry/disruption bursts around cron; realistic accumulated history; booking/credit invariants; delayed catch-up and overlapping lazy/cron workers; and capture actual CPU, queries, rows read/written, request totals, p95/p99, throttle failures and queue age. Set alerts and accepted queue-delay/headroom targets under G11. M06 now limits sends to two per flush with eight-second fetch/read timeouts and an 18-second admission budget. D1 I/O and overall cron runtime still require staging measurements; see the outbox spec.

M10/M11 add image-container CPU work, two upload checkpoint round trips and atomic attachment, plus bounded cron storage reconciliation. Managed cleanup claims at most eight objects per pass; optional legacy discovery adds one eight-object list page and conditional adoption statements. Retained daily tombstones, QR operations and aggregate health counts need realistic-history D1/R2 measurements. The near-limit Node image benchmark is not Workers CPU evidence; include these costs in the complete invocation budget and G07. See [image/upload contract and evidence](readiness-storage.md); no account/plan or CPU-limit change was made.

## Historical effects and migration review

Run `scripts/readiness-inventory.sql` read-only on an isolated authorized snapshot. Four new counts identify bookings without creation/expiry/completion events and warned holds without warning notices. Legacy imports/demo rows can legitimately match these counts. The migration deliberately does not invent old events, notifications, timestamps, financial transactions or email deliveries.

Review each candidate against its original booking state, timeline, messages, ledger and external evidence. Record a reviewed per-booking repair manifest with expected state and uniquely identified repair, then perform conditional missing-effect inserts in one transaction and verify counts/credit sums/FKs. Do not resend historical email, infer cash movement or change balances from an absent timeline event. Test that repair on a copy before applying to a live system. Approved historical reconciliation and independent review are still needed to close M07; no live repair was performed here.

Upgrade 0011 → 0012 is additive and requires no operation backfill. Preserve old booking history. The deterministic suite also exercises fresh migration application; the isolated local calendar store exercises a populated migration upgrade. Backup/restore rehearsal and production inventory remain G03 work.

## Local evidence

Node 24.14.0, Wrangler 4.143.1, TypeScript 5.9.3; synthetic users and local D1/R2 only. The P0-fixed pre-change source was preserved at `.wrangler/readiness-m07-baseline-20261007` with a source hash manifest, excluding credentials.

- `npm run test:readiness`: 60 passes: 24 existing integrity tests, 32 recovery/maintenance regressions, 3 polling behavior tests and 1 browser-client replay test. The 32 recovery regressions fail 24 / pass 8 on the preserved baseline. Polling tests use observable scheduling behavior; client tests verify identical keys and payloads through a changed quote, reload and malformed response.
- Local Worker/D1/R2 smoke: 494 assertions passed, zero failed; public calendar: 157 checks passed; public pages: all six widths passed; actual admin refund dialog retry passed. These do not test installed service-worker upgrades or remote quotas. Windows PowerShell's redirected Node deprecation warning is retained in the smoke log; the assertion summary is authoritative for these checks, while L03 still needs a clean cross-platform runner.
- Typecheck, 51 frontend JavaScript syntax checks, fresh 0001–0012 migration/demo setup and dry-run Worker bundle passed. Final bundle: 523.78 KiB / gzip 120.49 KiB.
- The initial post-smoke inventory counted one expired booking without an expiry event. Source-state review confirmed the legitimate final proof-rejection path: its hold deadline is cleared and its effect is `rejected`. The query now excludes that documented terminal path. The revised 13-check inventory found zero candidates and no FK violations on synthetic local data; historical data remains unverified.

Redacted local artifacts are under `.wrangler/readiness-recovery-*.log`; runtime data is isolated at `.wrangler/readiness-recovery-runtime-20261007`. Hash manifests identify the preserved source and tested copy. Logs and scratch snapshots are ignored local artifacts, not committed CI evidence. Keep a reviewed patch/commit plus durable redacted staging artifacts before release.
