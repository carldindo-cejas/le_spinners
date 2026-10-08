# P0 integrity implementation and verification

Implemented and checked locally: **2026-10-07, Asia/Manila**. Findings: **H01–H04 and M09**. Implementer: Codex. Independent reviewer and staging operator: unassigned. Status: **In review**, not production approval.

## Changes

- **H01:** `zDate` uses the existing canonical real-date round trip. The shared booking library also checks dates before writing. Migration 0009 adds insert/update date triggers to bookings, slots, closures, disruptions, and resource maintenance dates. Existing malformed rows are preserved for explicit investigation/repair.
- **H02:** every former `changedAt` caller now installs a random `transition_id` with its winning conditional UPDATE. Proofs, messages, events, notifications, outbox entries, and credit returns use that identity inside the same D1 batch. A losing request cannot borrow another request's matching timestamp. An already-completed transition retry returns a conflict without more effects; this is not a general response-replay API.
- **H03:** a database revision captured before planning is checked at the start of the mutation batch. Triggers advance it for booking/slot/resource/hour/closure/disruption-item writes. A mismatch aborts the whole batch. Booking writers, ordinary facility changes, disruption apply, and deferred resolution participate. Disruption apply returns `DISRUPTION_CHANGED` with a refreshed preview; other mutations return `SCHEDULE_CHANGED`. Existing credit-quote conflict responses are preserved when the credit balance changed.
- **H04:** refunds require `Idempotency-Key`, scoped to actor and credit, with a request hash covering amount, method, reference, and note. Ledger debit, notification, audit entry, and stored operation result commit together. Identical replay returns the original `refund` result even after a full refund; changed payload returns `IDEMPOTENCY_KEY_REUSED`. The response's `credit` and `history` remain current read models. The admin dialog reuses its key on retry and guards duplicate in-flight clicks; a separate dialog represents a new intended refund.
- **M09:** resource updates write only supplied authorized fields. Staff updates never include price columns. The revision guard rejects stale resource/schedule reads; the response reloads the current resource.

The schedule revision is deliberately facility-wide. An unrelated concurrent booking or resource write can cause a safe conflict and require a retry. Staging must measure conflict rates, additional D1 writes, and latency before G07 is approved. Narrower scopes are a future optimization only if they retain participation by every relevant writer.

These transactions follow [D1 batch rollback semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). They do not make R2 operations or mail delivery atomic with D1. M06/M07/M08/M10/M11 remain open; post-creation effects and orphan recovery still need their planned work.

## Reproduce the local tests

Use **Node 24** for the readiness harness (validated with 24.14.0); the application runtime prerequisite is unchanged. The harness uses Node's experimental `node:sqlite`, real bundled application code, transactional SQLite batches, synthetic identities/images, and mocked R2. `esbuild` 0.28.1 is now an explicit pinned development dependency.

```powershell
npm ci
npm run test:readiness
npm run typecheck
```

`test:readiness` needs no running server or credentials. It writes its generated bundle under ignored `.wrangler/readiness-tests-*` directories and keeps its database in memory. It validates invariants under chosen interleavings; it does not emulate Cloudflare scheduler timing, query metering, or quotas.

The exact pre-change working tree was copied to `.wrangler/readiness-baseline-20261007`, including a SHA-256 `baseline-manifest.json`, excluding real secrets and normal `.wrangler` state. That local evidence is not a committed clean-checkout fixture. To compare while the snapshot remains available:

```powershell
$env:SYSTEM_TEST_ROOT = '.wrangler/readiness-baseline-20261007'
node --test tests/readiness-p0.mjs  # expected failure against the old implementation
Remove-Item Env:SYSTEM_TEST_ROOT
npm run test:readiness
```

`tests/refund-retry.mjs` exercises the actual admin screen with intercepted API requests and service workers blocked. Run `npm run test:refund-ui` against a disposable local server using `BASE_URL`. It accepts `PLAYWRIGHT_MODULE`/`BROWSER_EXECUTABLE` like the existing public-page suite. Browser package/install pinning and full CI are still L03 work; this run used the same external Playwright/Chromium installation as the original audit.

