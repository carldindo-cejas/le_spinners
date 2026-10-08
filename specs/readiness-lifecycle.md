# Route and authentication lifecycle — M03 / M04

Implemented locally on 2026-10-07. M03/M04 are **In review**. Independent portal review, the full screen/action sweep, actual devices and the service-worker upgrade rehearsal remain open. Cross-tab logout now has local M02 evidence in [readiness-logout.md](readiness-logout.md); real device/runtime review remains open. This change requires no database migration; the existing Worker candidate still requires migrations through 0015.

## Ownership contract

The router creates a scope before invoking a view. A scope owns an AbortSignal and idempotent disposers. Navigation, refresh, invalidation and view errors dispose it immediately, even if the initial view request has not returned. A cleanup returned after cancellation is disposed immediately. Expected cancellation does not become a user-visible network error or an unhandled rejection.

Each shell creates a separate `.route-mount` under its stable main element. Its `display: contents` preserves existing layout. A departed view retains references only to its detached mount. Delegated and direct element listeners inherit the mount or dialog lifetime. Persistent topbar/global view listeners, timers, countdowns, badge subscriptions, polls and public-page observers are registered with route ownership. The router's application click/popstate listeners and application connection/install listeners have an explicit application lifetime.

`createViewTools` captures the owner before a view/helper's first asynchronous boundary. It binds API calls to that owner and fences rendering, navigation, delayed callbacks and new subscriptions. Clipboard and badge-refresh continuations check ownership after completion. JSON requests check ownership before fetching, after headers, and after body parsing; cancellation is still enforced when an implementation ignores its signal or parsing has already started. XHR uploads abort and suppress late progress/401 effects. CSV exports check ownership after reading each part and before downloading; export and proof-preview blob URLs are released on disposal.

Dialogs have child scopes. Closing a profile dialog cancels its pending save or password work; closing or leaving a dialog/viewer removes listeners, releases its scroll lock and prevents restoration of focus into a departed screen. Lock counting preserves another open dialog's scroll lock. Profile refreshes use the router rather than recursively attaching handlers to the same live view.

## Authentication contract and boundaries

Changing the local user's ID or role advances an authentication generation, immediately disposes the old route and its child dialogs, and aborts earlier API work, including badge requests. Confirmed sign-in/logout deliberately hands off to a fresh route after that disposal. Profile edits for the same identity retain that generation. Badge polling belongs to the application and explicitly uses `scope: null`; it survives route changes but cannot update a newer identity. An old badge task cannot clear a newer in-flight task or invalidate the new session through a late 401. Identity changes clear identity-specific badges and console settings/alerts.

Session expiry immediately removes private content and routes to sign-in before opening its explanation dialog. An old private request cannot subsequently restore its view or attach polling. This batch also fences existing logout continuations against departed routes. At the E06 snapshot, M02 remained pending. The subsequent [M02 implementation](readiness-logout.md) now supplies locally verified truthful status, retry, reload and cross-tab coordination; independent device/runtime review remains pending. Return-target validation remains M05.

Cancellation prevents further client effects. It does **not** undo a server mutation or remove an HttpOnly cookie set by an already committed login response. Booking/refund/disruption replay identities must remain recoverable after ambiguous responses. Browser PBKDF2 cannot be interrupted once started; its result is discarded after cancellation. M02 and staging recovery checks must account for these boundaries.

## Maintained verification

- `tests/readiness-lifecycle.mjs`: **17 tests** for initial-load disposal, late cleanup, nested scopes, ignored fetch cancellation, interrupted parsing, old-session 401, caller cancellation, identity/role changes, background badges, listener/timer/poll disposal, asynchronous helper completion, canceled upload progress and cleanup failures.
- `tests/lifecycle-browser.mjs`: **19 actual-browser scenarios** using real player/admin/staff modules with intercepted synthetic APIs. Four maintained pre-fix probes fail on the preserved baseline: late private booking rendering, 21 player password dialogs after repeated visits, and console dialogs surviving navigation. All four pass on the candidate.
- Candidate browser checks additionally cover successful sign-in/logout handoffs in all three portals; rapid back/forward with reversed responses; cleanup after a route exception; old-user 401 after switching synthetic identities in each portal; manually closing pending profile saves in each portal; twenty held/payment visits followed by one release request and cancellation; repeated admin/staff proof viewers and simultaneous scroll locks; and a delayed CSV response after navigation. Unhandled exceptions and application console errors fail the scenarios.
- Integrated `npm run test:readiness`: **181 passed, 0 failed** (164 existing plus 17 lifecycle tests). Worker typecheck passes. Existing refund retry, outbox settings and public responsive-page browser checks pass; public checks cover 320/375/430/768/1024/1440 px. All 52 application JS modules and four lifecycle/service-worker scripts pass syntax checks.

The browser fixture server is read-only, binds localhost, serves the real static shells and never starts the Worker or accesses D1/R2. APIs are intercepted and service workers are blocked in these synthetic tests. This is not intended-runtime, PWA, server-revocation or capacity evidence.

Run from a checkout with Node 24 and an available Playwright/Chromium installation:

```powershell
npm run test:readiness
npm run typecheck
# Terminal 1 — read-only fixture server, default localhost:8799
node tests/helpers/browser-server.mjs
# Terminal 2 — default localhost:8799
npm run test:lifecycle-ui
```

`PLAYWRIGHT_MODULE` can select an existing package (use a `file:///C:/.../index.mjs` URL on Windows); `BROWSER_EXECUTABLE` can select its Chromium. Browser pinning/installation and CI remain L03. No browser dependency was added by this batch.

For the four original probes only, use `BASELINE_ONLY=1`. `SYSTEM_BROWSER_ROOT` selects a preserved source root, `PORT` selects the fixture port, and `BASE_URL` selects the browser target. Do not point these synthetic fixtures at a live environment.

Local evidence is retained under ignored `.wrangler/`: the 177-file pre-lifecycle snapshot and manifest (`readiness-lifecycle-baseline-20261007*`), baseline/candidate browser logs, integrated suite log and final `readiness-lifecycle-candidate-manifest.json`. The candidate manifest hashes application files, config, migrations, maintained tests and documentation without secrets, database contents or proof objects. The baseline includes previous readiness fixes and existing user changes; it is not merely the original commit checkout.

## Remaining closure work

Assign an independent reviewer and staging operator. Sweep every affected screen/action twenty times on the candidate across all portals, including successful and failed authentication, uploads, chat, schedule/disruption/credit dialogs and polling; verify one action per click and no departed handler, dialog, focus trap or poll. Review all async continuation/shared-state boundaries against this contract.

Review the locally implemented M02 logout failures/retry/cross-tab behavior and [M05 return-target validation](readiness-redirect.md), then complete G08/G09 device, keyboard/screen-reader, offline/reconnect and service-worker upgrade tests. M05 is locally verified and In review. The service-worker cache version was advanced for the changed modules; installation and upgrade were not verified here. Existing data/staging/release gates and **production NOT READY** remain unchanged.
