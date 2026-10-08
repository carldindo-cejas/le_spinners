# Le Spinners System Report Implementation Tracker

Created: **2026-10-07, Asia/Manila**. Last updated: **2026-10-08, Asia/Manila**.

Source: [SYSTEM_REPORT.md](SYSTEM_REPORT.md), completed October 7, 2026. Audited baseline: commit `808863f` **plus the uncommitted working-tree changes described in the report**. Preserve that baseline when building reproductions; checking out the commit alone does not reproduce the full audited system.

**Production readiness: NOT READY.** Independent audit reviewed all 19 In review findings: **H01 and M12 accepted; 17 remain In review**, and M08/L01/I02/I03 remain In progress. Review found and repaired additional schedule, credit, facility-form, chat and history defects; the repaired working tree is **not deployed**. Production still runs version `fd7a20f6-0819-4cf6-8c66-22fb4434d675` with migrations 0001–0016. Fresh read-only inventories/security checks and the protected backup were independently reviewed. **Release gates: 0 passed, 11 blocked, G12 failed for candidate mismatch and unmet prerequisites.** See [independent review and release evidence](specs/audit-release-2026-10-08.md), [integrity review](specs/audit-integrity-2026-10-07.md), [browser review](specs/audit-browser-2026-10-07.md) and [operations review](specs/audit-operations-2026-10-07.md). No production repair, account reset, provider send or deployment was performed during this audit.

## 1. Progress and status rules

| Finding group | Total | Not started | In progress | In review | Done | Blocked | Deferred |
| --- | --- | --- | --- | --- | --- | --- | --- |
| High / P0 | 4 | 0 | 0 | 3 | 1 | 0 | 0 |
| Medium / P1 | 13 | 0 | 1 | 11 | 1 | 0 | 0 |
| Low / P2 | 3 | 0 | 1 | 2 | 0 | 0 | 0 |
| Informational / deployment or business verification | 3 | 0 | 2 | 1 | 0 | 0 | 0 |
| **All findings** | **23** | **0** | **4** | **17** | **2** | **0** | **0** |

Verified finding closure: **2 / 23**. All **19** original review items received independent implementation/evidence review; **17 / 23 remain In review because specific acceptance evidence is missing**, and **4 / 23 remain In progress**. Release gates: **0 / 12 passed; 11 blocked; 1 failed**. Technical finding acceptance does not pass separate runtime/device/release gates.

Preparation completed:

- [x] Read the source report and identify all 23 findings and the manual verification requirements.
- [x] Create an ordered implementation plan, dependencies, acceptance checks, evidence records, and release gates.
- [x] Preserve the audited working tree with a file-hash manifest and recreate the P0/M09 defect probes as maintained regression tests. The remaining probes are now maintained in the pinned verification toolchain.
- [ ] Assign named owners, reviewers, and target dates.
- [ ] Implement and validate the findings below.

Use these statuses consistently:

| Status | Meaning |
| --- | --- |
| Not started | Planned; no implementation or verification evidence recorded. |
| In progress | An owner is actively implementing or testing the item. Record the next action. |
| In review | Implementation and local checks are ready; review or required staging evidence remains. |
| Done | All item acceptance checks passed, required data/environment work completed, and evidence plus reviewer recorded. |
| Blocked | Progress needs a specific missing dependency, decision, or access. Record the blocker and owner of the next action. |
| Deferred | Explicitly accepted postponement with reason, risk, named owner, and revisit date. It does not count as Done. |

Unchecked boxes mean pending. Check a box only after its described work is complete. The finding register is the authoritative status list; keep its rows, the totals above, the release gates, and the activity log consistent. Proposed owner roles below are responsibilities to assign, not actual assignments.

For confirmed defects, Done requires a regression that demonstrates the defect on the audited baseline and passes on the fix, relevant existing suites passing, and the item-specific checks below. Potential risks require measurements; runtime findings require environment evidence; business findings require an accepted policy and matching behavior. A build alone is insufficient.

## 2. Implementation sequence

Deliver each finding or tightly related group in a reviewable change with its tests, migrations, reconciliation instructions, and documentation. Start the P0 work as soon as its reproductions run; full CI automation is not a prerequisite for fixing release blockers.

| Phase | Work and order | Depends on | Exit condition | Status |
| --- | --- | --- | --- | --- |
| 0 — Establish the working baseline | Preserved audited tree, maintained probes, pinned CI/types and read-only I01/I02 discovery implemented; named assignments remain pending. | None | Isolated repeatable local verification and reviewed owners. | In progress |
| 1 — Restore booking and financial integrity | H01–H04 and M09 code/migrations implemented; independent review, local regressions, integrated suites and historical SQL inventory pass. Controlled staging acceptance remains. | Phase 0 reproductions | H01–H04 pass deterministic regressions; schema/data remediation is reviewed; no losing-operation effects or duplicate financial debits. | In review |
| 2 — Make failures recoverable | M06/M07/M09–M11 independently reviewed and locally verified; historical SQL/R2 metadata inventory is clean. M08 capacity measurements, provider acceptance, retention and staging recovery remain. | Relevant H02/H03/H04 primitives | Storage/network/DB failures and retries converge to complete, consistent state with bounded work. | In progress |
| 3 — Repair authentication and browser behavior | M01–M05, M12 and M13 locally implemented and verified. | Local/browser/runtime harness | Independent review and intended-runtime/device authentication acceptance. | In review |
| 4 — Prepare for growth and repeatable releases | History API/UI, measured indexes, pins/types/CI, recovery and accounting reporting implemented. L01 cost/retention and I03 decisions remain open. | Relevant fixes; policy decisions | Repeatable integrated verification; approved retention/business rules. | In progress |
| 5 — Verify the release candidate in staging | Complete I01/I02; upgrade/restore rehearsal; security, cron, delivery, capacity, device/PWA, and accessibility gates. | Integrated candidate; isolated staging resources | Gates G01–G11 pass, or an eligible P2 deferral is explicitly accepted. Evidence identifies the exact candidate. | In progress |
| 6 — Controlled release and monitoring | G12: approved rollout, migrations, live read-only checks, smoke verification, monitoring, and recovery readiness. | G01–G11; normal release authorization | G12 passes; release decision and operational ownership recorded. | In progress |

Phases 2–4 may overlap for independent changes. Integrate shared schema and operation APIs before dependent work. Start I03 decisions and I01 migration-history discovery early so they do not surprise the release stage. Do not run staging capacity tests until the integrity fixes are integrated.

Design decisions to record in the relevant change before implementation:

- **H02/H04/M07:** durable operation identity, scope, request hash, conflict/replay response, retention, and how dependent SQL proves the winning operation. Timestamps remain timestamps, not request identities.
- **H03/M09:** an atomic schedule-scope protocol that every booking and schedule writer uses. A standalone read before a D1 batch cannot establish safety.
- **M06/M08:** durable claims, lease expiry, bounded batch size, checkpoints, retry/backoff limits, and recovery ownership. Confirm provider idempotency behavior during implementation.
- **M10/M11:** valid image acceptance contract, resource limits, staged-object ownership, and reconciliation of ambiguous commits across D1/R2.
- **M01–M04:** credential/session version rules and shared route/auth cancellation, listener disposal, and logout state behavior.

## 3. Finding register

The initial report remains the audit baseline. Codex owns the implemented changes. Independent review was performed by `/root/integrity_audit`, `/root/browser_audit`, `/root/capacity_ops` and consolidated by `/root` on October 7–8, 2026. Staging/data, retention, business and incident/release operators are still unassigned. Items remain open wherever their explicit acceptance requirements are unmet. Detailed checks and the exact remaining actions follow.

