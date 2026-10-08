# Facility Maps location and responsive calendar

Implemented the follow-up request directly in the existing admin/staff console and player app.

## Changes

- **Admin Settings → Facility info:** added an optional Maps location link. The API validates full HTTPS URLs, rejects credentials, control characters and malformed links, and persists the trimmed value in the existing settings table. Saving, editing and clearing use the existing settings save and audit flow.
- **Directions:** public Visit Us and signed-in player Directions use the configured map pin. When the field is blank, they keep the existing address-based Google Maps search. A configured map link also works without an address.
- **Admin calendar:** follows the supplied examples with day navigation, native date input/Calendar button, Today, activity filter, month label and a scrollable 14-day date strip. Date chips display live Open, Full, Closed, Past, Open play or No resources states.
- **Resource/time grid:** keeps the existing slot states and links for held/booked/verification records. The responsive table uses sticky resource names and time headings. Swipe, keyboard scrolling and earlier/later time buttons keep wider schedules usable on phones and tablets.
- **Live behavior:** date summaries reuse the same database context and slot rules as the selected-day grid. Requests are cancelled/fenced on date or activity changes. Empty and unavailable states provide recovery; a failed date-summary request does not hide the usable grid. Existing polling and staff compatibility remain intact.

## Affected files

| Area | Files |
| --- | --- |
| Settings and facility API | `src/worker/lib/settings.ts`, `src/worker/routes/admin-settings.ts`, `src/worker/routes/facility.ts`, `public/js/admin/screens/settings.js` |
| Calendar API | `src/worker/lib/availability.ts`, `src/worker/routes/admin.ts` (`GET /api/admin/schedule/days` and staff equivalent) |
| Calendar UI | `public/js/admin/screens/calendar.js`, `public/css/admin.css` |
| Shared Directions | `public/js/core/facility.js` (new), `public/js/player/screens/home.js`, `public/js/player/screens/landing.js` |
| Cache and verification | `public/sw.js`, `tests/calendar-maps.mjs` (new), `tests/calendar-maps-browser.mjs` (new), `package.json`, `scripts/verify.mjs`, `README.md` |

## Verification

- `npm run verify:static`: passed 119 syntax checks, generated Worker type validation, TypeScript, all **352 regression tests**, and the Worker dry-run build.
- `npm run test:calendar-maps`: **6 tests passed** for persistence/edit/clear, admin authorization, URL validation, Directions fallback, filtered live date availability, closures, maintenance, open play, occupied/past dates and input validation. These tests are included in the 352-test static run.
- `npm run test:calendar-maps-ui`: **18 browser scenarios passed**. Admin calendar checked at **320, 375, 390, 430, 768, 1024, 1440 and 1920 px**; shared staff calendar checked at 320/1440 px. Tests cover keyboard date selection, native Calendar button, Today/previous/next, activity filtering and URL reload, slot links, sticky labels/headings, scroll controls, no page overflow, Maps save/reload/clear, public/player Directions, empty/error recovery, wide schedules and stale responses.
- Existing `tests/public-pages.mjs`: passed at 320, 375, 430, 768, 1024 and 1440 px.
- Existing `tests/concurrency-frontend-regression.mjs`: all **9 tests passed**.
- `git diff --check`: passed for the affected tracked files. Existing workspace edits were preserved.

The browser suites use the actual frontend with synthetic API fixtures. API tests use real Hono routes and isolated SQLite fixtures. No deployment, remote database mutation or reset of the ordinary local development database was performed. This follow-up adds no migration; it uses the current schema and existing settings storage.

Logs: `.wrangler/calendar-maps-static.log`, `.wrangler/calendar-maps-browser.log`, `.wrangler/calendar-maps-public-regression.log`, `.wrangler/calendar-maps-frontend-regression.log`.

Screenshots: `.wrangler/calendar-maps/calendar-320.png`, `calendar-390.png`, `calendar-768.png`, `calendar-1440.png`, `calendar-1920.png`, plus staff/calendar and Maps settings screenshots in the same directory. Desktop, phone and tablet screenshots were visually reviewed against the supplied examples.

No unresolved local verification failure remains. The changes are ready for the existing deployment process.
