# Admin and booker mobile update — 2026-10-08

Implemented directly in the existing vanilla JavaScript PWA and Hono Worker, using the existing design tokens, D1 database, private R2 bucket, image validation and upload recovery machinery. Existing workspace changes were retained.

## Result

- Revenue cards use two columns on mobile and four on desktop. The explanation/reconciliation paragraphs and ledger description were removed. CSV export sits at the right of the ledger header. Native collapsible filters start closed on mobile and retain filtering, sorting, search, pagination and export behavior.
- The admin dashboard displays today's collected revenue and links to `/revenue/`. Its calculation uses the same verification date, facility timezone and collected-payment rule as the revenue report. Pending, rejected and unverified payments remain excluded; booking credit does not become cash revenue.
- Dashboard facility segments use blue for available pickleball courts, green for available table-tennis tables and red for unavailable resources. Counts are derived from resources, opening hours, current closures, maintenance, disabled status and occupying booking ranges. Open play remains open when the facility is open and the resource is available. Disabled resources appear in availability totals; existing operational `inService`/`total` fields retain their earlier meaning.
- Admins can create, edit, enable, disable and remove payment methods. Only the name is required. Account name and number have Add/Remove controls; QR images have Add/Replace/Remove controls. Each method saves independently of the main settings form.
- Bookers see enabled methods in a dropdown. Selection immediately changes account details and QR instructions. Missing details and QR containers are omitted, including methods containing only a name. A failed QR load removes its container and removes the details card when it has no remaining details.
- Proof submission stores the selected method ID/name and recipient details. Staff verification, booking details, payment history, ledger filters and CSV exports identify the selected method. Later method edits/removal do not rewrite submitted snapshots. Rejected proofs can be resubmitted using a different enabled method.
- A method disabled, removed or changed during proof upload is rejected before attachment; the unreferenced upload is retired. The booker retains their screenshot and receives refreshed choices. A removed selection requires an explicit replacement choice before resubmission.

## Persistence and compatibility

`migrations/0020_payment_methods.sql` creates the method table and snapshot columns. It imports the existing GCash account/QR settings and labels existing submitted online payments as GCash. Legacy settings and QR endpoints remain supported. Older proof clients that omit a selection use GCash only while that method remains enabled.

The existing `bookings.payment_method` cash-channel enum remains intact. Configurable online methods use that existing online channel; `payment_method_id` and immutable name snapshots identify the actual method. Removing a method disables and hides it while retaining the database row and historical associations.

QR handling reuses the existing authenticated private R2 routes, byte-level image validation, metadata stripping, 5 MB limit, staged ownership and durable cleanup tracking. Admin authorization and printable/length-limited payment details are enforced by the API. Client-provided storage keys are rejected. No new Cloudflare binding or bucket is required.

## Affected files

| Area | Files added or updated for this request |
| --- | --- |
| Revenue and dashboard UI | `public/js/admin/screens/revenue.js`, `public/js/admin/screens/dashboard.js`, `public/css/admin.css` |
| Admin payment settings | `public/js/admin/payment-methods.js` (new), `public/js/admin/screens/settings.js` |
| Booker flow | `public/js/player/screens/pay.js`, `public/js/player/screens/book.js`, `public/js/player/screens/booking.js`, `public/css/player.css` |
| Staff payment labels | `public/js/admin/screens/verify.js`, `public/js/admin/screens/bookings.js` |
| Database and shared rules | `migrations/0020_payment_methods.sql` (new), `src/worker/lib/payment-methods.ts` (new), `src/worker/lib/revenue.ts` (new), `src/worker/types.ts`, `src/worker/lib/bookings.ts` |
| Payment/storage integration | `src/worker/lib/payments.ts`, `src/worker/lib/storage.ts` |
| API routes | `src/worker/routes/admin-settings.ts`, `src/worker/routes/admin.ts`, `src/worker/routes/bookings.ts`, `src/worker/routes/facility.ts`, `src/worker/routes/revenue.ts`, `src/worker/index.ts` |
| Cache and documentation | `public/sw.js`, `README.md` |
| Verification | `tests/payment-methods.mjs` (new), `tests/mobile-payments-browser.mjs` (new), `tests/storage-runtime.mjs`, `tests/helpers/readiness.mjs`, `tests/concurrency-frontend-regression.mjs`, `scripts/verify.mjs`, `package.json` |

## Verification

| Check | Result |
| --- | --- |
| `npm run verify:static` | Passed: 116 JavaScript syntax checks, generated Worker types, TypeScript, 346 tests and Worker deployment dry-run/build. |
| `npm run verify:browser` | Passed: public pages, refunds, outbox, image round-trips, lifecycle, logout, redirects, pagination, facilities, PWA, accessibility, mobile payments and all 9 frontend concurrency regressions. |
| New payment-method regression suite | Passed: 13 tests covering legacy migration, authorization/validation, CRUD, enabled-only choices, selected proof snapshots, verification, reporting, resubmission, QR lifecycle and changes during upload. Included in static verification. |
| New mobile/payment browser suite | Passed: 22 scenarios at 320, 375, 390, 430 and 1440 px covering revenue layout/filters/pages/CSV, dashboard navigation/segments, admin method/QR controls, conditional booker details, proof selection and unavailable/error states. Included in browser verification and rerun after the final wrapping changes, including maximum-length names/account details without clipping. |
| `npm run verify:runtime` | Passed: all 20 migrations applied to disposable local databases; 500 API smoke checks; actual local D1/R2 legacy and configurable-method QR lifecycle checks; cross-isolate auth check; 15-second read-capacity soak; 157 isolated calendar checks. |

The browser tests run the real frontend with synthetic API fixtures. Payment-method API tests run the real Hono routes with isolated SQLite and controlled R2 fixtures. Runtime storage checks additionally exercise Wrangler's actual local D1/R2 bindings. The regular local database and remote resources were not reset or modified by verification.

Verification logs are retained in `.wrangler/mobile-static-verification.log`, `.wrangler/mobile-browser-verification.log`, `.wrangler/mobile-payments-final.log` and `.wrangler/mobile-runtime-verification.log`. Screenshots for the revenue page, dashboard, payment screen and method editor at 320, 390 and 1440 px are under `.wrangler/mobile-payments/`.

## Remaining rollout step

No deployment was performed. Apply migration `0020` after all preceding migrations, then deploy the API and frontend together using the existing release process. No local functional issue remains after verification; remote deployment behavior has not been tested in this task.