| ID | Priority | Deliverable | Proposed owner role | Dependency | Status | Evidence / completion date |
| --- | --- | --- | --- | --- | --- | --- |
| H01 | P0 | Canonical real-date validation and affected-data review | Codex; reviewer /root/integrity_audit; read-only operator /root | Historical date/schema review complete; broader runtime release gates remain | Done | [Independent review](specs/audit-integrity-2026-10-07.md): Accepted 2026-10-08: all five pre-migration/current date inventories zero; deployed constraints, populated upgrade and baseline/fix regressions independently reviewed. No historical correction required. |
| H02 | P0 | Unique winning-transition identity and guarded effects | Codex; reviewer /root/integrity_audit; operator pending | Historical-data/multi-isolate review | In review | [Independent review](specs/audit-integrity-2026-10-07.md): Source/effects reviewed; separate intended-runtime isolates across every transition and actual proof/response-loss validation remain. |
| H03 | P0 | Atomic booking/schedule affected-scope consistency | Codex; reviewer /root/integrity_audit; operator pending | Historical-data/staging contention review | In review | [Independent review](specs/audit-integrity-2026-10-07.md): Fixed omitted 501st booking; complete local scope/interleaving matrix and current historical counters pass. Controlled staging contention remains. |
| H04 | P0 | Durable refund replay identity and request matching | Codex; reviewer /root/integrity_audit; operator pending | Historical-refund/staging review | In review | [Independent review](specs/audit-integrity-2026-10-07.md): Replay/source/browser checks accepted; current credits/refunds/operations all zero, so historical repair is inapplicable. Controlled staging replay/response-loss acceptance remains. |
| M01 | P1 | Credential-version session creation and revocation | Codex; reviewer /root/browser_audit; operator pending | Historical sessions; staging race/recovery review | In review | [Independent review](specs/audit-browser-2026-10-07.md): Credential/session fencing reviewed; historical session policy and controlled intended-runtime portal/recovery acceptance remain. |
| M02 | P1 | Truthful, retryable logout across portals | Codex; reviewer /root/browser_audit; operator pending | Device/runtime and storage-fallback review | In review | [Independent review](specs/audit-browser-2026-10-07.md): Truthful revocation barrier reviewed; real cookies/tab ordering, storage fallback policy and devices/PWA remain. |
| M03 | P1 | Cancellation and stale route/auth response guards | Codex; reviewer /root/browser_audit; operator pending | Authenticated staging/device acceptance | In review | [Independent review](specs/audit-browser-2026-10-07.md): Async boundaries reviewed; repaired active console-thread crash and reversed verification-tab response race. Real-module regressions pass; full authenticated screen/action and installed-device/runtime sweep remain. |
| M04 | P1 | Route listener/dialog/polling cleanup | Codex; reviewer /root/browser_audit; operator pending | Full-screen/action and device review | In review | [Independent review](specs/audit-accessibility-2026-10-08.md): Cleanup reviewed; targeted repeat/dialog probes pass. Additional focus/description/custom keyboard defects repaired; 17 candidate browser cases pass and all 17 fail on the preserved baseline. Full 20-visit action/accessibility/device sweep remains. |
| M05 | P1 | Same-origin validated login return targets | Codex; reviewer /root/browser_audit; operator pending | Independent browser/device/staging review | In review | [Independent review](specs/audit-browser-2026-10-07.md): Return allowlists independently reviewed; intended HTTPS portal/device/PWA deep-link and expiry acceptance remain. |
| M06 | P1 | Claimed outbox delivery with provider replay protection | Codex; reviewer /root/integrity_audit; operator pending | Historical queue; controlled provider/staging review | In review | [Independent review](specs/audit-integrity-2026-10-07.md): Claims/replay/failure visibility reviewed; no legacy candidates. Controlled actual sender/recipient/provider recovery and staging remain; production provider absent. |
| M07 | P1 | Atomic booking/maintenance state and durable effect intents | Codex; reviewer /root/integrity_audit; operator pending | Historical-effect/staging review | In review | [Independent review](specs/audit-integrity-2026-10-07.md): Fixed unguarded partial-credit event causing false 500; complete local effects/retry tests pass; actual D1 multi-isolate response loss/client upgrade remains. |
| M08 | P1 | Bounded maintenance and measured polling/quota budget | Codex; reviewer /root/capacity_ops; operator pending | Plan acceptance; G07 runtime metrics | In progress | [Independent review](specs/audit-operations-2026-10-07.md): Local mixed soak completed 1,804.618s/19,249 requests/89 cycles/120 cron calls, zero HTTP errors and 30 zero invariant counters; all 73 delayed expirations occur once. 1,371 recovered transport warnings and read p95 2.85–3.15s prevent a clean performance claim. Intended-plan/full-demand metrics and accepted budgets remain. |
| M09 | P1 | Authorized field-only updates and schedule conflicts | Codex; reviewer /root/integrity_audit; operator pending | Staging/reviewer acceptance | In review | [Independent review](specs/audit-integrity-2026-10-07.md): Fixed stale default payloads and preserved Maintenance shortcut; 7 browser cases pass. Authenticated staging staff/admin price/status races remain. |
| M10 | P1 | Fail-closed image structure and metadata handling | Codex; reviewer /root/browser_audit; operator pending | Intended-runtime CPU/memory; device/reviewer acceptance | In review | [Independent review](specs/audit-browser-2026-10-07.md): Container acceptance independently reviewed; intended Workers near-limit/concurrent CPU/memory and supported-device appearance remain. |
| M11 | P1 | Safe upload cleanup and orphan reconciliation | Codex; reviewer /root/browser_audit; operator pending | Retention; staging recovery | In review | [Independent review](specs/audit-browser-2026-10-07.md): Attachment/deletion fencing and actual historical D1/R2 metadata reconciliation accepted: 8 proofs + 1 QR match all 9 bucket objects. Accepted retention and real staging cleanup/recovery remain. |
| M12 | P1 | Booking grouping using authoritative end times | Codex; reviewer /root/browser_audit; device operator pending under G08 | Independent end-time review complete; device/PWA release gate remains | Done | [Independent review](specs/audit-browser-2026-10-07.md): Accepted 2026-10-08: authoritative endsAt/list/home/payment-state semantics and boundary/skew/gapped regressions independently validated. G08 remains separate. |
| M13 | P1 | Shared-IP login capacity with retained abuse protection | Codex; reviewer /root/browser_audit; operator pending | G07 intended-runtime capacity and reviewer acceptance | In review | [Independent review](specs/audit-browser-2026-10-07.md): 50-account/attack/window/proxy contract reviewed and baseline reproduced; actual shared-NAT ingress and plan budgets remain. |
| L01 | P2 | Measured unread/cleanup queries and retention policy | Codex; reviewer /root/capacity_ops; operator pending | Accepted retention owner/policy; D1 cost/storage metrics | In progress | [Independent review](specs/audit-operations-2026-10-07.md): Independent 18k/36k query-plan/count benchmarks pass; actual R2 metadata stores 11,632,894 bytes across 9 objects. Realistic intended D1/index/R2 billed usage/growth and named retention/cost acceptance remain. |
| L02 | P2 | Stable keyset pagination and older-history UI | Codex; reviewer /root/browser_audit; operator pending | Independent history/filter/device review | In review | [Independent review](specs/audit-browser-2026-10-07.md): Fixed active-thread, server-side full-history filters/search and pager rollback race; local API/browser regressions pass. Explicit device/PWA/cost acceptance remains. |
| L03 | P2; tooling started early | Pinned browser tooling, generated types, repeatable CI | Codex; reviewer /root/capacity_ops; operator pending | Independent toolchain review and hosted CI run | In review | [Independent review](specs/audit-operations-2026-10-07.md): Pins/types/CI/isolation independently reviewed; new probes wired into maintained verification. Exact-candidate hosted Linux CI run remains absent. |
| I01 | P1 deployment gate | Populated-db migration, recovery, and restore evidence | Codex; reviewer /root/capacity_ops; operator pending | Named operator; intended-runtime restore acceptance | In review | [Independent review](specs/audit-operations-2026-10-07.md): Historical 0002 applicability, protected real export/hash/bookmark and populated upgrade reviewed. Actual isolated D1 restore/account access with named operator/RTO/RPO remains. |
| I02 | P1 deployment gate | Environment, secrets, privacy, and operational evidence | Codex; reviewer /root/capacity_ops; operator pending | Separate staging resource/plan mapping; owners and remaining gates | In progress | [Independent review](specs/audit-operations-2026-10-07.md): Current live boundaries/privacy/secret names/migrations reviewed. Account metadata confirms this app's production-only environment and current bindings/version; no isolated staging association verified. Billing-plan GET denied, so quotas remain unknown. Controlled provider, authenticated/device/operations acceptance and matching rollout remain. |
| I03 | P2; P1 for launch commitments | Accepted membership, desk-booking, and accounting rules | Codex; reviewer /root/capacity_ops; operator pending | Named membership/desk/accounting approval | In progress | [Independent review](specs/audit-operations-2026-10-07.md): Reporting tests/labels reviewed; no business decisions supplied. Membership expiry, desk ownership and accounting/launch-scope approval remain. |

## 4. Implementation and acceptance checklists

### H01 — Impossible calendar dates

Primary files: `src/worker/lib/validate.ts`, `time.ts`, `bookings.ts`, `facility.ts`, and booking/facility/disruption write routes.

- [x] Implement strict real-date/canonical round-trip validation at every affected write boundary; preserve overlap checks and add database date triggers (0009).
- [x] Independently review the protected pre-migration inventory and fresh production SELECT counts: all five date surfaces have zero invalid rows, so no correction/consequence repair is required. Review migration 0009 and populated-upgrade preservation; evidence E12. Reviewer `/root/integrity_audit`, accepted 2026-10-08.
- [x] Reject impossible February/November dates, zero/out-of-range components, and alternate encodings; accept leap dates. Reproduce equivalent-day conflicts and Manila midnight/window boundaries, with no partial bookings, slots, or credit writes on rejection.

### H02 — Duplicate transition effects from timestamp guards

Primary files: `src/worker/lib/bookings.ts`, `payments.ts`, and new operation/schema support as needed.

