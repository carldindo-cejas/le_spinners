# Truthful, retryable logout — M02

Implemented locally on 2026-10-07. M02 is **In review**; independent review and intended-device/runtime verification remain open. This batch changes the browser only, adds no migration, and performs no deployment or remote data operation. The existing Worker candidate still requires migrations through 0015. Production remains **NOT READY**.

## Logout contract

All player, staff and admin logout actions use one shared manager. Starting logout immediately clears the local identity, private route and dialogs, badge polling, console state, private chrome, toasts, live announcements and the temporary rebooking selection. Authentication generations invalidate earlier requests and pending sign-in continuations. Actor-scoped booking creation replay records remain available so an ambiguous financial operation can be recovered without submitting a new intent.

The manager records a non-sensitive attempt ID and one of three states: `pending`, `failed` or `confirmed`. Pending/failed states show a retry screen and block private routes and sign-in, including reload and history navigation. They explicitly say that the server session may still be active. Only a successful response containing `ok: true` displays confirmation that this browser has signed out. The existing endpoint deletes the current session before clearing its HttpOnly cookie; logout of an absent/already-revoked session is idempotent. This does not sign out other devices.

One ten-second budget covers waiting for the authentication lock, the request and response parsing. Timeout releases the client operation even if an adapter ignores cancellation. Network failure, server error, malformed acknowledgement or a response lost after successful revocation remains unconfirmed and retryable. Concurrent clicks coalesce; retries preserve the attempt ID. Late results cannot downgrade a confirmed attempt or overwrite a newer intent. Reconnection retries an unresolved logout automatically.

Confirmed intent remains across reload, preventing automatic cookie-based restoration. An explicit successful login or registration acknowledges that exact confirmed attempt through a separate storage key. It validates the user response and rechecks cancellation/current intent before handoff. Failed or malformed sign-in does not retire the barrier. A new logout cannot be erased by an earlier sign-in acknowledgement.

## Tabs and storage boundaries

The primary browser profile uses origin-shared localStorage, storage events and BroadcastChannel for intent propagation, plus an origin-wide Web Lock to serialize logout/login mutations. Lock ownership lasts until the callback promise settles; see the [Web Locks specification](https://www.w3.org/TR/web-locks/). The manager also checks intent before and after authentication to reject stale results. Visibility/pageshow reconciliation clears a restored private page when it observes an outstanding intent.

With Web Locks unavailable, a queue serializes authentication in the current tab and intent checks still apply; cross-tab network serialization is not guaranteed. If localStorage is unavailable, sessionStorage preserves the barrier on that tab's reload and BroadcastChannel coordinates already-open tabs. It cannot guarantee propagation to newly opened tabs after the originating tab closes. The retry screen explains that status is saved only in the current tab and asks the user to finish before closing it or opening another tab. If both storage mechanisms fail, the current page keeps a memory barrier and warns the user to keep it open and retry. Reload persistence is unavailable in that profile. Supported-browser and storage-fallback policy requires independent acceptance.

Cancellation prevents client effects; it cannot undo a committed server mutation or erase a cookie from an already committed authentication response. Real cookie ordering, browser shutdown, BFCache/PWA restore and service-worker upgrade behavior require the remaining device/runtime checks.

## Maintained local evidence

- `tests/readiness-logout.mjs`: **22 deterministic tests** cover coalescing, immediate notification, timeout including ignored cancellation/lock wait, network/500/401/malformed/lost responses, persistent barriers, explicit login acknowledgement, stale-login/new-logout races, late confirmations/failures, Web Lock ordering, the same-tab fallback queue, storage failures, message ordering and non-sensitive record projection.
- `tests/logout-browser.mjs`: **26 real-module browser scenarios** across player, admin and staff. They check immediate private DOM/chrome/toast/live-region removal, offline failure, reload/back, successful retry and cookie clearing, explicit fresh login, 500/malformed/lost responses, actual browser offline/reconnect, real ten-second timeouts, concurrent cross-tab retries, and denied-storage profiles. The three original immediate-hide probes fail on the preserved pre-M02 baseline and pass on the candidate.
- Existing lifecycle browser scenarios: **19 passed**. Integrated readiness: **203 passed, zero failed**. Existing refund retry, outbox settings and six public-page viewport checks pass. Worker typecheck and syntax checks for all 54 application modules plus six service-worker/lifecycle/logout helper and test scripts pass.

These browser tests serve the actual static modules with intercepted synthetic APIs and synthetic HttpOnly cookies. The read-only fixture server binds localhost; service workers are blocked. They do not execute logout against D1/workerd, establish production revocation or prove PWA/device support. Prior Worker smoke/runtime evidence remains in E01–E05; it was not rerun for this browser-only batch.

Run with Node 24 and an available Playwright/Chromium installation:

```powershell
npm run test:readiness
npm run typecheck
# Terminal 1: read-only fixture server on localhost:8799
node tests/helpers/browser-server.mjs
# Terminal 2
npm run test:logout-ui
npm run test:lifecycle-ui
```

`PLAYWRIGHT_MODULE` can select an existing package (a `file:///C:/.../index.mjs` URL on Windows); `BROWSER_EXECUTABLE` selects Chromium. Browser pinning and clean-checkout CI remain L03. `BASE_URL` selects a localhost fixture; `BASELINE_ONLY=1` runs the three pre-fix probes. `SYSTEM_BROWSER_ROOT` and `PORT` select a preserved source tree and fixture port. Synthetic fixtures must not target live environments.

Ignored `.wrangler/` evidence retains the 183-file pre-M02 snapshot and hash manifest (`readiness-logout-baseline-20261007*`), baseline/candidate browser and integrated logs, and the 188-file `readiness-logout-candidate-manifest.json`. Snapshots include earlier readiness fixes and pre-existing user changes. Manifests exclude secrets, databases and customer objects. The preserved baseline has zero hash drift.

## Remaining closure work

Assign an independent reviewer/operator. Review all portal logout entry points, pending login/register ordering and fallback support policy. Verify real API session deletion/cookie ordering, overlapping authentication in separate tabs, reconnect, browser shutdown/restore, BFCache and actual mobile browsers. Rehearse the service-worker cache upgrade and accessibility under G08/G09. Existing staging/data/release gates remain open. Subsequent [M05 login return-target validation](readiness-redirect.md) is locally verified and In review; next local implementation is **M12 authoritative booking end times**, followed by M13.