## Recorded evidence

Candidate: uncommitted changes on `808863f`, including existing public-page/calendar changes and the implementation above. No deployment or remote migration was run. Tests used isolated state at `.wrangler/readiness-runtime-20261007`; the normal local development database was not reset.

| Check | Result | Local evidence |
| --- | --- | --- |
| Final 24 readiness tests against preserved baseline | **21 failed, 3 passed**, exit 1 as expected | `.wrangler/readiness-baseline-final.log` |
| Same 24 tests against the implementation | **24 passed, 0 failed** | `npm run test:readiness`; maintained source in `tests/readiness-p0.mjs` |
| TypeScript and modified frontend syntax | Passed | `npm run typecheck`; `node --check public/js/admin/screens/credits.js` |
| Worker dry-run bundle | Passed; 518.67 KiB / 119.59 KiB gzip | `.wrangler/readiness-bundle.log` |
| Fresh migrations 0001–0011 + demo D1/R2 setup | Passed in disposable local runtime | `.wrangler/readiness-runtime-setup.log` |
| Populated 0008 → 0011 upgrade | Passed; legacy malformed date preserved, explicit repair allowed, subsequent invalid writes rejected; FK/integrity checks passed | Readiness migration regression |
| API smoke | **494 passed, 0 failed**, including refund replay and changed-payload rejection | `.wrangler/readiness-smoke.log` |
| Public calendar | **157 passed** with separate isolated calendar state | `.wrangler/readiness-calendar.log` |
| Public pages | Passed at 320, 375, 430, 768, 1024, and 1440 px | `.wrangler/readiness-public-pages.log` |
| Refund browser retry | Passed: same key/payload after lost response; new key for a separate refund; no page errors | `.wrangler/readiness-refund-ui.log` |
| Read-only SQL inventory after smoke | Zero candidates in all nine counters; no FK violations | `.wrangler/readiness-inventory.log` |
| Production dependencies | `npm audit --omit=dev --json`: zero reported vulnerabilities | Audit-time result only |
| Development dependencies | `npm audit --json`: three high entries through sharp → miniflare → wrangler | Follow-up below; **not resolved** |

The full audit reports [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) in the development dependency chain. No dependency upgrade or forced downgrade was applied: the suggested automated fix changes Wrangler substantially. L03 must verify a compatible patched toolchain and rerun checks before release; this supersedes the original report's historical zero-advisory result. This finding does not come from a newly added production dependency.

## Migration and historical-data procedure

1. Establish the target environment and applied migration history. Verify backups and an isolated restore before live changes (I01/I02/G03).
2. Run `scripts/readiness-inventory.sql` against a representative isolated copy first. It is read-only and works with both 0008 and 0011. Review invalid dates, repeated-effect/refund candidates, ledger mismatches, and missing disruption items. Matching refunds are only candidates; external payment evidence is required before any correction.
3. Reconcile private R2 objects separately under M11. SQL cannot prove object existence or detect all orphans; do not publish keys or screenshots in tracker evidence.
4. Review historical date/financial corrections and preserve their audit trail. The new migrations do not delete, normalize, or silently compensate existing records.
5. Apply **0009_canonical_dates.sql**, **0010_transition_refund_identity.sql**, then **0011_schedule_revision.sql** before running the new Worker. Existing application tables gain additive schema/triggers; the old code does not provide the new integrity guarantees.
6. For the eventual authorized rollout, coordinate a mutation pause while applying migrations and switching to the verified Worker/assets. Old refund clients without a key receive 400 and must reload; they must not be grandfathered into unkeyed financial mutations. Resume writes only after controlled verification.
7. Do not drop refund replay records or roll back to the vulnerable Worker while writes are enabled. A failed release needs the reviewed forward repair or rehearsed restore procedure. A Worker version rollback alone does not revert D1/R2 data.

Historical production data, real restore/recovery, separate staging behavior, multi-isolate races, sustained capacity, and device/service-worker updates have **not** been verified. Keep H01–H04/M09 In review and G01–G12 incomplete until their remaining evidence is recorded.