- [x] Replace `changedAt`/equal-millisecond winner assumptions with a uniquely identified conditional operation established in the same transaction as the state change; guard every dependent event, message, proof, ledger, and notification statement.
- [x] Independently review every former timestamp-guard caller: proof submission, approval/rejection, cancellation/release and expiry/completion; document safe conflict/retry behavior. Fresh equal-clock/terminal duplicate counters and SQL proof/chat-reference/FK checks are clear (E12). Actual R2 validity remains separate runtime/storage acceptance.
- [x] Independently verify local frozen-time winner/loser effects, rollback and retry regressions against preserved baseline and current implementation.
- [ ] Complete the specified separate intended-runtime isolate/response-loss tests across every affected transition and verify actual proof-object validity. Local transactions do not satisfy this runtime requirement.

### H03 — Booking omitted from a disruption or facility change

Primary files: `src/worker/lib/disruptions.ts`, `facility.ts`, `bookings.ts`, and schedule-related migrations.

- [x] Apply a transaction-checked facility revision to disruption commit, normal closures, resource state, weekly hours, and all booking writers. Changed scope causes conflict/re-preview before mutation.
- [x] Independently preserve ordinary acknowledged changes versus explicit cancel/credit workflows; review fresh ordinary/disruption closure, resource-status, hours and resource-overlap counters: all zero, so no historical resolution repair is required (E12).
- [x] Independently force local writes before planning, between planning/commit and after closure, for closure/maintenance/open-play/disabled/hours/disruption and hold/paid-console/full-credit writers. The complete matrix and fail-closed 501st-booking regression pass in the 60-test audit suite.
- [ ] Complete corrected-candidate controlled staging contention, affected-scope and effect reconciliation required by the finding register.

### H04 — Replayed partial refund

Primary files: `src/worker/routes/credits.ts`, `src/worker/lib/credits.ts`, refund callers, and financial operation migrations.

- [x] Require a durable idempotency key scoped to the refund operation and actor/credit; atomically store request hash, ledger change, effects, and replay result. Reject a changed request using the same key.
- [x] Independently verify stable client key/payload after response loss and distinct intended refund identities. Historical review is complete: deployed credit/refund/refund-operation counts are all zero; there is no external refund candidate to reconcile.
- [ ] Complete controlled staging refund replay/response-loss and actor/credit-scope acceptance required by the finding register; do not perform real cash movement as an audit test.
- [x] Test sequential and concurrent replay, response loss, changed amount/method, and genuinely separate refunds. One intended refund produces one debit, notice, and audit entry; remaining credit equals its ledger sum. API and browser retry checks also pass locally.

### M01 — Old-password login survives credential change

Primary files: `src/worker/routes/auth.ts`, `src/worker/lib/auth.ts`, session/user schema, and `scripts/create-admin.mjs`.

- [x] Add credential/auth versioning with conditional session creation and access validation; use compare-and-swap for concurrent credential changes. Include administrative resets and disabled-account behavior through migration 0015 and guarded provisioning.
- [x] Define and test which current session is retained by a password change and how other sessions are revoked. The initiating live session advances atomically; other sessions are deleted or rejected by version.
- [x] Pause an old-password login before insertion, change/reset credentials, then resume. Local deterministic and actual D1/workerd tests reject stale insertion; concurrent changes, resets, roles, disabling and re-enabling are covered.
- [ ] Independently review and verify intended-runtime portal races, historical-session preservation/revocation policy and populated migration/rollback/restore with a named operator. Requests already authenticated before revocation are not globally canceled by versioning.

### M02 — Misleading logout on network failure

Primary files: player profile/app, admin/staff shell, and shared auth handling.

- [x] Centralize logout, immediately remove private rendering and invalidate route/auth generations, and represent pending or failed server revocation truthfully with a retry action.
- [x] Clear session-related local caches/state and coordinate tabs without claiming server revocation before acknowledgment.
- [x] Test offline, timeout, 500, response loss after successful revocation, retry, reload, back navigation, and cross-tab behavior in all portals. A still-valid server session must not be presented as confirmed signed out. See E07 for synthetic-cookie evidence.
- [ ] Independently review intended devices/runtime, overlapping authentication/cookie ordering, BFCache/PWA upgrades and supported storage/Web Locks fallback policy; complete G08/G09.

### M03 — Late responses render private or unrelated views

Primary files: `public/js/core/router.js`, API handling, and asynchronous player/console screens.

- [x] Introduce route-owned mounts, route/auth generation guards, and cancellation signals. Bind view/helper capabilities before asynchronous boundaries and fence API results, rendering, navigation, shared-state changes and polling attachment. Independent source review complete (E12); real runtime/device acceptance remains.
- [x] Abort JSON requests, XHR uploads and CSV fetches while guarding already completed headers/body parsing; own delayed actions, polls and initial-load resources before view completion.
- [x] Locally reverse slow responses, test rapid back/forward, canceled saves/uploads and old-session 401 after synthetic identity changes in all portals. No stale private DOM, download or identity mutation in these probes; see E06.
- [ ] Complete actual login/logout integration, cross-tab, offline/reconnect, devices and PWA acceptance with M02/M05 and G08. Independent source-boundary review is complete; E12 additionally fixes and verifies reversed verification-tab success/error responses.

### M04 — Persistent listener and dialog accumulation

Primary files: profile, payment/action screens, player/admin shells, `public/js/core/dom.js`, and route cleanup.

- [x] Audit persistent-root handlers; use scoped mounts and immediately registered route/child disposers for direct/delegated listeners, dialogs, viewers, timers, polls, subscriptions, observers and blob URLs.
- [x] Verify local cleanup on navigation, route invalidation/errors and manual dialog close, including pending profile saves. M02 now supplies locally verified retry/reload/cross-tab behavior; real server/device review remains open.
- [x] Repeat profile visits twenty times in every portal, held/payment visits twenty times and proof viewer opens/closes twenty times; one dialog/release request and no stale navigation or scroll lock in local probes.
- [ ] Complete the independent full-screen/action sweep: visit each affected screen 20 times, then click each action once. Exactly one dialog/request occurs, with no stale booking action, focus trap, or poll surviving disposal; verify on intended devices and accessibility flows.

### M05 — Unsafe post-login return URL

Primary files: `public/js/player/screens/auth.js`, `public/js/core/router.js`, and portal login handlers.

- [x] Centralize return-target parsing against the current origin; require exact origin equality and an allowed local path. Reject ambiguous slash/backslash/control-character forms and use a safe local fallback.
- [x] Apply the same contract to player login/registration, staff/admin login and shared router navigation, including already-authenticated handoffs. Preserve valid search/fragment components through guards and session expiry.
- [x] Test encoded/plain backslashes, protocol-relative URLs, credentials, ports, dot segments, portal boundaries and valid deep links. Three regressions fail on both audited/pre-M05 snapshots; 10 deterministic tests and 27 browser scenarios pass on the candidate with external destinations intercepted. See E08.
- [ ] Independently review the portal route allowlists and intended browser/device/PWA behavior; complete relevant G04/G08 origin and upgrade verification. Synthetic local browser checks do not establish deployed-device readiness.

### M06 — Duplicate or inaccurate outbox delivery

Primary files: `src/worker/lib/outbox.ts`, `notify.ts`, migration 0013, admin outbox route, and Settings → Message delivery.

- [x] Add atomic durable claims/leases, conditional completion and shared cooldown, bounded provider fetch/read timeouts and response size, retry/backoff, exhausted-attempt visibility, and abandoned-claim recovery. Two sends per flush, five claims, 60-second lease, eight-second timeout and 18-second admission budget.
- [x] Persist a stable provider key and frozen payload; bind retries to the credential fingerprint. Document Resend's 24-hour retention, a conservative 23-hour application window and safe review after ambiguity/expiry. SMS stays unsent and visibly unsupported.
- [x] Local tests force overlapping flushes, timeout, successful send followed by D1 failure, lost responses, stale owners, replay expiry and retry exhaustion. A synthetic idempotent provider accepts one logical intent within its replay contract. Admin filters expose old failures and omit private delivery internals; actual browser checks pass.
- [x] Independently review the change and historical queue: attempted-legacy, expired-claim and invalid-checkpoint candidate counts are zero, so no legacy reconciliation is currently required. No uncertain message was resent.
- [ ] Verify controlled actual provider acceptance/replay, account/sender/recipient configuration, overlapping cron and upgrade/rollback/restore in staging. See E03/E12 and G03/G06/G11.

### M07 — State committed without recoverable effects

Primary files: `src/worker/lib/bookings.ts`, credit/effect helpers, and durable operation records.

