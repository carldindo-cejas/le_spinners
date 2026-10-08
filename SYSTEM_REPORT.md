# Le Spinners System Security, QA, and Readiness Report

Audit started: **2026-10-06**. Report completed: **2026-10-07, Asia/Manila**. Recommendation: **Not Ready for production release**. Test fixtures and measurements below retain their original October 6 audit date.

This is the initial report; no previous `SYSTEM_REPORT.md` existed. All findings below remain open. This audit changes only this report, not application code. Final comparison of 121 source, asset, script, test, migration and seed files against the isolated audit copy found no differences; the audit's local servers were stopped after testing.

The reviewed baseline is the current working tree at commit `808863f`, including the existing uncommitted public-page/calendar work. Pre-existing changes in `DESIGN_MEMORY.md`, `README.md`, `public/index.html`, the router, player app/auth screen, service worker, availability library and facility route, plus the new landing CSS/screen and public tests, were preserved. Findings describe this working tree rather than just the committed revision. Locations below are relative to the project root and refer to this baseline.

Evidence labels:

- **Confirmed:** directly supported by inspected implementation and, where stated, reproduced locally. A deterministic concurrency reproduction does not measure how often that interleaving occurs in production.
- **Potential:** a credible risk supported by code or query plans, without a demonstrated production failure.
- **Requires Runtime Verification:** depends on deployment, account configuration, data history, or devices unavailable to this audit.

## 1. Executive Summary

The application has substantial working functionality and useful security boundaries: server-side role and ownership checks, server-calculated booking prices, prepared SQL, private authenticated proof delivery, restrictive browser headers, and a broad integration suite. Type checking, bundling, fresh migrations and the existing local regression suites passed.

Nevertheless, four high-severity integrity problems were reproduced:

1. Impossible calendar dates can represent the same real day under different database strings, defeating booking conflict checks (**H01**).
2. Millisecond timestamps are used as payment-transition identifiers; simultaneous requests can create duplicate proof/event/notification rows, including a dangling screenshot reference (**H02**).
3. A booking created between disruption planning and commit can remain live inside the new closure without a disruption item (**H03**).
4. Replaying a partial refund deducts the same credit again (**H04**).

Further reproduced issues affect password-change revocation, logout accuracy, stale private views, event-listener cleanup, post-login redirects, outbox delivery, partial database operations, screenshot cleanup, resource updates, booking presentation, and shared-IP login capacity. Passing happy-path and ordinary two-request race tests did not cover these particular interleavings and failure cases.

**There is no demonstrated critical vulnerability or general unauthenticated administrator bypass in this audit. This is not a claim that such vulnerabilities are impossible.** No live penetration testing or production account inspection was performed.

The measured local public-calendar bursts completed at 20 and 50 simultaneous requests, but this does **not** establish support for 20–50 production users. Continuous polling alone can exceed the Workers Free daily request allowance under a plausible 50-user workload. Cron query fan-out and multipart image processing need real-runtime measurement and bounded processing.

## 2. Overall System Health

| Area | Evidence-based assessment |
| --- | --- |
| Build and basic correctness | TypeScript and Worker dry-run bundle passed; 56 JavaScript files passed syntax checks. |
| Existing automated regression coverage | Smoke suite: 492 passed, 0 failed. Public calendar: 157 checks passed. Public pages: six viewport widths passed. |
| Authorization and data exposure | Server-side boundaries were traced and covered by representative smoke tests; no broad bypass reproduced. |
| Booking/payment/credit integrity | Release blockers H01–H04; additional partial-failure and stale-update defects. |
| Frontend lifecycle | Actual Chromium reproductions of stale private rendering, duplicate dialogs, misleading logout and open redirect. |
| Database | Fresh migration chain and local integrity checks passed; transaction boundaries and growth behavior need work. |
| Operational recovery | Outbox and several post-transition effects lack reliable replay/reconciliation. |
| Deployment | Configuration bundles locally; secrets, deployed bindings, private R2 settings, telemetry and restore readiness unverified. |
| Capacity | Small local read bursts measured; sustained mixed production workload unproven. |

Coverage included all route modules and their middleware, all Worker library modules, schema/migrations/seeds, provisioning/reset scripts, frontend core/player/admin/staff modules, HTML/CSS/manifests/service worker, package/TypeScript/Wrangler configuration, and tests. A static inventory covered 104 text files under `src`, `public`, `scripts`, `tests`, `migrations`, and `db`; configuration and project documentation were reviewed separately. Binary icons, screenshot fixtures and nine design PDFs were inventoried; this was not a pixel-by-pixel design-PDF comparison. Not every authenticated screen was exercised interactively on every browser.

End-to-end traces covered registration/login/session/password changes; availability/quote/hold/payment review; release/expiry/cancellation; disruption preview/apply and deferred resolution; credit issue/use/return/refund; chat/notifications/outbox; revenue/export; and role-specific shell routing. Static inspection, integration checks, deterministic fault injection, browser probes, and deployment verification are distinguished throughout this report.

## 3. Security Assessment

| Threat area | What was inspected/tested | Result and limitation |
| --- | --- | --- |
| SQL injection | Prepared statements throughout route/library code; dynamic SQL fragments derive from controlled choices. Smoke tests exercised malformed input. | No SQL-injection exploit reproduced. Provisioning SQL is separate from public request handling. |
| XSS and browser isolation | `public/js/core/dom.js` escaping, rendering call sites, `_headers`, Worker response headers, proof content types. | No stored/reflected XSS reproduced. `raw` uses must remain restricted to trusted markup. CSP and `nosniff` reduce exposure; they do not validate uploads. |
| CSRF/CORS | `src/worker/index.ts:77`, SameSite cookies, origin/fetch-site checks; smoke origin tests. | Cross-site mutations are rejected in tested cases; no permissive credentialed CORS policy found. Requests without Origin are not automatically evidence of a CSRF exploit. Verify deployed origin configuration. |
| Role escalation/BOLA | Namespace guards, per-handler role checks, booking/credit/proof ownership; smoke cross-user and cross-role checks. | No broad bypass reproduced. M09 demonstrates an indirect stale overwrite of an administrator-controlled price. |
| Input validation | Zod schemas, body limits, date/time helpers, upload sniffing, server price computation. | Date validation inconsistency is H01; upload sanitizer fail-open is M10. |
| Redirects | Player `safeNext` and shared router URL parsing. | Confirmed off-origin post-login redirect, M05. |
| Secrets and error exposure | Tracked/config/example files, filename-only secret-pattern scan, error serialization, frontend bundles and smoke response assertions. | No actual credential was disclosed in this report. `.dev.vars` values were not read. Example development values are not proof of a leaked production secret. Git-history and deployed-log secret scans were not performed. |
| Payment proof access | Signed expiry, authentication, ownership/staff checks, server-generated object keys, private/no-store response policy. | Representative unauthorized and tampering cases passed. Bucket public-access settings require dashboard verification. H02/M11 concern lifecycle integrity despite these access controls. |
| Dependencies | Installed dependency inventory and `npm audit --json`. | Zero reported vulnerabilities at audit time. This only covers advisories known to the registry and the installed dependency graph. |

The Worker enforces 64 KiB JSON bodies and approximately 10 MiB plus multipart overhead for upload routes (`src/worker/index.ts:52`). Files have a separate 10 MiB check, detected image type and generated key. Client filenames do not select storage paths. These protections do not make malformed images structurally valid, and fully buffered concurrent uploads still need CPU/memory testing.

## 4. Authentication and Authorization Assessment

The client derives a PBKDF2 password proof with 600,000 iterations; the Worker applies a server-secret HMAC before storing it. The browser-derived proof is a password-equivalent credential and must remain protected in transit and logs. The inspected frontend does not persist it as a login token. `passwordPepper` fails closed for missing/short peppers and refuses the designated development value outside localhost (`src/worker/lib/auth.ts:22`). The generated binding declaration does not fully match the handwritten runtime bindings; see L03.

