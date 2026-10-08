# Validated login return targets — M05

Owner: Codex. Implemented and locally verified on the target date, 2026-10-07, Asia/Manila. Independent reviewer and staging operator remain unassigned. M05 is **In review**; production remains **NOT READY**.

## Return-target contract

Player login and registration, staff login and admin login share one parser. Targets must be root-relative paths or absolute HTTP(S) URLs whose parsed origin exactly matches the current origin. Credentials, protocol-relative URLs, backslashes, raw whitespace/control characters and encoded backslashes/control characters (including nested encoding) are rejected. Path separators hidden by encoding, double-encoded path characters, duplicate slashes and dot segments are rejected before URL normalization. Query strings and fragments on valid routes are retained.

Post-login paths must match a known route in the authenticated portal. Player targets exclude login, registration, console, revenue, API and asset routes. Console targets stay within the matching console; settings and `/revenue/` belong to admin only. Invalid or missing targets fall back to `/`, `/staff/` or `/admin/` as appropriate.

Shared router navigation uses the same parser, requires a local path owned by its router, and falls back to the router's home. Intentional external links retain normal browser navigation through anchors; programmatic router navigation does not hand an untrusted target to `location.href`. Login guards and session-expiry return paths retain search and fragment components so legitimate deep links survive reauthentication.

No Worker/schema change or deployment is required. Service-worker cache version advances for the changed browser modules; actual PWA upgrade verification remains G08.

## Maintained local evidence

- `tests/readiness-redirect.mjs`: **10 deterministic tests** cover raw/nested encoded backslashes and controls, protocol-relative/external URLs, credentials, exact-origin/default/different ports and IPv6, dot segments, encoded separators, malformed path encodings, known routes, portal boundaries and authentication loops. Router tests cover all portal homes and preserve valid queries/fragments.
- `tests/redirect-browser.mjs`: **27 scenarios** exercise actual player/admin/staff browser modules with synthetic APIs. They verify login and registration returns, already-authenticated handoffs, malicious input matrices, same-origin absolute links, valid query/fragment preservation, registration/login switching, guarded deep links, session-expiry return links, router defense and the admin revenue route. All external requests are intercepted, with only navigation requests classified as redirects; no request to a malicious host reaches the network.
- Three maintained probes—player login, registration and direct router navigation—fail on **both** the original audited `808863f` plus working-tree snapshot and the pre-M05 tree. Both navigate to the intercepted `audit-redirect.invalid` destination. All three pass on the candidate.
- Integrated readiness: **213 passed, zero failed**. Existing browser suites: **19 lifecycle**, **26 logout**, refund retry, outbox and public-page checks at **320/375/430/768/1024/1440 px** pass. Worker typecheck and **58 JavaScript syntax checks** pass. This batch changes no Worker source/schema; existing runtime evidence remains E01–E05.

Initial verification attempts exposed two harness issues: the installed Playwright expected a browser revision unavailable locally, resolved by selecting the existing Chromium executable; and the redirect test counted intercepted font stylesheets as navigation, producing 20 false scenario failures. The final harness fulfills external stylesheets separately and counts only navigation requests. The final 27-scenario run passes; these were test setup/classification failures.

The fixture server binds localhost and serves real static shells/modules. APIs are intercepted and service workers blocked. These checks do not establish D1/workerd authentication, actual PWA upgrades, device support or deployed origin configuration.

Run with Node 24 and an available Playwright/Chromium installation:

```powershell
npm run test:readiness
npm run typecheck
# Terminal 1: read-only localhost fixture server
node tests/helpers/browser-server.mjs
# Terminal 2
npm run test:redirect-ui
npm run test:lifecycle-ui
npm run test:logout-ui
```

`PLAYWRIGHT_MODULE` selects an existing package (`file:///C:/.../index.mjs` on Windows); `BROWSER_EXECUTABLE` selects its Chromium executable. `BASE_URL` must identify a localhost fixture. `BASELINE_ONLY=1` runs the three pre-fix probes; `SYSTEM_BROWSER_ROOT` and `PORT` select a preserved source tree and server port. Pinning/installing browser tooling for a clean checkout remains L03.

Ignored `.wrangler/` evidence retains the 180-file `readiness-redirect-baseline-20261007` snapshot and manifest, `readiness-redirect-{baseline,audit}-browser.log`, candidate browser/integrated/existing-suite logs and `readiness-redirect-candidate-manifest.json`. Manifests exclude secrets, databases and customer objects. The original audited and pre-M05 baseline hashes have zero drift. Candidate hashes identify application/config/migration/test/documentation sources for review.

## Remaining closure work

Assign an independent reviewer/operator. Review the route allowlists whenever routes change, and validate real browser/device/PWA upgrade, deep-link/login/back behavior and deployed exact-origin configuration under G04/G08. Required staging/release gates remain open. Next local implementation: **M12 authoritative booking end times**, followed by **M13 shared-IP login capacity**.