- [x] Commit booking creation/expiry/warning/completion state, events/messages/notices, credit changes, outbox intent and console audit in one bounded transaction; guard maintenance effects with unique transition IDs. Provider delivery recovery remains M06.
- [x] Add actor-scoped creation keys and request hashes, atomic operation records, retry lookup, and client payload/key persistence for player/console/credit-funded creation, including changed quotes after an ambiguous commit.
- [x] Independently review fresh missing creation/expiry/completion event and warned-hold notice inventories: all zero. No historical repair or repair rehearsal is applicable; migration 0012 invents no history.
- [x] Local regressions inject failures throughout creation writes, lost commits/responses, changed-payload keys, competing commits during validation, partial-credit expiry rollback, overlapping maintenance and delayed catch-up; retries converge to complete new state.
- [x] Independently reproduce and fix the additional missing partial-credit event guard: an occupied-slot refusal returns SLOT_TAKEN with no credit/effect changes. The former remediation candidate returned a foreign-key/500 error.
- [ ] Verify actual D1 multi-isolate response loss and service-worker client upgrade in staging for the corrected candidate. Independent source and SQL historical review are complete.

### M08 — Maintenance and polling capacity

Primary files: `src/worker/lib/bookings.ts`, `maintenance.ts`, player/admin polling, and runtime configuration.

- [x] Bound expiry/warning/completion and deferred cleanup to 8 records; bound credit reconciliation to 8 booking IDs and hourly cleanup to 250 rows/table. Commit durable checkpoints/effects together and handle overlapping passes and delayed catch-up locally. Runtime headroom remains to be measured.
- [x] Coalesce badge refreshes and individual poll executions; pause hidden/offline/idle polling, add failure backoff and 60-second badge intervals. Record current official limits and conservative 50-user request projections in the recovery spec.
- [ ] Accept and verify the proposed Paid plan or demonstrate a revised Free-compatible design; measure mixed-screen polling, loaders that swallow errors, mini-chat, queue age, cron wall time and D1/CPU headroom. M06 provider timeouts are implemented; overall runtime capacity remains unmeasured.
- [ ] Measure staging batches of 1/10/12/50 expirations and disruptions around cron boundaries, then pass G07. Record actual CPU/query/row/request usage and complete effects; do not treat the audit's artificial SQL-statement cap as Cloudflare metering.

### M09 — Staff edit restores an outdated administrator price

Primary file: `src/worker/lib/facility.ts` and resource edit callers.

- [x] Update only supplied, authorized fields; staff SQL never writes price columns. Apply the H03 revision contract and conflict behavior for stale updates.
- [x] Independently inspect resource/pricing forms and fix stale facility defaults. Unchanged edits send no request; rename and note-only edits preserve other fields; the Maintenance shortcut retains the actual resource baseline. Seven maintained browser cases pass.
- [x] Independently synchronize staff rename/admin repricing, status and admin updates in local deterministic/actual-module browser probes. No unsubmitted field changes; stale schedule writes conflict.
- [ ] Complete authenticated staging resource-edit/race/reload acceptance required by the finding register for the repaired candidate.

### M10 — Image sanitizer fails open

Primary files: `src/worker/lib/images.ts`, `payments.ts`, `routes/admin-settings.ts`, and README image guarantees.

- [x] Reject malformed image structures instead of returning original bytes. Cover JPEG/PNG/WebP fallbacks; define dimensions/pixel limits and orientation/color handling. The selected implementation validates containers without decoding/re-encoding pixels; its limits are documented.
- [x] Apply the contract to proofs and GCash QR uploads and revise README claims to describe the actual validated sanitizer behavior.
- [x] Test valid EXIF/XMP/IPTC, malformed/truncated chunk lengths, trailing data, orientation/ICC handling, and excessive dimensions. Rejected uploads create no object/proof row; accepted images satisfy the documented metadata contract locally.
- [ ] Measure intended-runtime near-limit/concurrent upload CPU and memory, and verify other supported browsers/devices in staging. Independent acceptance-contract review is complete; the Node benchmark does not establish Workers headroom.

### M11 — Uploads orphaned after database failures

Primary files: `src/worker/lib/payments.ts`, `routes/admin-settings.ts`, and storage lifecycle/reconciliation support.

- [x] Add a staged-upload lifecycle with durable operation ownership, states, failure cleanup, and delayed orphan reconciliation for proofs and QR replacements. Legacy discovery is opt-in; deletion can be paused.
- [x] Resolve ambiguous commit outcomes using operation/reference checks before deletion; a successfully committed proof survives a lost response in regressions. Record retained tombstones, QR grace and cleanup-retry rules.
- [x] Inject R2 put failure, definite/ambiguous D1 failure, delete failure, QR replacement failure, and retry. Local D1/R2 fixture reconciliation preserves its 20 referenced objects and confirms eight retired fixture QR objects absent; these are local counts.
- [x] Independently inventory actual historical D1 references and the production R2 bucket using metadata-only GETs: 8 proofs + 1 current QR match all 9 tracked/bucket objects; no missing, inconsistent, untracked or orphan candidates. No downloads, deletions or repair were performed (E12).
- [ ] Approve retention and independently rehearse real multi-isolate failure, migration/rollback/restore and cleanup operations in isolated staging. The clean historical metadata inventory does not certify image contents or runtime recovery.

### M12 — Active multi-hour booking shown as past

Primary files: player booking/home screens and booking response DTOs as needed.

- [x] Expose/use authoritative booking end time or derive the final valid segment end in facility time; remove the fixed one-hour assumption from grouping and summaries.
- [x] Document how unresolved payment states remain actionable independently of date grouping.
- [x] Verify short, one-hour, multi-hour, gapped, and near-midnight bookings at exact start/end boundaries, with clock skew and all payment states. List and home agree with the server's end semantics. Independent reviewer `/root/browser_audit` reproduced both original list/home defects and accepted the source/API/browser boundary coverage; finding accepted 2026-10-08. Real-device G08 remains open.

### M13 — Legitimate shared-IP sign-ins blocked

Primary files: `src/worker/routes/auth.ts` and rate-limit helpers/configuration.

- [x] Define a shared-IP burst allowance, distinguish failures from normal successful traffic, and retain per-account plus aggregate abuse protection; document proxy/IP trust and recovery windows.
- [x] Avoid solving legitimate traffic by simply removing IP defenses or resetting counters an attacker can manipulate through unrelated successes.
- [x] Test 50 legitimate accounts sharing one IP, failures across one/many accounts, mixed traffic, IPv6/proxy behavior, and window recovery. Legitimate arrivals succeed while attack traffic remains bounded. Local checks pass.
- [ ] Confirm shared-IP ingress and resource budgets on the intended plan in G07.

### L01 — Historical query and storage growth

Primary files: chat unread counts, notification badges, maintenance cleanup, database indexes, and retention runbooks.

- [ ] Seed realistic six/twelve-month histories; capture plans, row reads/writes, latency, and storage. Benchmark partial/composite unread indexes and `rate_limits(window_start)`; retain changes supported by measurements and account for write cost.
- [ ] Define archive/deletion rules for messages, notifications, events, outbox, screenshots, and unconfigured SMS. Preserve financial/audit obligations; name retention and quota-monitoring owners.
- [ ] Verify exact unread counts, bounded cleanup, query/storage improvements, and retained audit/financial access. Record thresholds and evidence, or a reviewed P2 deferral with a revisit trigger/date.

- [x] Compare synthetic 18,000/36,000-message plans and latency with/without the partial unread index; verify exact counts and existing indexed cleanup. Local SQLite evidence and conservative retention proposal are recorded; intended D1 cost/storage and named policy acceptance remain open.

### L02 — Older history inaccessible through fixed caps

Primary files: booking/credit/chat/notification list APIs and their player/console screens.

- [x] Add bounded keyset pagination with deterministic timestamp-plus-unique-ID ordering, cursor metadata, filters, and `hasMore`; define cursor validation and authorization.
- [x] Add UI retrieval for older records without removing current bounds or exposing another user's history.
- [x] Seed more than each current cap and test equal timestamps, new concurrent rows, filtering, and cross-user/role access. Traverse the authorized fixture history without omissions or duplicate rows under the documented pagination contract.

- [ ] Complete device/PWA and intended-runtime cost acceptance. Independent filter/full-authorized-history review and maintained API/browser regressions are complete (E12).

### L03 — Tooling, generated bindings, and CI drift

Primary files: `package.json`, lockfile, `worker-configuration.d.ts`, `src/worker/types.ts`, browser tests, README, and new CI configuration.

- [x] Declare/pin reproducible browser tooling and commands; regenerate/review bindings against the intended config and secret contract. Add useful lint/static checks where justified by demonstrated risks.
- [x] Move the scratch-only race/failure/browser probes into maintained regression suites with synthetic fixtures, fixed/injected clocks, isolated state, and explicit commands. Add all relevant suites to CI without unrelated-workspace dependencies or real outbound mail.
- [x] Validate fresh install, browser installation, generated-type consistency, typecheck, dry-run bundle, and the full integrated suites from a clean isolated checkout. Record Node/tool versions and correct image documentation with M10.
- [ ] Run hosted Linux CI on the exact reviewed candidate and preserve the run URL/artifacts; local workflow review and test success do not supply this evidence.

### I01 — Populated-database credential migration

Primary files: `migrations/0002_client_password_hmac.sql`, deployment/recovery documentation, and administrative provisioning.

