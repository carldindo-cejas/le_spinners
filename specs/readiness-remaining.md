# Booking time, shared-IP authentication and history

Candidate: October 7, 2026 working tree, migrations through `0016_history_indexes.sql`. Codex implemented this change; independent reviewer and staging operator remain unassigned. Production is not ready.

## M12: authoritative end times

Booking DTOs expose `endsAt` in epoch milliseconds, calculated from the stored facility-local date and `end_min` using the configured timezone offset. This is the same final envelope used by completion maintenance. Gapped bookings remain active through their last segment. The shared browser helper has a fallback for older cached DTOs using valid segment ends or `end - start`; it never assumes one hour.

Home and booking history use response `now`, rather than the device clock. Confirmed bookings are upcoming strictly before their final end. Cancelled bookings have their own group; completed/expired bookings are past. Payment-submitted bookings remain actionable while awaiting verification even after scheduled play. Temporary/rejected bookings remain actionable while their proof window is open. Home requests the earliest upcoming booking separately from recent history, so a large history cannot hide an ongoing booking.

`tests/readiness-remaining.mjs` covers short/hour/multi-hour/gapped/midnight boundaries and unresolved payment states. Two maintained real-module browser probes demonstrate the original defect on the preserved audited tree and pass on the candidate. Baseline log: `.wrangler/readiness-remaining-booking-baseline.log`; its rendered list and home both say “No upcoming bookings” while the fixture is still playing.

## M13: legitimate shared-IP arrivals and bounded abuse

| Budget | Limit | Window |
| --- | --- | --- |
| Salt lookup, IP | 300 | 15 minutes |
| Salt lookup, email | 20 | 15 minutes |
| Login arrival, IP | 300 | 15 minutes |
| Login burst, IP | 120 | 1 minute |
| Login arrival, email | 30 | 15 minutes |
| Failed credentials/portal/status, IP | 60 | 15 minutes |
| Failed credentials/portal/status, email | 8 | 15 minutes |

Each counter is independent. All login arrivals consume the aggregate/per-account arrival budgets, bounding credential checks before cryptographic work. Failed attempts consume failure budgets; successful authentication never deletes or resets those counters. A valid credential can succeed despite previous failed-attempt exhaustion when arrival budgets remain. An invalid attempt after the failure allowance gets 429. These are temporary window budgets, not permanent account locks.

The Worker reads Cloudflare's edge `CF-Connecting-IP`, validates IPv4 and canonicalizes IPv6. It ignores arbitrary `X-Forwarded-For`. Missing/invalid IP uses the shared `local` bucket. Direct local fixtures are synthetic; intended ingress, any Worker-to-Worker forwarding, IPv6 privacy-address rotation and account/plan CPU costs need staging review. The email budget retains protection when addresses change.

The preserved baseline allows only 30 of 50 same-IP salt lookups; the maintained probe fails there and passes for all 50 salt lookups and sign-ins on the candidate. Failure persistence through same/other-account successes, mixed abuse, canonical IPv6, spoofed forwarding and exact-window recovery pass locally. These results do not pass G07.

## L02: bounded history contract

Booking, credit, notification, inbox and chat GET APIs accept `limit` (default 50, maximum 100) and an optional opaque `cursor`. Responses include `page: {limit, hasMore, nextCursor}`. SQL fetches only `limit + 1` rows. Bookings order by date/start/id; other histories order by created-at/id. Booking, credit, notification category/state and inbox unread/verifying/search filters are applied in SQL before pagination; the cursor scope includes actor and applicable filters. Inbox search matches names and booking references with literal `%`, `_` and backslash handling. Filter/search changes reset the UI to the first page.

Cursors are versioned base64url UTF-8 JSON with a bounded length, validated types, scope and `asOf`. They are positions, not credentials or signed authorization grants: every SQL query still enforces ownership or staff/admin access. Invalid, foreign-owner or changed-filter cursors fail with 400. Chat pages query newest-first and render each bounded page chronologically. The inbox fixes the latest-message ordering at the first page's server `asOf`, so a new message does not move an older conversation out of traversal.

Immutable created-at/id histories support traversal without offset shifts from newly inserted earlier-sort rows. Booking status, schedule and unread filters are live: edits/deletion can change membership in a filtered result, and refresh starts a new traversal. Notification timestamps can also change when an unresolved notice is refreshed by a new message; that notice can move before a traversal's current cursor and must be picked up by refreshing the first page. This is not a database snapshot. Cursor ordering for timestamp ties is deterministic; returning Newer re-fetches that page. New rows are picked up by refreshing/resetting the first page.

Player and console history controls replace the current page instead of growing the DOM. Only prior cursor positions are retained. Filter changes reset traversal; route disposal cancels requests/listeners and prevents stale page commits. Sending chat resets to the newest page. Empty/final pages have no Older action. Existing post-message responses remain bounded at the previous 200-message maximum; GET pagination retrieves earlier history.

`0016_history_indexes.sql` is additive: owner/console booking and credit ordering, chat ordering/latest text, partial unread text and notification ordering/state indexes. The rate-limit cleanup index already exists in 0012. Do not rewrite applied migrations.

Local evidence: 16 new deterministic/API tests, 14 new browser scenarios, histories above old caps, equal timestamp traversal, new inbox activity, changed-filter/cross-actor cursors, and admin-only accounting access pass. Full integrated evidence is recorded in the tracker and tooling specification. Required independent review and actual device/PWA checks remain open.

Independent review on October 7, 2026 found acceptance gaps that those 14 browser scenarios omitted: active staff/admin conversations threw `ReferenceError: threadEl is not defined`, and notification/inbox filters were applied only to the fetched page, so older actionable records could be hidden behind recent unrelated/resolved records. The active-thread probes failed in both consoles before the mount fix. Two new API regressions failed on the review-entry candidate with 125 unrelated recent records and three older matches; they pass after the SQL filtering/cursor-scope changes. A pager race also reproduced old-filter cursors being restored after a failed new-filter request while an Older request remained pending; reset/target changes now clear that rollback state. The current targeted suite passes **18 tests**; the extended actual-module browser suite passes **22 scenarios**, including console thread open/Older/Newer/reply, every portal's filter reset and the failed-reload race. The notification UI now truthfully labels SMS unsupported and does not promise future automatic delivery. See [independent browser/auth/storage review](audit-browser-2026-10-07.md) for acceptance verdicts and remaining device/runtime requirements. No remote mutation or provider send was performed during this review.
