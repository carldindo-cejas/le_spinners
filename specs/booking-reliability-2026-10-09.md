# Booking overlap and approval reliability — 9 October 2026

## Root causes and evidence

The atomic booking insert in `src/worker/lib/bookings.ts` rejected both resource
overlaps and any occupying booking belonging to the same user. The second
predicate prevented different-facility reservations, including console bookings
created under a staff account. `explainRefusal` returned `OVERLAP_OWN`; the review
screen treated that response as a blocking error. Availability was already
resource-specific and did not need a new occupancy policy.

The production approval HTTP 500 was a code/schema mismatch. Read-only checks
of the configured `le-spinners` Worker and D1 database established that:

- The current deployment used version `1cdcb58c-94eb-41c6-8278-c38946a987ef`,
  created at 2026-10-09 07:15:29 Asia/Manila. Deployment identity was checked
  before and after inspecting the currently deployed code.
- Deployed code contained `approvePayment`, `authorizedBatch`, and the
  `mutation_authorization_guard` insert. Source and credentials stayed in
  memory; only presence checks and deployment identifiers were retained.
- D1 had applied migration `0020_payment_methods.sql`, but
  `0021_staff_account_management.sql` was pending and the guard table was absent.
  The metadata/schema checks did not read customer records or write rows.
- Both admin and staff approval reproduced HTTP 500 locally with the table
  absent. Applying the existing migration restored successful approval.

The authorization table must be created by the reviewed migration. Changing the
error response alone does not repair production. The migration creates the
guard, adds a staff index, and updates account credential/session invalidation
for email and other identity changes; it does not delete reservations, payments,
or users.

## Changes

| Files | Result |
| --- | --- |
| `src/worker/lib/bookings.ts` | Remove the user-wide overlap predicate. Retain atomic resource collisions, schedule/configuration fencing, closures, maintenance, credit accounting, and the two-unpaid-hold limit. Add owner-scoped advisory overlaps using actual booking segments. Report same-resource conflicts before hold-cap errors. |
| `src/worker/routes/bookings.ts` | Extend the existing quote with optional `date` and `personalOverlaps`. Reject out-of-range start minutes. Existing no-date quote clients retain their price/credit response. |
| `public/js/player/screens/book.js`, `public/css/player.css` | Responsive amber review warning with existing booking/facility times, Review / Change Time, and Continue to Payment. Fully funded bookings continue with credit. Preview failures offer Retry and cannot silently suppress a warning. Preserve selected gaps and payment/credit behavior. Use neutral same-facility conflict wording. |
| `src/worker/lib/payments.ts` | Recover an approval/rejection whose database batch committed but lost its response, using that request's unique transition token. Keep authorization failures blocked and unknown/rolled-back outcomes as failures. |
| `src/worker/lib/disruptions.ts` | Catch the initial post-commit deferred lookup failure. Keep disruption items available for staff retry and log the failure without turning committed payment decisions into HTTP 500. |
| `src/worker/lib/authorized-mutations.ts` | Missing guard schema fails closed with safe HTTP 503 and explicit migration logging. No authorization bypass or on-request table creation. |
| `scripts/check-deployment-schema.mjs`, `package.json` | Read-only deployment gate checks all migration names and required operation/payment tables. `npm run deploy` refuses missing schema and does not apply migrations automatically. Add reliability and browser test commands. |
| `scripts/verify.mjs`, regression/browser tests, `tests/smoke.mjs` | Include the new tests in verification and replace obsolete overlap-blocking expectations with the requested behavior. |
| `tests/pwa-browser.mjs` | Wait for the app's service-worker-controlled navigation; remove the test's competing reload. This fixes test synchronization without changing application behavior. |
| `README.md` | Document overlapping reservations, warning/hold behavior, tests, and migration-before-deployment order. |

Warnings use the existing occupancy rules: PAYMENT_SUBMITTED and CONFIRMED,
plus TEMPORARY/REJECTED only while their hold deadline is live. CANCELLED,
COMPLETED, EXPIRED, and elapsed holds are excluded. Strict interval comparisons
exclude adjacent times and gaps. Warnings concern only the signed-in player's
other facilities; they do not disclose another user's booking details.

There is no separate revenue insert for approval. Existing revenue reporting
derives one cash ledger row per booking from its verified state and
`confirmed_at`. Credit paid toward a reservation is excluded from collected cash.
Regression tests verify the cash/credit split, one proof decision, one approval
event, and one set of notification/outbox effects under repeat/concurrent calls.

## Additional confirmed bugs

1. A lost D1 batch response after a committed payment decision produced HTTP
   500. Unique-transition reconciliation now recognizes that request's commit.