- [x] Inspect deployed migration history and affected account counts without exposing credentials. Determine whether 0002 is already applied, pending on a populated database, or relevant only to a fresh installation; record evidence for that determination.
- [x] Rehearse the representative pre-0002 populated upgrade on an isolated copy, including backup, account reset/reprovisioning, and restoration. Establish a player account recovery procedure before real users depend on the system; do not rewrite already-applied migrations.
- [ ] Verify post-upgrade access/recovery and a timed restore rehearsal. If the historical migration is inapplicable to the target database, record the supported rationale and still verify current upgrade/restore readiness under G03.

Deployed 0002 is already applied; all three current active accounts use the supported scheme. The original recovery/restore test is synthetic local SQLite. E11 adds a production SQL export, Time Travel bookmark, real exported-population local upgrade rehearsal and successful remote 0009–0016 upgrade. Named restore operator and actual D1 restore exercise remain pending.

### I02 — Deployed configuration and operational controls

Primary files: `wrangler.jsonc`, runtime bindings, auth/notification/cron code, and operational documentation.

- [ ] Establish separate staging Worker/D1/R2 and controlled mail settings; record intended resource identities, domain/origin, plan, secrets presence, privacy settings, and owners without secret values.
- [ ] Complete relevant G01–G11 evidence, including controlled runtime tests, redacted telemetry, restore, and incident runbooks. Enabled observability and a successful bundle are not live verification.
- [ ] Complete approved production configuration/controlled rollout acceptance under G12. Keep I02 open until required authenticated/device/operational live checks are recorded; staging success alone does not close it.

- [x] Perform read-only configured-target migration/account/integrity, secret-name and R2 public-access/custom-domain checks. Write staging/incident/recovery procedures and enable trace configuration. These checks do not pass a release gate.
- [x] Historical E11: execute the October 7 user-authorized production migration/deployment after backup and populated rehearsal; verify that candidate's migration history, public boundaries, assets and inventories. E12 now finds 18 source/public differences from that deployed version and three sampled asset mismatches; the repaired candidate is not deployed. Full authenticated/device/operational acceptance remains pending.

### I03 — Business rules requiring acceptance

Primary references: `REBOOKING.md`, membership and console booking logic, credit/revenue APIs, and operations reports.

- [ ] Obtain named approval of membership expiry/renewal behavior, desk-booking ownership for different named customers, and cancellation/credit/refund/revenue accounting. Record which rules are launch commitments and therefore P1 gates.
- [ ] Implement agreed gaps and label reports accurately; reconcile booking-status revenue with cash retained, credit balances/liabilities, and externally recorded refunds according to the accepted policy.
- [ ] Test expired membership, simultaneous desk bookings for different customers, a cancelled paid booking retaining credit, a credit-funded replacement, and a refund. Record expected results and business acceptance, or explicit P2 deferral for non-launch scope.

- [x] Separate recorded verified cash, refunds, active/unexpired credit balances and credit-funded value in the admin-only accounting summary; correct misleading refund labels and verify cancellation/replacement/refund totals and access. Membership expiry and desk ownership changes await an accepted rule.

## 5. Data and migration safety

Shared schema work may cover operation records, request hashes/results, auth versions, schedule scope versions, outbox leases, and staged-upload ownership. Select exact fields/constraints during implementation; do not add a speculative migration solely to satisfy this plan.

- [x] Independently inventory dates, transition effects, proof references, closure conflicts, refund replays and committed effects with current production read-only queries: 39 anomaly counters zero across 52 successful SQL/PRAGMA executions; all writes zero (E12).
- [x] Reconcile current credit/transaction balances (no current credit/refund rows), slot parent/span/envelope/overlap/status consistency, foreign keys and operation/effect uniqueness. Actual R2 metadata matches all 8 proofs and the current QR; no missing/unexplained objects (E12).
- [x] Review historical financial candidate counts using source/schema evidence: no current financial anomalies require correction. No history was deleted and matching timestamps were not treated as duplicate payments (E12).
- [x] Independently review additive migration order/backfills/index compatibility, populated preservation, supported Worker versions and documented forward-repair/rollback strategy. All ten current canonical date triggers match migration 0009 (E12).
- [x] Test fresh installation and representative populated upgrades in isolation; independently verify protected real export hash and Time Travel bookmark (E11/E12).
- [ ] Execute actual isolated D1 restoration with a compatible Worker, restored account access/history, named operator and timed approved RTO/RPO. Synthetic/local restoration alone does not satisfy G03.

Link each executed inventory/repair/migration result to the relevant finding and G03. Sensitive data belongs in restricted operational records; this tracker contains redacted counts and artifact references only.

## 6. Validation process and evidence

The source report records historical passes: typecheck, dry-run bundle, 492 smoke checks, 157 public-calendar checks, six public-page viewport widths, syntax checks, and local integrity checks. These are **audit baseline results**, not verification of remediation or the eventual release candidate. E01–E10 record the maintained candidate regressions and integrated verification separately.

For each change:

1. Reproduce the confirmed defect against the preserved audited tree using synthetic data; record the failing assertion and interleaving/fault.
2. Implement the smallest coherent fix with meaningful regression coverage; inspect schema and client impacts together.
3. Run the targeted regression and relevant existing suites against disposable local state. Keep synthetic email intercepted/disabled.
4. Review invariants, migrations, authorization, retry behavior, and documentation; record review evidence.
5. Run required staging checks on the intended runtime/plan and record the exact candidate revision, configuration, dataset, and results.
6. Close the item's checklist and register row only when its acceptance criteria are met; update totals and the activity log.

Current repository commands to preserve in the repeatable toolchain:

| Check | Current command / constraint |
| --- | --- |
| Worker types | `npm run typecheck` |
| Generated bindings | `npm run types`; review changes against config and handwritten types. |
| Bundle without deployment | `npx wrangler deploy --dry-run --outdir .wrangler/readiness-build` in a disposable copy. |
| Smoke setup/run | In a disposable copy only: `npm run db:reset:local`, start `npm run dev:test`, then `npm run test:smoke` with the isolated local `BASE_URL`. The reset wipes that copy's local database. |
| Public calendar | Follow README isolated setup for `.wrangler/landing-test-state` and port 8791, then `node tests/public-calendar.mjs`. The portable runner selects an isolated local target/store and writes only its fixtures. |
| Public pages | `node tests/public-pages.mjs` against the local server; L03 must supply the declared browser package/browser installation. Current tests mock APIs and block service workers. |
| Dependencies/static integrity | Run dependency audit, JS/manifest checks, local foreign-key checks, and supported read-only SQLite integrity checks in the repeatable harness. |
| New deterministic regressions | `npm run test:readiness` (Node 24) covers P0/M01–M04/M06–M11 races, replay, image acceptance, recovery, polling, dates, and upgrades; `npm run test:refund-ui`, `npm run test:outbox-ui` and `npm run test:images-browser` check browser behavior; `npm run test:lifecycle-ui` and `npm run test:logout-ui` use the read-only fixture server described in [the lifecycle spec](specs/readiness-lifecycle.md) and [logout spec](specs/readiness-logout.md). `tests/storage-runtime.mjs` and `tests/auth-runtime.mjs` require their verified disposable runtime/ports; see the relevant specs. Pinned browser installation, maintained shared-IP probes, generated types and CI are now implemented; full portal/device/staging review remains open. `npm run verify` is the integrated isolated runner; see the tooling specification. |

Run the full integrated suite on the candidate before staging/release; retain the existing checks while allowing test counts to grow. Record failures and rerun reasons rather than treating historical check counts as a required fixed total. No application tests need to run merely for creating this documentation.

Evidence record template — add one entry per implemented finding or executed gate:

| Field | Required record |
| --- | --- |
| Item and owner | Finding/gate ID, named implementer/operator, reviewer. |
| Candidate | Commit/PR plus any working-tree patch; migration/config versions. |
| Test context | Asia/Manila timestamp, local/staging/production, runtime/plan, tool versions, isolated fixture description. |
| Baseline reproduction | Expected defect and observed failure, or reason a runtime/policy item requires different evidence. |
| Verification | Exact command/scenario, assertions, counts/metrics, result, and links to durable redacted artifacts. |
| Data/runtime work | Reviewed reconciliation, upgrade/restore results, and relevant environment checks. |
| Closure or next action | Acceptance decision/date; remaining blocker, owner, and next action if incomplete. |

**Evidence E01 — P0/M09, 2026-10-07:** [implementation, tests, migration design, and remaining checks](specs/readiness-p0.md). Baseline: 21 of 24 regressions failed. Implementation: 24 passed; 494 smoke checks, 157 calendar checks, six public-page viewports, refund browser retry, typecheck, fresh/representative populated migrations, and bundle passed locally. Synthetic SQL inventory: zero candidates across nine checks and no FK violations. Historical production data and staging remain unverified. Do not attach credentials, password proofs, signing URLs, customer screenshots, or unnecessary personal information.

**L03 dependency follow-up resolved locally:** exact toolchain pins and sharp 0.35.5 override yield zero vulnerabilities after clean install/full audit. Independent toolchain/CI review is complete (E12); hosted Linux CI on the exact candidate remains pending.