Sessions use random tokens, store their hashes in D1, and set HttpOnly, SameSite=Lax cookies with Secure on HTTPS. Staff/admin lifetime is 12 hours; player sessions have a 30-day sliding lifetime. Session loading joins current user role/status from D1, rather than trusting a role supplied by the browser. Portal-specific sign-in and wrong-role rejection are implemented and exercised by the smoke suite.

Password changes update credentials and delete other sessions, but an already verified old-password login can insert a new session afterward (**M01**). Logout server behavior is sound in the tested normal path; the frontend incorrectly treats network failure as successful logout (**M02**). A late route response can also render private content after navigation to login (**M03**).

Login throttling combines per-email and per-IP counters. The IP counter includes successful logins and permits only 30 per 15 minutes; a local original-router probe returned 429 on the 31st valid attempt (**M13**). This matters for a facility Wi-Fi connection shared by the requested 20–50 users. Raising a limit without preserving failed-attempt protection is not the recommended fix.

No player self-service password-recovery route was found. That is especially relevant to the older credential migration (**I01**) and must have an operational recovery procedure before real accounts depend on the system. MFA, email delivery, browser cookie behavior on the deployed domain and session revocation across isolates were not end-to-end tested in production.

## 5. Booking and Business Logic Assessment

The server computes prices, validates resource/activity and slot selections, checks ownership, and applies status transitions. Client-supplied totals are not authoritative. Booking insert predicates check conflicting active slots; exact active starts have a partial uniqueness constraint. Existing smoke tests include same-slot competition, player overlap policy, credit overspend, credit return, changed quotes, cancellation/disruption behavior and revenue/export cases.

Those controls are useful but incomplete:

- **H01:** the booking write accepts a date shape without validating a real calendar date. JavaScript date normalization and SQL string equality disagree.
- **H02:** payment transition effects can execute for the losing request when two requests share `now`.
- **H03:** a newly inserted booking can fall outside a disruption's precomputed affected set.
- **H04:** a refund operation has no durable replay identity.
- **M07/M08:** booking and scheduled state changes can persist before events/notices fail; retrying does not necessarily repair them.
- **M09:** a concurrent staff resource update can overwrite a newer administrator price.
- **M12:** the player list/home assumes every booking lasts one hour, despite multi-hour and segmented bookings.

Time conversion consistently uses the configured Manila offset of +480 minutes in the principal server workflows. Public-calendar date validation and calendar integration tests are stronger than the shared booking-write date schema. Ordinary hold expiry and timezone behavior passed the existing tests; impossible dates, midnight boundaries after changes, split segments and delayed cron still need the specific regression cases in section 14.

Payment screenshots are manually verified evidence, not a bank-confirmed payment feed. A claimed screenshot amount is compared and flagged, not treated as a trusted receipt. Refund recording represents money paid outside the app; H04 corrupts the credit/refund ledger and does not itself initiate two bank transfers.

Some behavior is an explicit product decision: the same staff account owns console-created bookings even when the displayed booker name differs; owner-overlap restrictions therefore also affect that account. Revenue recognition after cancellations/credits and membership expiry policy need business confirmation (**I03**), rather than being labeled arithmetic or authorization bugs without an agreed rule.

## 6. Database and Data Integrity Assessment

All eight migrations applied successfully to a new isolated local D1 database. After the smoke suite, `foreign_key_check` returned no violations. SQLite `integrity_check` on the local backing database, opened read-only, returned `ok`. The emulator rejected a combined integrity PRAGMA call with `SQLITE_AUTH`; the independent foreign-key command and read-only SQLite inspection were the successful alternatives. These checks apply to the synthetic local database, not production.

Useful constraints include foreign keys, unique user identities/session IDs, active exact-start protection and credit-ledger invariants. Cross-row interval consistency still depends on the application write predicates. A unique `(resource,date,start)` constraint alone cannot exclude arbitrary interval overlaps or normalize invalid calendar strings. Financial mutation paths should retain integer minor units and ledger-derived balances.