2. The initial lookup in a deferred handler documented as “Never throws” sat
   outside its catch. A failure after approval produced HTTP 500 even though
   payment verification and revenue state were already committed. It is now
   handled and logged, with deferred work retained for retry.
3. Same-facility collisions at the hold cap could be misreported as
   TOO_MANY_HOLDS. They now consistently return `409 SLOT_TAKEN` first.
4. Quote requests accepted minute values outside a day. These now return
   validation errors.
5. Same-facility conflict UI attributed every collision to another player;
   duplicate own-facility requests now receive accurate neutral wording.

Verification also exposed a preexisting PWA test race: its explicit reload
could interrupt the app's reload on service-worker controller change. Delaying
the synthetic HTML response by 150 ms reproduced the original `ERR_ABORTED`.
The corrected test waits for the application's controlled document; the normal
run and four delayed runs passed all eight checks. No PWA application code was
changed.

## Executed verification

| Check | Evidence/result |
| --- | --- |
| `npm run verify:static` | Passed: 129 syntax checks, generated binding check, TypeScript, 424 automated tests, and Wrangler dry-run build. Retained log: `.wrangler/booking-reliability-static.log`. |
| New booking overlap regressions | 32/32 passed: exact/partial cross-facility overlaps; active/inactive statuses; gaps and legacy spans; same/different-user races; hold cap; availability/privacy; authorization; maintenance, hours, closures/configuration races; credits; rollback and replay; indexed query plan. Included in the 424 total above. |
| New approval regressions | 22/22 passed, including admin/staff, missing-table reproduction and migration recovery, repeated/mixed concurrent decisions, lost committed approval/rejection responses, deferred failures, rollback, invalid inputs/statuses, authorization, expired original hold deadlines, and cash/credit revenue. Included in the 424 total above. Six tests failed against the original implementation before the fixes. Existing payment tests also cover resubmitted/stale proofs. |
| Targeted browser checks | Combined warning/concurrency suites passed 34/34. Warning suite covers eight widths from 320–1920px, active overlaps, gap-preserving review, payment/credit continuation, no overlaps, preview delay/errors/Retry, facility conflicts, and network/malformed booking response recovery with stable idempotency keys. |
| Actual workerd → local D1 approval concurrency | Passed: ten simultaneous requests for admin and ten for staff each produced one HTTP 200, nine HTTP 409, one approval event, and one confirmation outbox record. Player approval returned HTTP 403. Evidence: `.wrangler/approval-d1-runtime-azVTwh/results.json`. |
| Deployment schema gate | Expected refusal against current production: pending 0021 and missing guard table. Passed against a fully migrated disposable local D1 database with 21 migrations. No remote mutations. |
| Browser verification | All suites completed successfully in stages. Initial `npm run verify:browser` passed public pages, refunds, outbox, images, lifecycle, logout, redirects, history, and facility checks, then stopped on the PWA reload race. After its test-only correction, PWA (8 checks, plus four delayed-response stress runs), accessibility (17), mobile payments (22), calendar/maps (18), player availability (12), staff management (18), and combined frontend concurrency/overlap (34) all passed. The original wrapper exit was 1; a fresh complete wrapper invocation was not claimed. Final changed PWA test syntax check and `git diff --check` passed. |
| `npm run verify:runtime` | Passed: 502 API smoke checks, real staff management, proof/QR storage and configurable payment methods, actual cross-isolate authentication races, read ramps at 20/35/50 callers plus a 15-second soak with no HTTP failures, and 157 public calendar checks. Disposable local D1/R2 fixture retained at `.wrangler/verify-runtime-X5V0H1`. |

SQLite tests use real transactions and fault injection but do not simulate
Cloudflare limits or network scheduling. The separate workerd/D1 and disposable
runtime checks cover the actual local Worker/D1 bindings. Browser fixtures use
the real frontend with synthetic APIs; they do not verify a real payment provider.
The D1 batch contract was checked against
[Cloudflare's D1 database API documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## Production step and remaining verification

Production is not repaired yet: the missing migration remains unapplied and
the new code has not been published. The concrete release sequence is:

1. Apply existing migration 0021 to the configured production D1 database with
   `npm run db:migrate:remote` after production-change approval.
2. Run `npm run verify:deployment` and confirm no migrations remain pending.
3. Publish the tested Worker/static assets with `npm run deploy`.
4. Recheck migration/schema metadata, deployed version, and safe read-only
   health/routes. Do not approve a customer's booking as a synthetic test.

No production reservations, payment approvals, customer notifications, or
provider messages were created during diagnosis. A real customer approval and
live warning/payment browser workflow remain unexecuted unless explicitly
authorized with suitable test accounts and a synthetic reservation.