**Evidence E02 - M07/M08, 2026-10-07:** [atomic/replay design, migration 0012, local recovery tests, current limits, workload budget and remaining checks](specs/readiness-recovery.md). Recovery baseline: 24 failed / 8 passed; implementation: all 60 readiness tests pass. API smoke: 494 assertions, zero failed; calendar: 157; six public-page widths and refund dialog retry passed. Fresh 0012 setup, populated local upgrade, typecheck, syntax and dry-run bundle verified. M07 In review; M08 In progress. Historical repairs, account/plan acceptance, provider recovery and G07 measurements remain pending. The Windows redirected smoke wrapper reported a nonzero status from a retained Node deprecation warning despite all assertions passing; L03 clean runner remains open.

**Evidence E03 — M06, 2026-10-07:** [delivery contract, migration 0013, local failure recovery, operator visibility and safe rollout/recovery](specs/readiness-outbox.md). Preserved baseline: seven failed / one passed; current integrated readiness suite: 87 passed, including 27 outbox tests. API smoke: 494 passed / zero failed, process exit 0. Typecheck, fresh local migration/demo setup, local D1/workerd claims/replay probe, real Settings screen with synthetic API data, JavaScript syntax and dry-run bundle pass. Five outbox inventory counts and foreign-key check are clear on synthetic data. M06 In review; controlled provider/staging checks, historical queue reconciliation and independent review remain open. No real messages or remote changes.

**Evidence E04 — M10/M11, 2026-10-07:** [image acceptance contract, migration 0014, upload/deletion fencing, local fault tests and operator procedure](specs/readiness-storage.md). Preserved baseline: 17 image regressions fail; storage probes fail three / pass one. Candidate: 141 readiness tests pass, including 25 image and 29 storage tests; API smoke passes 500 assertions, process exit 0. Twelve browser image comparisons, Settings delivery/upload recovery checks, typecheck, 51 JavaScript syntax checks, fresh and populated local migrations and dry-run bundle pass. Actual local D1/R2 QR replacement/removal/cron cleanup passes; read-only head checks confirm 20 referenced objects present and eight retired QR objects absent. Seven storage, five outbox and 13 integrity inventory counts are zero; foreign-key checks are clear. Candidate manifest records zero application-source drift from the isolated runtime; test-only scheduled routing is documented separately. M10/M11 In review; independent review, historical inventory/retention, staging CPU/memory and recovery evidence remain pending. No production storage changes or deployment.

**Evidence E05 — M01, 2026-10-07:** [credential/session version contract, migration 0015, administrative compare-and-swap and rollout/recovery](specs/readiness-auth.md). All four baseline regressions fail; candidate passes 23 auth tests and 164 integrated readiness tests. API smoke passes 500 assertions, exit 0; typecheck, fresh local migration/demo setup, populated migration regression, provisioning/test-script syntax and dry-run bundle pass. Two real local workerd isolates sharing D1 reproduce the pause/change/resume interleaving: stale login gets 401/no cookie, the initiating session remains valid, other sessions are revoked and only new credentials sign in. Actual local provisioning applies create/reset and rejects the stale reset. Three auth inventory candidate counts and FK check are clear on synthetic data. Candidate manifest records zero application-source drift. M01 In review; historical-session decision, independent review, staging and recovery ownership remain pending. No remote reset or deployment.

**Evidence E06 — M03/M04, 2026-10-07:** [route/auth ownership, cancellation and dialog cleanup contract](specs/readiness-lifecycle.md). Preserved 177 pre-fix files with hashes; all four original browser probes fail on that baseline and pass on the candidate. Candidate passes 17 lifecycle unit tests, 19 browser scenarios and 181 integrated readiness tests; typecheck and 56 module/script syntax checks pass. Existing refund retry, outbox and six responsive-page browser checks pass. Scope disposal precedes async view completion, APIs fence body parsing/auth changes, departed views have separate mounts, child dialogs cancel pending saves, and viewers/observers/export/preview resources are disposed. Candidate hashes record the reviewed local sources. M03/M04 In review; independent full screen/action sweep, M02/M05 integration, devices, accessibility and PWA/staging evidence remain pending. No migration, remote change, deployment or server-revocation claim.

**Evidence E07 — M02, 2026-10-07:** [truthful logout contract, cross-tab coordination, storage boundaries and maintained checks](specs/readiness-logout.md). Three pre-fix probes fail on the preserved baseline. Candidate passes 22 logout tests, 26 logout browser scenarios, 19 lifecycle browser scenarios and 203 integrated readiness tests. Existing refund/outbox/six-width public-page checks, typecheck, 60 JavaScript syntax checks and source/baseline hash checks pass. Tests intercept synthetic APIs and cookies, block service workers and do not establish real D1/workerd revocation. No Worker/schema changes or remote operations. M02 In review; independent device/runtime/cookie-ordering, fallback-policy, BFCache/PWA and accessibility review remain open.

**Evidence E08 — M05, 2026-10-07:** [shared URL parser, portal allowlists, local router fallback and maintained checks](specs/readiness-redirect.md). Three pre-fix browser probes fail on both the original audited snapshot and the preserved 180-file pre-M05 tree. Candidate passes 10 deterministic redirect tests, 27 redirect browser scenarios and 213 integrated readiness tests. Existing 19 lifecycle and 26 logout browser scenarios, refund retry, outbox and six-width public-page checks pass; typecheck and 58 JavaScript syntax checks pass. Login/registration and authenticated handoffs remain on the exact origin; valid deep-link search/fragments survive guards/session expiry. All redirect-test external requests are intercepted and service workers are blocked. Baseline/source hashes identify the local candidate; no Worker/schema changes, remote operations or deployment. M05 In review; independent allowlist/device/PWA review and G04/G08 remain open.

**Evidence E09 — M12/M13/L02, 2026-10-07:** [time/auth/history contracts](specs/readiness-remaining.md). Sixteen new deterministic/API tests and fourteen browser scenarios pass. Audited-baseline probes show both ongoing-booking views omit the booking and only 30/50 shared-IP salt arrivals succeed. Candidate verifies bounded scoped pagination beyond old caps, ties, inbox concurrent activity, changed filters/cross-actor cursors, and recorded accounting/admin access. M12/M13/L02 In review; independent device/PWA/staging acceptance remains open.

**Evidence E10 — L03/I01/I02/L01/I03, 2026-10-07:** [tooling](specs/readiness-tooling.md) and [operational evidence](specs/readiness-operations.md). Clean install and matching browser installed; generated types, TypeScript, 95 syntax checks, 231 regressions, dry-run bundle and zero-vulnerability full audit pass. Clean browser verification passes six viewport widths, refund/outbox, 12 image comparisons, 19 lifecycle, 26 logout, 27 redirect and 14 remaining scenarios. Isolated runtime passes 500 API assertions, actual D1/R2 storage recovery, two-isolate auth race, 15-second read capacity and 157 calendar checks. Populated pre-0002 upgrade/recovery/backup restore and six/twelve-month query measurements pass locally. Actual deployed read-only inspection finds 0001–0008 already applied, three supported active credentials, required secret names present, and proof public access/custom domains disabled. Thirteen historical integrity candidate counts are zero and FK output is empty. No production mutations/deployment/provider send. L03 and I01 In review; M08/L01/I02/I03 intended plan/staging/device/retention/business/owner acceptance remains open.

**Evidence E11 — User-authorized production deployment, 2026-10-07:** [Target, backup, rehearsal, version and live evidence](specs/deployment-2026-10-07.md). `npm run db:migrate:remote` applied 0009–0016; `npm run deploy -- --keep-vars` deployed version `fd7a20f6-0819-4cf6-8c66-22fb4434d675` and minute cron. Pre-migration SQL export and Time Travel bookmark are protected/ignored; the real exported population upgrades locally with credentials/row counts preserved and no FK violations. Live 13 page/API-boundary/asset checks pass; 13 integrity, three auth, seven storage and five outbox candidate counts are zero, with empty FK output. No pending migrations remain; row counts preserved. Seven queued emails remain unconfigured. This deployment does not pass the outstanding independent/staging/device/business/recovery gates or close all findings.