Individual D1 batches provide transaction boundaries, but reads performed before a batch and R2 writes outside it are not made atomic by the batch. This distinction explains H02/H03/M07/M09/M11. Use unique operation records and conditional transitions, not a timestamp as proof that a particular request won. [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

Local `EXPLAIN QUERY PLAN` found:

| Query shape | Observed plan | Interpretation |
| --- | --- | --- |
| Staff unread chat count | `SCAN m USING INDEX idx_messages_booking`, then indexed read-marker lookup | Scans message history on repeated badge requests; growth concern L01. |
| Staff unread notification count | Search `idx_notifications_user` by audience | Existing index narrows audience but does not fully cover unread filtering. |
| Rate-limit housekeeping by `window_start` | `SCAN rate_limits` | Full cleanup scan; significance depends on accumulated records. |

These are query-plan observations on small local fixtures, not measurements of slow production queries. Benchmark candidate partial/composite indexes and their added write cost before adopting them.

History and credit lists have fixed limits without a complete cursor workflow (**L02**). Messages, notifications, events, screenshots and queued SMS can grow without a documented retention process. Retention must preserve financial/audit obligations while controlling D1/R2 growth. Migration 0002 clears credentials and sessions and needs deployment-history verification before any upgrade (**I01**).

## 7. API Assessment

All route definitions were inspected together with mount order in `src/worker/index.ts:104`. The table groups aliases and related endpoints; `ops` means `/api/staff` or `/api/admin`, with staff/admin allowed in the staff namespace and only administrators in the admin namespace. Protected handlers also call role/ownership helpers. Public HTML console shells contain no account data; permission enforcement belongs to the API.

| Endpoint family and methods | Required access / validation traced | Result or remaining issue |
| --- | --- | --- |
| `GET /api/health` | Public minimal health/time response | Not a D1/R2/notification readiness probe. |
| `POST /api/auth/salt`, `/register` | Public schemas, salt/proof format, registration role chosen by server, throttles | Smoke registration/invalid input checks; real email ownership/recovery workflow unverified. |
| `POST /api/auth/{user,staff,admin}/login`, `/login` alias | Portal role, credentials, active user, IP/email throttles | M01, M13. |
| `POST /api/auth/logout`; `GET /api/auth/session`, `/me` alias | Current session/null session, restricted user DTO | Normal revocation tested; frontend M02. |
| `GET/PATCH /api/me`; `POST /api/me/password` | Any signed-in user, allowlisted profile fields and credential verification | M01; no client-selectable role update found. |
| `GET /api/facility`, `/facility/calendar` | Public allowlisted facility/availability data, calendar date range | 157 calendar checks; no customer/proof information in tested public response. |
| `GET /api/facility/gcash-qr` | Signed-in access, configured R2 key/content type | Missing asset and production bucket behavior need deployment verification. |
| `GET /api/availability`, `/availability/days`, `/availability/alternatives` | Player, resource/date validation, bounded search | Smoke availability checks; write path date inconsistency H01. |
| `GET/POST /api/bookings`; `GET /quote`, `/:id` | Player; own list/detail, server pricing, slot/credit validation | H01, M07, L02. |
| `POST /api/bookings/:id/proof`, `/release`, `/cancel` | Player ownership and permitted status; cancel intentionally returns conflict under current policy | H02, M10, M11; release/credit-return tests passed. |
| `GET/POST /api/bookings/:id/messages` | Player booking ownership, message limits | Cross-user tests passed; history cap L02. |
| `GET /api/credits`, `/:id` | Player ownership | Ledger/ownership checks; L02. |
| `GET /api/notifications`, `/badges`; `POST /read` | Player-scoped notifications/read mutations | Polling cost M08, query growth L01. |
| `GET /api/files/proofs/:id` | Authenticated owner or operations role, signed expiry, stored object key | Smoke privacy/signature checks passed; runtime bucket privacy unverified. |
| `GET ops/{summary,dashboard,rules,badges,verifications,schedule}` | Operations role, bounded filters; server DTOs | M08, L01; HTTP read may trigger maintenance. |
| `GET/POST ops/bookings`; `GET ops/bookings/:id` | Operations role, console-booking schema, resource/slot rules | H01, M07; console owner-overlap policy I03. |
| `POST ops/bookings/:id/{approve,reject,cancel}` | Operations role, booking status, reason/message checks | H02; business policy enforced server-side. |
| `GET ops/messages`; `GET/POST ops/bookings/:id/messages` | Operations role, text constraints | History/query growth L01/L02. |
| `GET ops/notifications`; `POST ops/notifications/read`, `/:id/resolve` | Operations role, audience/record checks | Smoke coverage; polling/retention concerns. |
| `GET/POST ops/facilities`; `PATCH ops/facilities/:id` | Operations role; explicit price changes admin-only | M09; affected-booking read/write gap adjacent to H03. |
| `GET ops/availability`; `PUT ops/availability/hours/:weekday`; `POST/DELETE ops/availability/closures[/:id]` | Operations role, schedule/confirmation rules | H01; concurrent affected-set verification required. |
| `POST ops/disruptions/preview`, `ops/disruptions`; `GET` list/detail; `POST /:id/items/:bookingId/apply` | Operations role plus scope permissions, preview token, operation key | Existing replay checks are useful; H03 survives because the affected snapshot can change. |
| `GET ops/credits`, `/:id` | Operations role | Staff read-only monetary workflow; L02. |
| `POST /api/admin/credits`, `/:id/void`, `/:id/refund` | Administrator, amount/state checks; manual issue has operation key | Refund lacks equivalent replay protection, H04. |
| `GET/PUT /api/admin/settings`; `PUT/DELETE /settings/gcash-qr`; `PATCH /resources/:id`; `GET /outbox` | Administrator; settings/upload/price schemas | M09–M11; queued delivery behavior M06. |
| `GET /api/admin/revenue/{summary,ledger,export}` | Administrator; bounded filters, export pagination/version checks, CSV escaping | Existing totals/CSV tests passed; accounting definition I03. |

The shared error handler emits structured codes/request IDs and hides unexpected stack traces from API clients. Tested status categories include unauthenticated/forbidden/not-found, validation, conflict, payload-too-large and throttling. Each endpoint was statically reviewed; the table does not imply exhaustive fuzzing of every parameter combination. No authenticated public data endpoint was found to rely solely on hidden frontend controls.

## 8. Frontend/PWA Assessment

The public-page browser suite passed at 320, 375, 430, 768, 1024 and 1440 CSS pixels, covering routing, sticky navigation, footer/layout, carousel interactions and its fixture/error scenarios. APIs were mocked and service workers blocked for these browser checks. This is evidence for those public-page behaviors, not a full mobile accessibility or authenticated workflow certification.

Additional original-frontend Chromium probes reproduced:

- Two password dialogs from one click after visiting profile twice (**M04**).
- A failed logout request followed by a login screen, then restored authentication after reload against a still-active mocked session (**M02**).
- Private booking content rendered at `/login` after a delayed prior request completed (**M03**).
- Off-origin navigation from a crafted login `next` parameter (**M05**); the navigation was intercepted without contacting an external site.

The service worker explicitly skips `/api/` and non-GET requests (`public/sw.js:54`). Shells contain no account data; API responses are marked no-store. No sensitive API-response caching was observed in the inspected implementation. Nevertheless, the browser probes disabled service workers, so installation, cache upgrades, offline re-entry and logout across tabs still require device testing. `cache.put` in `networkFirst` is not awaited or attached to an event lifetime; cache completion on worker termination is a low-confidence offline reliability concern to verify, not a demonstrated privacy leak.

Accessible labels, focus handling, dialogs, loading/error states and mobile navigation were inspected, but no full screen-reader or WCAG conformance test was run. Duplicate dialogs materially undermine focus behavior. Validate keyboard-only authenticated workflows, reduced motion, text scaling, contrast and iOS/Android installed navigation after the lifecycle fixes.

## 9. Reliability and Concurrency Assessment

Fourteen targeted backend probes used bundled **unchanged application functions** and an in-memory SQLite adapter with transactional D1-style batches. The harness forced specific interleavings, injected failures, and mocked R2/email calls. These are deterministic code-path reproductions, not claims about actual Cloudflare scheduler timing or storage latency.

| Invariant probed | Observed result |
| --- | --- |
| One proof per successful transition | Same timestamp: one success/one conflict, but two proof rows; one points to a deleted object. |
| One approval event/notification per transition | Same timestamp: one success/one conflict, but two approval events and two outbox entries. |
| One debit per intended refund | Same partial refund recorded twice; two ledger rows and twice the balance deduction. |
| Closure affected set includes overlapping new booking | Forced intervening `createHold`: one closure, one live booking, zero disruption items. |
| One external send per queued email | Two overlapping flushes caused two mocked sends for one row. |
| Failed booking call does not leave an unreported reservation | Injected post-insert batch failure: request error, one booking, zero events. |
| Expiry effects survive an injected database failure | Artificial 50-SQL-statement cap: 12 expired holds, zero expiry events, next sweep processes zero. This is not Cloudflare quota emulation. |
| Staff name update cannot overwrite concurrent admin price | Price updated to 99999, then stale name-only update restored 50000 minor units. |
| Changed password excludes an old verified login | Password change 200; paused old-password login resumed with 200 and created a new session. |
| Screenshot sanitization always removes metadata | Malformed JPEG-like input retained original synthetic metadata bytes. Browser decodability not tested. |
| Invalid dates cannot be persisted | Impossible closure date stored; two equivalent-day booking strings both accepted. |
| Failed D1 proof write leaves no orphan | Injected failure after R2 put: one object, zero proof records. |
| Successful shared-IP logins do not exhaust small-facility budget | 30 successful attempts, then 429 on attempt 31. |

Cron runs every minute; lazy maintenance is throttled only within each isolate (`src/worker/lib/maintenance.ts:42`). It is not a distributed lock. Database transitions must remain safe if cron, lazy maintenance, administrative actions and retries overlap. Email requires both a durable claim and a provider-supported replay identity; a local process flag cannot establish exactly-once delivery.

## 10. Performance and 20–50 Concurrent User Assessment

### Measured locally

Only the public-calendar GET endpoint was load-probed, against the isolated emulator and small synthetic fixtures. After one warm-up request, three short bursts were run at each concurrency. No live service or write endpoint was load-tested.

| Simultaneous requests | Total requests | HTTP 200 | Network failures | p50 | p95 | Maximum |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 60 | 60 | 0 | 288.7 ms | 398.6 ms | 404.7 ms |
| 50 | 150 | 150 | 0 | 837.9 ms | 861.6 ms | 863.9 ms |

The three-round elapsed times were approximately 986 ms and 2478 ms respectively. These are host/emulator measurements, not production latency, a sustained throughput benchmark, or a 20–50-user acceptance test. They omit authentication, mixed activity, large history, uploads, real D1/R2 latency, isolate distribution and Cloudflare CPU/quota enforcement.

### Code-based estimates and bottlenecks

Player and console badge polling runs every 15 seconds. Several open screens also poll every 20 seconds (`public/js/player/shell.js:127`, `public/js/admin/shell.js:165`, player `screens/bookings.js:103` and `screens/book.js:391`). A continuously visible client with both loops generates **7 API requests/minute** before user actions. At 20 clients for eight hours, that is **67,200** requests; at 50 it is **168,000**. This is a workload estimate, not observed usage. Hidden-tab suspension, which screen is open, session length and actual occupancy change the result. Worker-invoking requests count toward the Free allowance; asset-only requests are different. See section 11 and M08.

Session reads, unread counts, availability computation and occasional lazy maintenance multiply D1 work behind those requests. The staff unread-chat query scans historical messages. Per-booking cron statement generation and disruption planning can consume invocation budgets even at modest concurrency. Repeated date/resource queries and correlated history lookups merit profiling on realistic data before any broad rewrite.

The dry-run Worker bundle was **515.19 KiB, 118.61 KiB gzip**. The `public` inventory contained 67 files totaling approximately 845 KB; individual JavaScript/CSS files were below 45 KB. This did not measure transferred bytes, compression, browser caching or Core Web Vitals. No Lighthouse claim is made.

Uploads buffer multipart data, input bytes and sanitized output. At 10 MiB per file, several simultaneous uploads in one isolate can create materially more memory pressure than the file limit suggests. Image processing and large result serialization may also exceed the small Free CPU budget. No CPU profile or worst-case upload test was run on Cloudflare; these remain runtime risks.

### Required capacity test before approval

Use a separate staging Worker/D1/R2 with synthetic accounts and intercepted or disabled outbound delivery. Seed realistic months of bookings/messages/events. Ramp through 20, 35 and 50 virtual users with realistic think time, then run a 30-minute soak. Include shared-NAT login bursts, calendar/list reads, contested booking writes, delayed responses/retries, proof uploads near the limit, verification, refunds, disruption apply and cron-boundary expiry. Avoid production and real recipients.

Record endpoint p50/p95/p99, errors/429s, CPU and memory failures, D1 query counts/rows read/written, queueing, R2 operations and daily-quota projections. Assert no conflicting active slots, negative/duplicated credit movement, duplicate transition effects, dangling proofs or duplicate delivered messages. Agree service targets before running; proposed initial targets are p95 below 1 second for ordinary reads and 2 seconds for ordinary writes, with separate upload targets. These are proposed acceptance criteria, not existing commitments or achieved results.

## 11. Cloudflare Free-Tier and Deployment Assessment

Official documentation was checked on the audit date. Account entitlements and usage were not inspected.

| Platform constraint | Relevance |
| --- | --- |
| Workers Free: 100,000 requests/day, 10 ms CPU for HTTP and cron, 128 MB memory per isolate | Polling estimate can exceed the request allowance; uploads and cron need measurement. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 Free: 50 queries per invocation, 500 MB per database, 5 GB account storage; 100 bound parameters per statement | Bound cron/disruption batches and large generated predicates. Individual D1 databases serialize queries, making query duration relevant to contention. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 Free: 5 million rows read/day, 100,000 rows written/day | Historical scans and index maintenance affect consumption; requests and rows are different meters. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| R2 Standard free allowance: 10 GB-month storage, 1 million Class A and 10 million Class B operations/month | Screenshot growth and orphan retention need a policy. Verify storage class and actual account billing. [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Static assets served without Worker execution are free; `run_worker_first` patterns invoke the Worker | `/api/*` and the exact/prefix routes for `/admin`, `/staff`, `/revenue` are configured this way. Free request exhaustion also affects matching console-shell requests. [Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |

The D1 limit above is the documentation's published invocation allowance; do not equate the audit harness's per-SQL-statement counter with actual metering. `batch()` sends multiple statements in one database call, and the Workers limits page separately describes internal-service subrequests. Verify effective accounting on the intended runtime rather than claiming that 12 expirations necessarily exhaust Free. [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [Workers subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)

The inspected `wrangler.jsonc` declares D1, R2, Assets, the Manila offset, deployed origin, compatibility date `2026-09-01`, per-minute cron and observability. Local dry-run bundling validates configuration shape and bindings in the bundle; it does not prove that deployed resources/secrets exist or that the account is on the intended plan.

No explicit staging environment is defined. Establish a separate deployment with separate D1/R2 resources and secrets before cloud testing. Verify `PASSWORD_PEPPER` and `FILE_SIGNING_SECRET` securely, without displaying values; verify optional mail configuration only with a controlled recipient. Confirm R2 has no unintended public development URL/custom domain. Check custom-domain HTTPS, exact `APP_ORIGIN`, security headers, CORS behavior, deployed migration history and cron execution. Observability is enabled, but useful alerts, retention, sensitive-field redaction and explicit tracing configuration are not established by that flag alone.

Production backups/restores were not exercised. D1 Free documentation lists seven-day Time Travel; this is not a substitute for a rehearsed restore and a migration rollback/recovery procedure. See I01/I02. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

## 12. Code Quality Assessment

The Hono route/library split, shared role helpers, structured API errors, escaped rendering utility and explicit credit ledger are good foundations. Problems worth addressing are tied to observed defects:

- Validation is inconsistent: public-calendar code validates actual dates, while the shared booking schema accepts only a date-shaped string (H01).
- `changedAt` centralizes an unsafe request-identity assumption across payment transitions (H02).
- The large booking/disruption modules combine planning, SQL generation, financial effects and notifications. Extracting a shared conditional-operation/transaction mechanism would reduce the demonstrated gaps, rather than merely shortening files.
- Frontend cleanup is opt-in and uneven. A route-owned mount, cancellation signal and disposal registry address M03/M04 directly.
- Manual generated bindings drift from runtime configuration; frontend JavaScript receives syntax checks but no comparable semantic type coverage (L03).
- Existing integration tests are broad but lack fixed-clock races, injected storage/network failures, retry identity checks and repeated-navigation lifecycle tests. Add these specific regressions instead of duplicating implementation with trivial unit tests.

No lint script or separate unit-test runner is declared. Browser testing currently depends on an external Playwright installation. README language implying images are fully decoded/rebuilt overstates the implemented chunk-level sanitizer; update that contract with the M10 fix. No wholesale framework replacement or style-only refactoring is recommended.

## 13. Tests and Commands Actually Executed

All state-changing checks used the scratch copy at `%TEMP%\le-spinners-audit-20261006`, with its own `.wrangler` state. The copy excluded the project's `.git`, `.wrangler`, real `.dev.vars` and `.env`; it used a junction to installed dependencies. Local example variables were used and outbound mail credentials were explicitly blanked. No deployment, remote migration, real user notification or production load test was performed.

Environment: Node **24.14.0**, npm **11.9.0**, Wrangler **4.143.1**, TypeScript **5.9.3**, Hono **4.13.11**, Zod **4.6.5**. Tools were inspected as installed; dependencies were not upgraded.

| Command/check | Actual result |
| --- | --- |
| `git status --short`, source inventory, targeted `rg`/file review | Baseline changes recorded; report is the only intended new project file. |
| `npm run typecheck` | Passed. |
| `npm ls --depth=0` | Dependencies resolved; extraneous installed packages noted, no cleanup performed. |
| `npm audit --json` | Zero reported vulnerabilities across severity categories. |
| `npx wrangler deploy --dry-run --outdir .wrangler/audit-build` in scratch | Passed; 515.19 KiB bundle / 118.61 KiB gzip. No deployment. |
| `npm run db:reset:local` in scratch only | Passed all eight migrations, facility/demo seeds and four local R2 demo images. This resets only disposable scratch state. |
| `node node_modules/wrangler/bin/wrangler.js dev --local --test-scheduled --port 8787 --ip 127.0.0.1 --show-interactive-dev-session=false` | Local smoke/browser server started successfully. |
| `BASE_URL=http://127.0.0.1:8787 npm run test:smoke` (PowerShell environment assignment) | **492 passed, 0 failed**. |
| `node tests/public-pages.mjs`, `BASE_URL=http://127.0.0.1:8787` | Passed all six viewport cases. Used existing `playwright-core` and local Chromium via `PLAYWRIGHT_MODULE`/`BROWSER_EXECUTABLE`; mocked API, blocked service worker. |
| `wrangler d1 migrations apply DB --local --persist-to .wrangler/landing-test-state` and `wrangler d1 execute DB --local --persist-to .wrangler/landing-test-state --file db/facility.sql` | Separate calendar database prepared successfully. |
| `wrangler dev --local --persist-to .wrangler/landing-test-state --port 8791 --inspector-port 9231` and `node tests/public-calendar.mjs` | Initial run hit connection reset; clean rerun passed **157 checks**. No claim that the transient failure never occurred. |
| `node audit-probes.mjs` in scratch | **14 targeted probes completed** with expected defect assertions. Uses unchanged application functions, in-memory SQLite, controlled interleavings and mocked R2/fetch. The rate-limit wrapper was corrected to preserve ApiError status; initial harness-only 500 was not an application finding. |
| `node audit-browser-probes.mjs` in scratch | **4 defect assertions reproduced** using original frontend modules and controlled browser responses. |
| `node audit-local-load.mjs` in scratch | 210 local calendar requests, all 200; metrics in section 10. |
| `wrangler d1 execute DB --local --command "PRAGMA foreign_key_check; PRAGMA integrity_check;"` | Emulator rejected unsupported integrity PRAGMA with `SQLITE_AUTH`. |
| `wrangler d1 execute DB --local --command "PRAGMA foreign_key_check;"` | Passed; empty violation result. |
| `node audit-static-checks.mjs` in scratch | 56 JS/MJS syntax checks, TS parsing and three manifest JSON parses passed; 104 text files inventoried. Read-only local SQLite integrity `ok`, zero FK violations; query plans captured; multi-hour classification defect reproduced. |

Scratch artifacts retained for review: `audit-probes.mjs`, `audit-browser-probes.mjs`, `audit-local-load.mjs`, `audit-static-checks.mjs`, and `.wrangler/audit-{smoke,browser,public-calendar,probes,browser-probes,load,static-checks}.log`. They are local audit artifacts, not committed regression tests or durable CI evidence. Probe inputs are synthetic; do not point the scripts at production. The date-alias probe uses dates relative to this audit's booking window and will need an equivalent future month-boundary fixture when reused later.

Not executed: production deploy/migrations, production load/attack tests, real email/SMS delivery, cloud CPU/memory profiling, live R2 public-access probing, backup restoration, Safari/Firefox/device installation tests, full accessibility conformance testing, Git-history secret scan, or a lint/unit command absent from `package.json`.

## 14. Findings Grouped by Severity

Priority definitions: **P0** = release blocker; **P1** = fix before production acceptance; **P2** = complete before growth or document an explicit operating constraint. Severity and priority are separate: a moderate defect can still block this release when it breaks a promised workflow.

### Critical

No Critical finding was demonstrated. This is a scope-limited audit result, not a guarantee of absence.

### High

#### H01 — Impossible dates bypass equivalent-day booking conflicts

**High · Confirmed · P0.** Locations: `src/worker/lib/validate.ts:42` (`zDate`); `src/worker/routes/bookings.ts:98`; `src/worker/lib/bookings.ts:409` (`checkSlots`) and insert conflict predicates around line 478; `src/worker/lib/time.ts:36`/`:51`/`:61`; `src/worker/lib/facility.ts:265`.

**Evidence/scenario:** `zDate` validates the string shape, while date arithmetic normalizes impossible dates. SQL clashes compare the original date strings. With the permitted 60-day booking window, the unchanged `createHold` accepted both `2026-11-31` and `2026-12-01` for the same player/resource/start; both normalize to the same day. The ordinary default window can encounter the same issue near an affected month end. `2027-02-30` was also stored as a closure date.

**Impact:** a signed-in player can create logically conflicting reservations and inconsistent availability/status/reporting records; operators can store ineffective or misleading closures. No elevated role is needed for the booking attack.

**Fix:** refine the shared date schema with strict calendar validity/canonical round-trip checking; apply it consistently to booking, closure, maintenance and disruption writes. Retain overlap checks and add database-level canonical-date protection where practical. Review existing invalid rows before adding constraints.

**Verify:** reject non-leap February 29, February 30, November 31, zero/out-of-range month/day and alternate encodings before writes; accept legitimate leap dates. Re-run equivalent-day conflict probes and Manila midnight/window boundaries. Assert no partial booking, slot or credit rows after rejection.

#### H02 — Timestamp guards allow duplicate transition side effects

**High · Confirmed · P0.** Locations: `src/worker/lib/bookings.ts:273` (`changedAt`); `src/worker/lib/payments.ts:57`, `:64`, `:70`, `:124`, `:136`, `:178`, `:223`.

**Evidence/scenario:** dependent inserts test whether a stored transition timestamp equals `now`, not whether this request changed the row. Two requests with the same millisecond can both satisfy the guard although only one UPDATE succeeds. Original-code proof probe: one success and one `HOLD_EXPIRED`, **two proof records, one R2 object, one dangling record**. Approval probe: one success and one `INVALID_STATUS`, but **two approved events and two outbox entries**. The loser detects `meta.changes` only after its batch effects committed.

**Impact:** duplicated payment history/notifications and broken evidence links. Other transitions sharing `changedAt` require the same correction; those additional exact races were not all separately reproduced.

**Fix:** introduce a unique operation/transition identity, conditionally established with the winning mutation and used by every dependent statement. Make losing operations create no side effects; optionally replay the stored result for a repeated idempotency key. Checking affected rows after a committed multi-statement batch alone is insufficient.

**Verify:** freeze the clock and synchronize two submissions/approvals/rejections/cancellations. Assert one winning transition, one event/message/notice set, valid object references, and zero losing effects. Include retries after lost responses and equal timestamps across separate isolates.

#### H03 — Disruption commit can omit an intervening booking

**High · Confirmed · P0.** Locations: `src/worker/lib/disruptions.ts:313` (`buildPlan`), `:787` (`applyDisruption`), `:804`, closure/item construction around `:835`/`:855` and batch at `:864`. Related affected-set read/write paths: `src/worker/lib/facility.ts:168`, `:265` and `setWeeklyHours`.

**Evidence/scenario:** the final affected-booking plan is read before its transaction. The probe inserted an actual overlapping `createHold` after that read and before the disruption batch. Apply succeeded with **one closure, one live TEMPORARY booking and zero disruption items**. The preview token did not detect a booking that appeared after final planning.

**Impact:** a customer retains a reservation in a closed period without the required cancellation/reschedule/credit workflow. Ordinary affected-booking confirmations may similarly become stale; that extension is code-based and needs its own regression.

**Fix:** make all schedule-changing and booking-writing paths participate in an atomic scope/version protocol, or construct/check the affected set within the same transaction as the schedule mutation. Reject/rebuild on a changed scope. A read immediately before a batch is still a race. Preserve the intended distinction between ordinary facility changes and explicit disruption resolution.

**Verify:** force booking insertion before planning, between planning and commit, and after closure commit. In each ordering, either the booking is rejected or the committed affected workflow includes it. Repeat for resource status and weekly hours, with credits and existing paid bookings.

#### H04 — Retried partial refund debits credit repeatedly

**High · Confirmed · P0.** Locations: `src/worker/routes/credits.ts:75`; `src/worker/lib/credits.ts:456` (`recordRefund`).

**Evidence/scenario:** each call generates a new ledger transaction ID; there is no required replay key or uniqueness constraint for the intended refund. Two identical 10000-minor-unit refund records against 50000 left **30000** and two refund ledger entries. Both calls were accepted. This differs from manual credit issue, which has an idempotency key.

**Impact:** a lost response/retry or double submission reduces the customer's remaining entitlement twice and misstates refund history. The app records an external cash/GCash refund; it does not itself transfer funds.

**Fix:** require a durable idempotency key scoped to the refund operation and actor/credit, store a request hash and result in the financial transaction, and return the original result on identical replay. Reject reuse with changed amount/method. Do not rely solely on optional payment references or a disabled button.

**Verify:** sequential replay, concurrent identical keys, response loss, changed payload with same key and two genuinely distinct refunds. Assert one debit/notice/audit entry for one intended operation and reconcile balances against the ledger.

### Medium

#### M01 — An old-password login can survive password-change revocation

**Medium · Confirmed · P1.** Locations: `src/worker/routes/auth.ts:140`, `:159`, `:205`; `src/worker/lib/auth.ts:41`.

**Evidence/scenario:** credential verification precedes unconditional session insertion. Pausing a valid old-password login just before INSERT, completing password change/revocation, then resuming login produced 200 for both operations and two sessions: the retained current session and the newly inserted old-credential session.

**Impact:** password change does not reliably terminate an already in-flight login using the previous credential. This is a narrow revocation race, not an unauthenticated account-takeover demonstration.

**Fix:** use a credential/auth version incremented atomically on changes; condition session creation on the version/hash verified and validate session version on access. Use compare-and-swap for concurrent password changes and apply equivalent rules to administrative resets.

**Verify:** pause/resume login across password reset, concurrent changes, disabled-account transitions and administrative credential reset; stale credential versions must not receive a usable session.

#### M02 — Logout network failure is presented as successful sign-out

**Medium · Confirmed · P1.** Locations: `public/js/player/screens/profile.js:95`; `public/js/player/app.js:60`; `public/js/admin/shell.js:174`.

**Evidence/scenario:** the frontend catches logout failure, clears its local user state and navigates to login. Chromium with a blocked logout request showed this behavior; reload restored the mocked still-active server session.

**Impact:** users on shared devices can reasonably believe their session was revoked when it remains usable. The browser cannot directly delete the HttpOnly cookie from application JavaScript.

**Fix:** clear private UI immediately, but distinguish pending/failed server revocation from confirmed logout and offer a reliable retry. Centralize logout handling, invalidate local route generations/caches and do not claim success until acknowledged.

**Verify:** offline, timeout, server 500, lost response after successful revocation, reload, back navigation and cross-tab behavior for every portal.

#### M03 — Late route responses overwrite the current login/private view

**Medium · Confirmed · P1.** Locations: `public/js/core/router.js:60`; `public/js/player/screens/pay.js:30`; asynchronous player screens using the persistent mount.

**Evidence/scenario:** the router checks navigation identity only after `await route.view(ctx)`, after the view can render. A delayed held-booking response was delivered after local logout/navigation. The browser stayed at `/login` while `#main` contained the private booking reference.

**Impact:** sensitive stale content appears after logout or on an unrelated route; stale redirects/actions can disrupt current workflows. The probe reused an already fetched/authorized response and does not establish cross-user API access.

**Fix:** provide route/auth-generation cancellation and a route-owned mount; check identity after each await before rendering, navigation or attaching polling. Abort requests where supported and still guard completed responses.

**Verify:** reverse response ordering across booking screens, logout/login as another synthetic user, slow polling, rapid back/forward navigation and aborted requests; stale views must perform no DOM/state changes.

#### M04 — Persistent-root listeners accumulate on repeat visits

**Medium · Confirmed · P1.** Locations: `public/js/player/screens/profile.js:91`; `public/js/player/shell.js:170`; `public/js/core/dom.js:81`; route cleanup in `public/js/core/router.js:43`.

**Evidence/scenario:** `on` returns an unsubscribe function, but profile binds delegated handlers to the persistent main element without returning cleanup. Profile → welcome → profile then one Change Password click opened two dialogs in Chromium. Similar persistent-root handlers should be audited, including payment actions; detached child-root handlers are not automatically affected.

**Impact:** duplicate modals/actions, confusing focus and possible repeated API mutations. Financial retries must still be protected server-side by H04's fix.

**Fix:** use route-scoped child mounts or listener AbortSignals, collect all disposers and return one cleanup function. Include dialog and polling disposal.

**Verify:** navigate into/out of each affected screen 20 times; one click must yield one dialog/request and no stale booking handler execution.

#### M05 — Backslash bypass in post-login return URL

**Medium · Confirmed · P1.** Locations: `public/js/player/screens/auth.js:8`; `public/js/core/router.js:85`.

**Evidence/scenario:** player `safeNext` rejects `//` but accepts slash-backslash host syntax. After mocked login, `?next=%2F%5Caudit-redirect.invalid` navigated to `http://audit-redirect.invalid`; the destination was intercepted without external traffic. URL parsing normalizes the backslash and the router permits off-origin navigation.

**Impact:** post-login phishing/trust abuse. Origin-scoped cookies are not thereby transferred to the destination; token theft was not demonstrated.

**Fix:** parse return targets against the current origin, require exact origin equality and an allowed local path, and reject ambiguous slash/backslash/control-character forms. Centralize return-target validation for all portals.

**Verify:** plain/encoded backslashes, protocol-relative URLs, credentials/ports, dot segments and legitimate deep links; no off-origin post-auth navigation.

#### M06 — Outbox flushes can deliver the same email twice

**Medium · Confirmed · P1.** Location: `src/worker/lib/notify.ts:78`.

**Evidence/scenario:** workers select queued rows without atomically claiming them, call the provider without a stable idempotency identity, and update by ID afterward. Two simultaneous original-function flushes caused two mocked sends for one queued row. A crash after successful send but before updating D1 has a similar replay ambiguity. Failure updates can also overwrite state from another attempt.

**Impact:** duplicate notifications, inconsistent delivery status, extra operations and confusion during booking/payment handling.

**Fix:** add durable claim/lease state, conditional completion updates, bounded timeouts/backoff and recovery of expired claims. Use the mail provider's supported idempotency mechanism with a stable outbox identity; a claim alone cannot eliminate send-success/commit-failure ambiguity. Verify provider retention semantics before implementation.

**Verify:** overlapping workers, provider timeout, successful delivery followed by DB failure, expired lease and retry exhaustion; assert a single provider-accepted logical delivery and truthful terminal status.

#### M07 — Booking/maintenance effects can be permanently lost after state commits

**Medium · Confirmed · P1.** Locations: `src/worker/lib/bookings.ts:619` (`createHold`), post-insert effects around `:663`/`:690`, console booking around `:727`, `sweepExpired:287`, `warnExpiringHolds:324`, `completePast:361`.

**Evidence/scenario:** creation commits before separate event/notice batches. Injecting failure into the effects batch produced an error with one persisted booking and zero events. Expiry/warning/completion likewise mark the state before follow-up effects; subsequent scans exclude already transitioned rows. The injected expiry failure described in M08 demonstrated unrepaired missing expiry events.

**Impact:** clients receive an ambiguous failure while a hold exists, and audit/chat/notification history can permanently miss real transitions. Credit-backed creation also needs explicit failure/retry analysis because a client cannot safely assume a failed response means no financial change.

**Fix:** commit core state and durable operation/event/outbox intents in the same bounded transaction; deliver derived effects from replayable records. Add creation operation keys and reconciliation keyed by transition identity. Do not simply retry creation with a new ID.

**Verify:** fault injection before/after every batch and response boundary, including credit-funded holds. Replaying the same operation must converge to one complete booking/ledger/event state without manual repair.

#### M08 — Unbounded maintenance work and polling threaten Free-tier availability

**Medium · Potential capacity risk; unbounded implementation Confirmed; cloud exhaustion Requires Runtime Verification · P1.** Locations: `src/worker/lib/bookings.ts:287`, `:324`, `:361`; `src/worker/lib/maintenance.ts:16`, `:43`; frontend polling locations in section 10; `wrangler.jsonc` cron.

**Evidence/scenario:** expiry builds four follow-up statements per expired booking in addition to initial queries/credit-return work, without a bounded batch of bookings. The harness imposed an artificial failure after 50 SQL statements; attempted statement 51 failed with 12 holds already EXPIRED, zero expiry events and nothing for the next sweep. This establishes M07's recovery defect under database failure, not a Cloudflare quota threshold: statements inside `batch()` must not be assumed to map one-for-one to metered calls. Separately, continuous 50-user badge-plus-screen polling estimates 168,000 API requests in eight hours.

**Impact:** failures precisely during clustered hold expirations, lost effects under M07, or daily API/console unavailability on Free. Lazy maintenance's per-isolate timer does not bound fleet-wide work.

**Fix:** process a bounded number of durable, claimed operations per invocation with checkpoints and headroom for all other queries/subrequests. Prefer set-based SQL where practical. Coalesce/adapt polling, stop hidden/idle work, avoid redundant badge reads and establish an explicit quota budget; select a paid plan if measured demand warrants it. A plan upgrade alone does not repair M07.

**Verify:** real staging batches of 1/10/12/50 expirations and disruptions near cron boundaries, on the intended plan; record query/CPU totals, retries and completeness. Run the section 10 soak and project daily usage.

#### M09 — Staff resource edit can overwrite a concurrent administrator price

**Medium · Confirmed · P1.** Location: `src/worker/lib/facility.ts:168`, particularly full-row UPDATE around `:206`.

**Evidence/scenario:** omitted fields are filled from a previous read and all columns are written. Injecting an administrator price change between read and a staff name-only update resulted in the staff update restoring the old price (50000 instead of 99999 minor units). Explicit staff price changes are correctly rejected; stale indirect writes bypass that intended separation.

**Impact:** silent pricing/configuration loss and potential mispriced new bookings under concurrent operations.

**Fix:** update only submitted authorized fields, ensure staff SQL never writes price columns, and use a version predicate for schedule-sensitive read/modify/write changes. Return a conflict instead of silently merging stale state where necessary.

**Verify:** synchronize staff rename/admin repricing, maintenance/status edits and two administrator edits. Assert no unsubmitted field changes and clear conflict/reload behavior.

#### M10 — Image metadata sanitizer fails open on malformed structures

**Medium · Confirmed · P1.** Locations: `src/worker/lib/images.ts:14`, `:27`, JPEG fallback around `:97`, WebP fallback around `:186`; consumers `src/worker/lib/payments.ts:46` and `routes/admin-settings.ts:157`.

**Evidence/scenario:** sniffing checks magic bytes; malformed parsing can return the original bytes. A synthetic JPEG-like input containing a private EXIF marker and invalid later segment retained the marker unchanged. Browser decodability of that malformed sample was not tested.

**Impact:** the promised metadata removal is not guaranteed; malformed data can be accepted as payment/QR image content. No XSS or browser decoder exploit was demonstrated.

**Fix:** fail closed on malformed structure and test every fallback; if using a real decoder/re-encoder, enforce dimensions/pixel limits and evaluate Worker CPU/memory or an appropriate image-processing service. Align README guarantees with actual behavior.

**Verify:** valid EXIF/XMP/IPTC samples, malformed chunk lengths, truncated images, trailing data, orientation/ICC preservation and oversized dimensions; rejected inputs must create no stored object or proof row.

#### M11 — R2 upload survives failed database commit without cleanup

**Medium · Confirmed · P1.** Locations: `src/worker/lib/payments.ts:52` and `:124`; analogous QR replacement sequence `src/worker/routes/admin-settings.ts:157`.

**Evidence/scenario:** R2 put precedes the D1 transaction. Cleanup exists for a zero-row transition but not for a thrown batch failure. Injecting D1 failure after successful put left one object and zero proof records. No general orphan reconciliation/retention process was found. The QR path has a similar code-level risk, not a separate executed fault test.

**Impact:** unreferenced sensitive screenshots remain stored and consume storage; retries can multiply them. This is distinct from H02's database row pointing to a deleted object.

**Fix:** define a staged-upload lifecycle with durable ownership/state, cleanup on confirmed failure and a delayed orphan reconciler. Account for ambiguous commit outcomes before deleting: recheck references or use operation state so successful proofs are not removed after a lost response.

**Verify:** R2 put failure, D1 failure, ambiguous commit response, cleanup deletion failure and client retry. After reconciliation, every retained object has a valid record or deliberate retention reason, and every proof reference resolves.

#### M12 — Multi-hour bookings move to past after one hour

**Medium · Confirmed · P1.** Locations: `public/js/player/screens/bookings.js:10`/`:17`; `public/js/player/screens/home.js:60`.

**Evidence/scenario:** the frontend tests `startsAt + 3_600_000 > now`. Executing the original split function for a confirmed 120-minute booking after 90 minutes classified it as past (past=1, upcoming=0). The home summary uses the same one-hour assumption.

**Impact:** an ongoing paid reservation disappears from the active presentation, misleading customers during multi-hour or gapped bookings. Server completion uses the booking's end and is not shown to share this exact defect.

**Fix:** expose/use authoritative `endsAt` or derive it from the last valid segment using facility time. Define how unresolved payment states remain actionable independently of display grouping.

**Verify:** short, one-hour, multi-hour, gapped and near-midnight bookings at start/end boundaries, with server/client clock differences and all payment states.

#### M13 — Shared-IP throttle blocks legitimate successful sign-ins

**Medium · Confirmed · P1 for the requested 20–50-user scenario.** Location: `src/worker/routes/auth.ts:134` and successful-login cleanup at `:160`.

**Evidence/scenario:** all attempts increment the 30-per-15-minute IP bucket; success clears only the email bucket. A local original-router test of one valid synthetic account from one IP yielded 30 successful logins, then 429. Multiple valid accounts sharing the same IP consume the same bucket; an actual 50-account facility arrival was not run.

**Impact:** a group arriving on facility Wi-Fi can be denied login despite correct credentials. Distributed attacker behavior and actual NAT topology were not measured.

**Fix:** tune a documented shared-IP burst allowance, distinguish unsuccessful attempts from ordinary successful traffic, and retain account-level and aggregate abuse protection. Consider adaptive challenges for suspicious traffic rather than removing IP limits.

**Verify:** 50 legitimate accounts sharing one IP, repeated bad passwords against one/many accounts, mixed success/failure, IPv6/proxy handling and recovery after the rate window.

### Low

#### L01 — Historical scans and retained records increase polling cost

**Low · Potential production bottleneck; query plans Confirmed · P2.** Locations: `src/worker/lib/chat.ts:190`; `src/worker/routes/admin.ts:172`; `src/worker/lib/maintenance.ts:59`; indexes in `migrations/0001_init.sql`.

**Evidence/impact:** staff unread chat counting scans the message index; unread notifications filter a broad audience partition; housekeeping scans rate limits by window. Polling repeats these operations as history grows. No production slowdown was demonstrated. Notifications/events/outbox/screenshots lack a complete documented retention strategy, and unconfigured SMS remains queued by design.

**Fix:** benchmark partial/composite indexes for unread access paths and `rate_limits(window_start)`, or maintained unread summaries if measured history volume justifies them. Define bounded retention/archive rules and monitor rows read/written/storage; account for extra index-write cost.

**Verify:** realistic six/twelve-month fixtures, query plans and D1 row metrics before/after; preserve exact unread counts and audit/financial history.

#### L02 — Fixed history limits lack a complete older-record navigation path

**Low · Confirmed implementation limitation · P2.** Locations: `src/worker/routes/bookings.ts:80`; `src/worker/lib/credits.ts:149`, `:166`; `src/worker/lib/chat.ts:41`, `:231`; notification list handlers.

**Evidence/impact:** own bookings and credit searches cap at 200; chat/conversation/notification routes also use fixed caps. Clients lack a general cursor flow to retrieve all older records. Data is not proven deleted, but customers/operators may be unable to reach it through normal lists as history grows.

**Fix:** introduce stable keyset pagination with explicit `hasMore`/cursor metadata and UI retrieval, including deterministic ordering for equal timestamps. Keep bounded page sizes.

**Verify:** more than each cap, equal timestamps, concurrent new entries and filters; no skipped/duplicated records and complete authorized history access.

#### L03 — Reproducible test setup and generated bindings have drifted

**Low · Confirmed · P2.** Locations: `package.json`, `worker-configuration.d.ts`, `src/worker/types.ts`, `tests/public-pages.mjs:7`, README upload description.

**Evidence/impact:** browser tests import Playwright without a project-declared installation; this audit used an existing external installation. Generated environment types omit the current pepper contract and retain older origin typing. There is no declared lint/unit runner. This weakens clean-checkout validation and can obscure deployment mistakes; it does not negate the successful current typecheck.

**Fix:** document/pin a reproducible browser-test toolchain and commands; regenerate bindings from the intended config and align handwritten types. Add the concrete race/failure/browser regressions from this report to CI. Correct image-processing documentation with M10. Add lint rules only where they enforce useful properties, not as a cosmetic rewrite.

**Verify:** fresh isolated checkout/install, generated-type diff review, typecheck/bundle and all suites without an unrelated workspace dependency.

### Informational

#### I01 — Credential migration requires a populated-database upgrade check

**Informational · Requires Runtime Verification · P1 deployment gate.** Location: `migrations/0002_client_password_hmac.sql:14`.

**Evidence/scenario/impact:** this historical migration clears stored password credentials and sessions, with a comment assuming there are no production users yet. Fresh installation passed. Applying it for the first time to a populated older database can lock out existing accounts; whether any deployed database is in that state is unknown.

**Action:** inspect migration history and affected account counts without exposing credentials, prepare backup/recovery and a verified reset/reprovisioning route, and test the upgrade on a copy before scheduling it. Do not blindly rerun or rewrite already-applied migrations.

**Verify:** representative pre-0002 populated copy, post-upgrade access/recovery and a rehearsed restore.

#### I02 — Deployed bindings, private storage and operational controls are unverified

**Informational · Requires Runtime Verification · P1 deployment gate.** Locations: `wrangler.jsonc`, `.dev.vars.example`, `src/worker/index.ts:166`, `src/worker/lib/auth.ts:22`, `src/worker/lib/notify.ts:78`.

**Evidence/impact:** repository configuration and dry-run success cannot prove live resource identity, secret presence, R2 privacy, mail sender approval, cron execution, observability usefulness or restore readiness. No explicit staging environment is configured. A mistake here can make authentication unavailable, expose objects through bucket-level access, or silently prevent delivery; none of those live conditions was asserted as present.

**Action:** complete section 17 against a separate staging deployment first, then verify the approved production configuration through read-only checks and controlled rollout procedures. Keep secret values redacted.

**Verify:** record resource/environment mapping, controlled health/auth/proof/cron/delivery results and recovery evidence without including credentials or user data.

#### I03 — Membership, console ownership and revenue definitions need acceptance

**Informational · Requires business/runtime verification · P2, or P1 if these features are launch commitments.** Locations: `src/worker/lib/bookings.ts` pricing/console booking logic; `src/worker/types.ts` membership fields; `src/worker/routes/revenue.ts`; `REBOOKING.md` and smoke owner-overlap assertions.

**Evidence/impact:** pricing follows membership state; `member_until` is not a consistently enforced automatic expiry workflow. Console bookings belong to the staff account, so owner-overlap rules can reject bookings for different named customers made by that account. Revenue is a defined booking-status view, not automatically a reconciled cash/refund/liability ledger. These may be intentional product rules rather than defects.

**Action:** obtain explicit accepted rules for membership renewal/expiry, desk bookings for multiple customers and cancellation/credit/refund accounting. Implement only the agreed gaps and label reports so users do not confuse booked revenue with cash retained or refund liabilities.

**Verify:** expired member, two named desk customers on simultaneous resources, cancelled paid booking with retained credit, credit-funded replacement and recorded refund; reconcile expected reports with the agreed policy.

## 15. Proposed Fixes for Each Finding

Section 14 supplies the technical fix and a verification test for every finding. This implementation map groups related work without treating them as already resolved:

| Work package | Findings | Concrete deliverable |
| --- | --- | --- |
| Canonical booking inputs | H01 | Shared real-date schema, write-boundary enforcement, invalid-data review and month-boundary tests. |
| Transaction and replay correctness | H02, H04, M07 | Unique conditional operation records, refund/creation idempotency, atomic durable side-effect intents and retry tests. |
| Scheduling concurrency | H03, M09 | Atomic affected-scope validation, field-scoped authorized updates and conflict/re-preview behavior. |
| Session/UI lifecycle | M01–M05, M12 | Credential versioning, truthful logout, cancelled stale views, disposed listeners, origin-safe return targets and authoritative booking end times. |
| Delivery/storage recovery | M06, M10, M11 | Claimed replay-safe outbox, fail-closed image validation, staged uploads and safe reconciliation. |
| Capacity and usability | M08, M13, L01, L02 | Bounded maintenance, polling/request budget, shared-NAT login tuning, measured indexes and keyset pagination. |
| Release process and rules | L03, I01–I03 | Reproducible checks/types, upgrade/restore evidence, environment verification and accepted business semantics. |

Changes to financially relevant constraints should include reconciliation queries and a reviewed data migration. Do not silently delete duplicate proof/refund history or infer intended cash movements from duplicate timestamps alone; investigate and preserve an audit trail.

## 16. Prioritized Remediation Plan

1. **P0 — Restore booking/financial invariants:** fix H01–H04 first. Add deterministic fixed-clock, interleaving and replay tests before changing behavior. Review any existing data for invalid dates, duplicate transition effects, unresolved closed-period bookings and suspected duplicate refunds.
2. **P1 — Make failures recoverable:** implement M07/M08 transaction intents and bounded maintenance, M06 delivery claims and M11 upload reconciliation. Correct M09 concurrent field updates and M10 sanitization. Validate on synthetic storage failures.
3. **P1 — Close authentication and UI gaps:** implement M01–M05, M12 and M13. Repeat browser navigation/error tests and shared-NAT sign-in tests alongside the full existing smoke suite.
4. **P1 — Establish deployment evidence:** complete I01/I02, regenerate types, exercise controlled staging on the intended plan, and perform the mixed-workload soak in section 10. Confirm the business rules needed for launch under I03.
5. **P2 — Prepare for history growth:** implement measured L01/L02 improvements and complete L03 clean-checkout automation. Document retention, quota monitoring, operational ownership and recovery procedures.

Completion means the defect regression fails on the audited version and passes on the fix, the existing suites remain green, and relevant staging observations meet agreed limits. A clean build or selecting a paid plan is not a substitute for those checks.

## 17. Items Requiring Manual or Production-Environment Verification

Perform staging checks first. Production verification should be read-only or follow the normal approved release procedure; this audit did not authorize destructive production testing.

| Verification item | Required evidence |
| --- | --- |
| Environment separation | Separate staging Worker/D1/R2 and mail configuration; production resource mapping reviewed. |
| Secrets | Presence/rotation procedure for pepper and signing secret, no example values, no disclosure in logs or output. Understand that pepper replacement affects credential verification. |
| R2 privacy and lifecycle | Public URLs/custom domains disabled unless deliberately approved; signed authenticated proof access works; reconciliation/retention verified. |
| Deployed origin/headers/cookies | HTTPS, correct origin, CSP/no-store/nosniff behavior for API/proofs and each shell; no unintended credentialed CORS. |
| Migration and recovery | Applied migration list, pre-upgrade assessment for I01, backup/Time Travel availability, tested restore and account recovery. |
| Scheduling | Actual per-minute trigger, overlapping invocations, delayed ticks and bounded catch-up; durable events reconcile with statuses/credits. |
| Notifications | Controlled recipient/sender test, replay-safe delivery, failed queue visibility and explicit SMS support expectations. |
| Performance/quotas | Mixed 20/35/50-user staging test, realistic history/uploads, CPU/query/row/storage metrics and daily allowance projection. |
| Browser/PWA | Android/iOS installation, service-worker upgrade, offline/reconnect, cross-tab logout, deep links, back/forward and session expiry. |
| Accessibility | Keyboard/screen-reader booking/payment/console workflows, dialog focus, text scaling and error announcements. |
| Business acceptance | Membership expiry, desk-booking ownership and cash/credit/refund/revenue reconciliation rules. |
| Incident operations | Request-ID tracing, useful alerts for cron/outbox/quota failures, restricted/redacted logs and a recovery owner/runbook. |

## 18. Final Deployment Recommendation

**Not Ready for production release.** The current working tree is suitable for continued isolated development and controlled staging, but reproduced booking, payment, closure and refund integrity defects are release blockers.

Reassess after H01–H04 are fixed, P1 failure/authentication/frontend issues have regression coverage, and deployment/recovery plus realistic capacity checks are documented. Existing passing suites are a strong baseline to preserve; they do not supersede the reproduced failures or establish production readiness for 20–50 concurrent users.