**Evidence E12 — Independent audit, 2026-10-07–08:** [consolidated candidate/test/gate record](specs/audit-release-2026-10-08.md), [integrity acceptance](specs/audit-integrity-2026-10-07.md), [browser/auth/image/history acceptance](specs/audit-browser-2026-10-07.md), [operations/capacity/policy acceptance](specs/audit-operations-2026-10-07.md), [account/staging/plan evidence](specs/audit-account-2026-10-08.md) and [supplemental accessibility/tab acceptance](specs/audit-accessibility-2026-10-08.md). All 19 original review items independently reviewed; only H01/M12 meet full finding closure requirements. Additional defects were reproduced and repaired with maintained regressions. Final complete `npm run verify` finished exit 0 at 13:14:26 Manila: **294 regressions/106 syntax checks**, current bindings/types/dry-run build, all maintained browser suites including 17 supplemental cases and 8 anonymous PWA probes, **500 API assertions**, actual local D1/R2/two-isolate authentication and **157 calendar checks**. Candidate: 197-file fingerprint `5919397ed4c598a77795c74a854d202fca0afde56aee83fbd6f74073545597e8`; final log/exit receipt and runtime-source consistency are recorded in the consolidated report. Local mixed soak completed 1,804.618s/19,249 requests/89 cycles/120 cron calls, zero HTTP errors and 30 zero counters, but read p95 2.85–3.15s and 1,371 recovered GET warnings prevent clean performance acceptance. Actual production inventories: 52 SQL/PRAGMA executions, 39 anomaly counters zero, quick_check ok, FK empty and all writes zero; all ten date triggers match migration 0009. Metadata-only R2 reconciliation accepts all 9 actual objects against 8 proof/1 QR references; no missing/unexplained candidates. Required secret names exist and R2 public access/domains are disabled/absent. Account refresh at 13:09 confirms production-only app association/current version; billing-plan access is denied. Provider acceptance, intended-plan capacity, retention, devices/accessibility, real recovery and business approvals remain open. Repaired working tree has 18 source/public differences from production; three sampled live assets mismatch. Failures, interrupted runs and corrected calendar-relative fixture reruns remain recorded; no approval or missing runtime result is inferred.

## 7. Production release gates

Each gate was evaluated independently on October 7–8, 2026; E12 records the reviewed candidate and evidence. Blocked means a specified required test/decision/environment is unavailable, not a pass. Failed records an observed unmet condition. Named operational owners remain to be assigned. Record the candidate, owner, date and evidence for every subsequent run. G01–G11 establish candidate readiness for an authorized rollout; G12 establishes the verified release outcome. A gate may fail even when its associated code finding is Done.

| Gate | Required pass evidence | Related findings | Status | Independent result / next action |
| --- | --- | --- | --- | --- |
| G01 — Staging separation | Separate Worker, D1, R2, secrets, and controlled mail configuration; resource mapping reviewed; synthetic testing cannot hit production or real recipients. | I02 | Blocked | Fresh metadata inventory confirms app service has production environment only; no verified isolated resource association. Supply separate Worker/D1/private R2/origin/test secrets/controlled mail map and intended plan. Unrelated account resources were not assumed staging. See E12. |
| G02 — Integrity and regression | H01–H04 and all medium/P1 fixes meet acceptance criteria; integrated suites pass; affected data reconciled with no unexplained booking/ledger/effect/proof inconsistencies. E12 completes independent source/SQL and actual historical R2 metadata review; intended-runtime/staging and capacity acceptance remain pending. | H01–H04, M01–M13, L03 | Blocked | Independent review, full integrated verification and historical SQL/R2 metadata pass; H01/M12 accepted. Other P1 staging/runtime/capacity acceptance and exact-candidate hosted CI remain. See E12. |
| G03 — Migration and recovery | Fresh/populated upgrades pass; I01 applicability and migration history recorded; backups/Time Travel verified; restore/account recovery rehearsed with duration and owner. E01–E10 verify local upgrades through 0016 and deployed 0002 applicability; intended-runtime backups/restoration and named operator remain pending. | I01, I02; data checklist | Blocked | Fresh/populated local upgrades, protected backup SHA/bookmark and remote migration history verified. Actual isolated D1 restore/account access, owner and timed RTO/RPO exercise missing. See E12. |
| G04 — Secrets, storage, and origin | Redacted evidence of correct pepper/signing secret contract and rotation procedure; HTTPS/exact APP_ORIGIN; no unintended R2 public URL/domain; authenticated signed proofs, expiry, CSP/no-store/nosniff, cookies, and CORS verified for every portal. | I02, M01, M05, M10, M11 | Blocked | Current anonymous boundaries/headers/origin rejection, secret names and R2 privacy pass. Actual authenticated HTTPS cookies, signed proof/expiry/CORS across portals, secret custody/rotation acceptance missing. See E12. |
| G05 — Scheduling and catch-up | Actual minute trigger, overlapping cron/lazy maintenance, delayed ticks, bounded catch-up, restart recovery, and complete event/credit/effect reconciliation on intended runtime. | H03, M07, M08, I02 | Blocked | Minute trigger configured; local catch-up/overlap probes and mixed soak completed, including 120 cron calls and 73 exactly-once delayed expirations. Actual intended-runtime overlap/delay/restart/queue/effect acceptance missing. See E12. |
| G06 — Delivery and storage lifecycle | Controlled sender/recipient test; send-success/DB-failure recovery; failure/expired-lease queue visibility; proof/QR reconciliation and retention; explicit supported/unsupported SMS behavior. | H02, M06, M10, M11, L01, I02 | Blocked | Actual historical SQL/R2 metadata reconciliation and unsupported SMS labels pass. Controlled provider replay/send-success-D1-failure acceptance, real staging cleanup/recovery and accepted retention remain missing. Production provider key absent. See E12. |
| G07 — Capacity and quotas | Mixed 20/35/50-user ramp plus 30-minute soak, realistic history/uploads/shared NAT/cron/disruptions; agreed service targets and invariant checks pass; actual metrics and usage projections fit intended plan with recorded headroom. | M08, M13, L01, I02 | Blocked | Local 30-minute HTTP/invariant soak completed; 19,249 requests, zero HTTP errors, 30 zero counters. Read p95 2.85–3.15s exceeds proposed 1s; 1,371 recovered local GET warnings. Actual intended-plan CPU/billing/headroom, realistic annual distribution, near-limit uploads, competing/bulk disruption/shared-NAT demand and accepted budgets remain. See E12. |
| G08 — Browser and PWA | Player/staff/admin authenticated flows; Android/iOS installation; service-worker upgrade/termination/offline/reconnect; cross-tab logout, session expiry, deep links, back/forward, and delayed-response safety. | M02–M05, M12, I02 | Blocked | Independent synthetic portal/browser checks and eight actual Chromium anonymous service-worker probes completed. Android/iOS install and full authenticated device/PWA/cookie/tab/offline acceptance missing. See E12. |
| G09 — Accessibility | Keyboard and screen-reader booking/payment/console flows, single-dialog focus/return, error announcements, contrast, reduced motion, and text scaling; launch-blocking failures corrected. | M04, I02 | Blocked | Source-confirmed dialog-focus/help-description/custom-keyboard, proof-viewer contrast and stale-tab defects repaired; 17 candidate real-module cases pass against 17 preserved-baseline failures. Full authenticated keyboard/screen-reader/error-announcement/contrast/reduced-motion/scaling/device acceptance and named tester remain missing. See E12. |
| G10 — Business and growth acceptance | Launch-critical I03 rules accepted and tested; report/ledger reconciliation accepted; L01/L02 and non-launch P2 items Done or explicitly deferred with risk, owner, revisit date, and operational mitigation. | I03, L01, L02, L03 | Blocked | Membership, desk ownership, accounting, retention/cost policy and any eligible P2 deferrals remain unapproved; older-history device/cost and hosted CI requirements remain. See E12. |
| G11 — Incident operations | Request-ID tracing, redacted/restricted logs and retention, alerts for cron/outbox/errors/quota pressure, useful dashboards, recovery/runbooks, and named incident/release owners tested. | M06–M08, M11, I02 | Blocked | Logs/traces configured and runbooks reviewed. Demonstrated restricted/redacted log retention, alert delivery/dashboards and named incident/recovery/release response missing. See E12. |
| G12 — Controlled release | User-authorized production rollout executed with matching resource mapping, protected backup/bookmark, populated upgrade rehearsal and live public/auth-boundary/asset checks (E11). Remaining G01–G11 acceptance, authenticated portal smoke, actual restore and named monitoring/recovery ownership are still pending. | I02; G01–G11 | Failed | Deployed fd7a20f6 differs from repaired candidate and lacks new fixes; G01–G11 are unmet. No matching authorized candidate rollout/authenticated smoke/monitoring/recovery acceptance in this audit. See E12. |

G07 workload must include login, calendar/list reads, competing booking writes, delayed requests/retries, near-limit proof uploads, approval/rejection, refunds, disruption application, and expiry around cron boundaries. Seed months of synthetic booking/message/event history and disable/intercept outbound delivery except G06's controlled recipient test.

Record per-endpoint p50/p95/p99, errors and unintended 429s, CPU/memory-limit failures, actual D1 queries/rows read/written, queues, R2 operations/storage, polling volume, and daily/monthly usage projections. Assert no active overlapping slots, negative or duplicate credit changes, duplicate winning effects/deliveries, or dangling proofs. Recheck official limits for the intended account/plan when executing; audit-date limits are not current account verification.

**Proposed service targets, awaiting acceptance:** ordinary reads p95 < 1 second and ordinary writes p95 < 2 seconds. Agree upload latency, acceptable error rates, queue delay, quota headroom, and restore/recovery objectives before the run. These are targets, not achieved results. A paid plan may address measured capacity but does not close integrity/recovery defects.

Release decision rules:

- Any open H01–H04 or medium/P1 acceptance gap blocks launch. I01/I02 deployment evidence and launch-critical I03 commitments also block launch.
- P2 postponement requires a recorded acceptance with scope, risk, mitigation, named owner, and revisit date; it remains Deferred. Required release-tooling portions of L03 must pass G02 regardless of its P2 classification.
- Mark **Ready for controlled rollout** only after G01–G11 pass and eligible deferrals are accepted. Mark **Production ready / verified release** only after G12 passes and the live I02 checks are complete.
- Reopen affected findings/gates when a regression or material code/config/schema change invalidates their evidence. Baseline audit success cannot close a gate on a different candidate.

Release decision record — pending:

| Field | Current value |
| --- | --- |
| Candidate revision and migrations | Reviewed repaired working tree over `808863f`, exact file hashes in `.wrangler/audit-candidate.json`; migrations 0001–0016. Production still fd7a20f6, a different candidate. |
| Accepted launch scope / service targets | Not recorded |
| Named release, operations, and business owners | Not assigned |
| Accepted P2 deferrals | None |
| Rollout/recovery plan and window | Not scheduled |
| Gate evidence and reviewer decision | E12: independent review complete; 0 passed / 11 blocked / G12 failed. |
| Readiness decision | **NOT READY** |

## 8. Update routine and activity log

At the start of an item, assign its owner and target date, move it to In progress, and record the next action. On every completed change/check, update its checklist, register evidence, phase status, totals, and affected gates. Keep failed checks and blockers visible. Preserve the original audit report as the baseline; use this tracker for implementation progress and renewed readiness decisions.

| Date (Asia/Manila) | Item | Action / evidence | Result / next action |
| --- | --- | --- | --- |
| 2026-10-07 | Tracker setup | Reviewed SYSTEM_REPORT.md and repository test/config commands; created this implementation plan covering 23 findings and 12 gates. | Planning complete; all remediation and runtime gates remain Not started. Next: assign owners, preserve baseline, and recreate P0 reproductions in isolated state. |
| 2026-10-07 | Phase 0 / L03 | Preserved 130 baseline files with hashes, added pinned esbuild and maintained P0 SQLite/Worker regression command. | Baseline comparison: 21 failed / 3 passed. Browser pinning, full CI, generated types, and development dependency advisory remain open. |
| 2026-10-07 | H01–H04 / M09 | Added migrations 0009–0011, strict dates, winning-transition IDs, refund replay records/header/client retry, schedule revision guards, authorized field-only resource updates, and read-only inventory. | Implemented; local verification passed. Set five findings In review; see E01. No remote changes. |
| 2026-10-07 | M07 / M08 | Added migration 0012, atomic booking/maintenance effects and console audit, creation replay keys and browser persistence, bounded checkpoints/reconciliation/cleanup, polling coalescing/idle/backoff and candidate indexes. Added historical-effect inventory and current workload/plan budget. | M07 In review; M08 In progress. E02: 60 readiness tests pass, 494 smoke assertions / 157 calendar checks and browser checks pass locally. Historical data and staging capacity remain open. |
| 2026-10-07 | M06 | Added migration 0013, durable claims/frozen provider replay data, conditional acknowledgements, timeout/backoff/shared cooldown, bounded recovery and truthful queue labels/filters. Preserved and compared the original sender; added 27 local failure/migration/access tests and a browser queue check. | M06 In review; E03 records local verification. Historical queue, controlled provider/staging evidence and independent review remain pending. No remote changes or real sends. |
| 2026-10-07 | M10 / M11 | Added bounded image structure validation and orientation sanitization; migration 0014 stages uploads, fences attachment/deletion, retains retry tombstones and scan cursors, and atomically retires QR replacements/removal. Added admin recovery counts, cleanup pause/legacy scan flags, read-only inventory and fault/browser/local R2 checks. | M10/M11 In review; E04: 141 readiness tests, 500 API assertions and 12 image comparisons pass. All referenced fixture objects exist; retired QR cleanup confirmed. Staging CPU/memory, historical reconciliation/retention and independent review remain open. |
| 2026-10-07 | M01 | Added migration 0015 and credential/role/status version fencing; guarded session creation/rotation and touch; atomic password-change retention/revocation/audit; conditional administrative provisioning. Added four baseline probes, 23 auth regressions, maintained workerd pause fixture and read-only inventory. | M01 In review; E05: 164 readiness tests and 500 API assertions pass. Real cross-isolate race and local provisioning verified. Historical-session policy, independent review and staging recovery remain open. |
| 2026-10-07 | M03 / M04 | Added immediate route/auth cancellation and response guards, separate mounts, scoped view capabilities/listeners/timers/polls, child dialog cleanup, canceled profile saves, shared viewer scroll locks and export/preview/observer disposal. Added 17 lifecycle tests and 19 real-module browser scenarios; four pre-fix probes fail as expected. | M03/M04 In review; E06: 181 readiness tests, browser regressions, existing refund/outbox/public-page checks and typecheck pass. Independent full sweep, devices/PWA and staging remain open. No remote changes. |
| 2026-10-07 | M02 | Centralized pending/failed/confirmed logout, immediate private-state/message cleanup, durable intent and explicit-login acknowledgement, timeout/retry/reconnect, tab coordination and serialized authentication with documented storage/Web Locks fallbacks. Added 22 deterministic tests and 26 browser scenarios; three baseline probes fail as expected. | M02 In review; E07: 203 readiness tests, logout/lifecycle and existing browser checks, typecheck and syntax pass locally. Independent device/runtime, cookie-ordering, fallback-policy and PWA review remain open. No remote changes. |
| 2026-10-07 | M05 start | Assigned Codex with a local target of 2026-10-07; preserved the pre-M05 tree and documented the exact-origin, allowed-path and syntax rejection contract. | Started parser, portal/router integration and audited-baseline probes. Independent reviewer/operator unassigned. |
| 2026-10-07 | M05 | Centralized return-target validation across login/registration and router navigation; added portal route allowlists, local fallbacks and deep-link fragment preservation. Added 10 deterministic tests and 27 browser scenarios; three probes fail on both audited and pre-M05 snapshots. | M05 In review; E08: 213 readiness tests, redirect/lifecycle/logout and existing browser checks, typecheck and syntax pass. Browser executable selection and an initial font-request classification issue were corrected in the test harness; see evidence. Independent device/PWA/origin review pending; no remote changes. |
| 2026-10-07 | M12/M13/L02 | Added authoritative booking end grouping, shared-IP arrival/failure budgets, scoped keyset APIs/Older-Newer UI and additive history indexes. | E09: new regressions/browser scenarios and baseline probes verified; In review. |
| 2026-10-07 | L01/L03/I01/I02/I03 | Pinned browser/toolchain and generated bindings; added CI/disposable runtime runner, measured indexes, recovery CLI/rehearsal, accurate accounting and operational runbooks. Read-only deployed migration/credential/secret/privacy/integrity discovery completed. | E10: clean static/browser/runtime verification and audit pass. L03/I01 In review. Capacity, retention, staging/resources, devices, business decisions and named review/operations acceptance remain open. No remote mutation or deployment. |

| 2026-10-07 | User-authorized Cloudflare deployment | Confirmed verified candidate/production mapping; exported/backed up D1 and captured Time Travel bookmark; rehearsed real exported population; ran remote migrations 0009–0016 and deployed Worker/assets/minute cron. | E11: version `fd7a20f6-0819-4cf6-8c66-22fb4434d675`; 13 live checks and post-migration inventories pass; no pending migrations. G12 In progress; overall readiness/review/policy/operational gates remain open. |

| 2026-10-08 | Independent audit of all 19 review findings and all 12 gates | Separate reviewers inspected actual code, migrations, preserved-baseline failures, historical inventories and operational records; fixed additional schedule/form/credit/thread/filter/pager defects, added meaningful regressions and local mixed/PWA tooling. See E12. | H01/M12 Done; 17 In review; M08/L01/I02/I03 In progress. Gates: 0 passed / 11 blocked / G12 failed. Repaired candidate is not deployed; remaining manual actions and actual test outcomes are in the consolidated record. |
| 2026-10-08 | Supplemental M03/M04/G09 and final evidence verification | Repaired dialog/viewer focus, help/error descriptions, radio/tab keyboard handling, viewer focus contrast, reduced-motion scroll paths and reversed verification responses; preserved 17 baseline failures and verified 17 candidate passes. Corrected an expired date test fixture without changing production SQL or weakening live assertions. | Final integrated exit 0 at 13:14:26 Manila: 294 regressions/106 syntax checks, all maintained browser suites, 500 API and 157 calendar checks. Current candidate fingerprint/runtime and refreshed read-only production/account evidence recorded in E12. Full device/accessibility, staging, policy, recovery and release acceptance remain open. |

Append dated entries as work progresses. Do not mark planned work or the source audit's previous passes as newly completed remediation.
