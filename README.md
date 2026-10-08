# Le Spinners Recreational Hub

A mobile-first booking app (PWA) for pickleball courts and table tennis tables, with
consoles for staff and administrators.

Visitors at `/` see a public landing page with sports and rates, booking instructions,
facility hours, directions, FAQs, and a **Court Calendar**. The calendar shows courts and
tables without signing in: pick a date, filter by sport or resource, and select an available
time to continue through sign-in or registration into booking. Signed-in players keep their
dashboard at `/`; `/welcome` opens the landing page for any role.

The calendar refreshes every 30 seconds while visible, online and active, and on return to the page. It uses
facility time and the configured booking window. Holds, payment verification, confirmed
bookings, closures, maintenance, and open play follow the same rules as the booking flow.
Failed or offline refreshes remove stale bookable times. Browsing never reserves a slot.
`GET /api/facility/calendar?date=YYYY-MM-DD&activity=pickleball` is public (`activity` is
optional), with an explicit response allowlist: resource information and slot states only.
Booking owners, references, payment details, private notes, and personalized booking states
are excluded even when the visitor is signed in.

Each role has its own sign-in page and dashboard. An account can only sign in through the
page for its role:

| Role | Sign in | Dashboard | What it's for |
|---|---|---|---|
| User (player) | `/login` | `/` | Live availability, booking any open times on a court or table (back to back or with gaps, price × slots), a 10-minute temporary hold, configured payment instructions, payment-screenshot upload, booking chat, notifications, profile, **booking credits** (what Le Spinners owes after cancelling a paid booking) and **Rebook** |
| Staff | `/staff/login` | `/staff/` | Dashboard, payment verification (approve after ticking the required "Before you approve" checklist, or reject with a reason), bookings with their author ("Online" or "Staff · name" / "Admin · name"), bookings on site (**New booking**: the booker's name is required for reference, confirmed at once, paid at the desk or free), per-booking chat that opens in place on the booking and review pages, notification center, calendar, courts and tables, weekly hours and closed dates, **Cancel & credit** and **Disruptions** (cancel or cut short paid bookings with a booking credit), booking credits, own profile |
| Admin | `/admin/login` | `/admin/` | Everything staff can do, plus **Staff Management** at `/admin/staff`, Settings (payment methods and QR codes, prices, alert recipients, booking rules, the email/SMS outbox), **Revenue** at `/revenue/` (collected revenue and the booking ledger), credits issued by hand, voids and cash-refund records, and disruptions up to 7 days back |

Member and non-member are a player's *membership* (it sets the price), not a role, and it
never grants console access.

One Cloudflare Worker serves all three apps and the API:

| Layer | Choice |
|---|---|
| Hosting | Cloudflare Workers + static assets (`public/`) |
| API | [Hono](https://hono.dev) in TypeScript (`src/worker/`) |
| Database | Cloudflare D1 (SQLite), migrations in `migrations/` |
| Files | Private R2 bucket for payment screenshots and payment-method QRs |
| Jobs | Cron trigger every minute (expire holds, warnings, completions, email) |
| Frontend | Plain HTML, CSS and vanilla JavaScript modules — no build step |

## Booking flow

```
Select time ─▶ TEMPORARY (slot held 10 min, countdown)
                 │ upload payment screenshot
                 ▼
           PAYMENT_SUBMITTED  ("Payment proof submitted" · "Waiting for admin verification")
             │ staff approve                     │ staff reject (reason required)
             ▼                                   ▼
          CONFIRMED ─▶ COMPLETED            REJECTED (optional 10-min resubmit window)
                                                 │ no new proof in time
TEMPORARY with no proof in time ─▶ EXPIRED ◀─────┘   Player releases an unpaid hold ─▶ CANCELLED

Le Spinners cancels (Cancel & credit, or a disruption) ─▶ CANCELLED + booking credit
A booking already under way when play stops            ─▶ stays CONFIRMED + credit for the lost time
```

The app never says "Payment received". An upload is "Payment proof submitted";
only staff approval shows "Payment verified" and "Booking confirmed".

What other players see for a slot: **On hold · may reopen** (TEMPORARY, or REJECTED during
its resubmit window), **Unavailable** (PAYMENT_SUBMITTED), **Booked** (CONFIRMED). Never a
name, amount or screenshot.

Players can't cancel a booking: the app has no cancel button and `POST /api/bookings/:id/cancel`
always answers `409 NOT_CANCELLABLE`. They can release an unpaid hold, and anything else goes
through the booking chat.

## Disruptions and booking credits

When Le Spinners can't honour a booking (weather, unsafe conditions, repairs, an emergency, its
own mistake), staff use **Cancel & credit** on the booking, or record a **disruption** for a
time window on one court, one activity or the whole facility. The plan and its open policy
questions are in [REBOOKING.md](REBOOKING.md).

- Everything is previewed first: each affected booking, what happens to it and the credit.
  Nothing changes until staff confirm, and a confirmation can't be applied twice.
- A paid booking that hasn't started is cancelled and its full value becomes **booking credit**.
  A booking already under way keeps its status; only the time that couldn't be played is
  credited (per minute, rounded down to the centavo). Unpaid holds are released, with no credit.
  A booking whose payment proof is waiting is finished once staff verify or reject it.
- Booking credit is money, never a cash refund. It is spent automatically on the player's next
  booking (any court or table): if it covers the price the booking is confirmed at once; if
  not, the rest is paid using an enabled method and the credit comes back if that hold ends unpaid.
- The closure, the cancellations, the credits, the ledger, the notices and the audit row are one
  database transaction. Every credit change is a row in `credit_transactions`, and a credit's
  `remaining` always equals the sum of its ledger.
- Admins can issue a credit by hand, void one, or record a cash refund paid outside the app
  (which spends that much credit). Credits don't expire: no expiry policy has been decided.

## Revenue reporting

`/revenue/` (administrators only) shows daily, weekly, monthly and yearly collected revenue,
each compared with the previous period up to the same point, and a booking ledger with
search, filters, sorting, server-side pagination and CSV export. Revenue is what staff have
verified, counted on the day they verified it:

| Ledger payment status | Counts as collected revenue? |
|---|---|
| Paid · verified (`CONFIRMED` or `COMPLETED`, `confirmed_at` set) | Yes: `amount_due`, dated `confirmed_at` |
| Pending verification (`PAYMENT_SUBMITTED`) | No, shown as pending |
| Proof rejected | No |
| Cancelled · credited (cancelled by Le Spinners, the value kept as booking credit) | No, reported with cancelled after payment |
| Cancelled after payment (verified, then cancelled, no credit recorded) | No, reported separately |
| Cancelled before verification | No |

Each booking is one ledger row, so resubmitted proofs never double count. `amount_due` is the
cash part: booking credit used to pay (`credit_applied`) is never counted as collected cash. Days, weeks
(Monday–Sunday), months and years use facility time (`TZ_OFFSET_MINUTES`, Asia/Manila).
Configured payment methods (including disabled/removed methods with historical payments)
are available in ledger filters and exports. The API is
`GET /api/admin/revenue/summary`, `/ledger` and `/export`. The CSV is built in parts of
1,000 rows (`?part=N`); deployed CPU and database usage must be measured on the intended plan. The page
fetches every part and saves one file of up to 50,000 rows. If payments change between
parts, the page starts the file over. Each export is logged in `audit_log`.

## Payment methods and mobile admin UI

Admin Settings supports adding, editing, disabling and removing payment methods.
Only the method name is required; account name, account number and a QR image are
optional. Each method saves independently of the other settings. QR images use
the existing private R2 bucket, image validation and durable upload/cleanup tracking.
The booker selects an enabled method and sees only its configured instructions.
Submitted proofs retain the method name and recipient details, so later admin
edits/removal do not alter payment history or staff verification.

Apply **migration 0020** after the existing migrations before deploying this API
and frontend together. It migrates the current GCash settings and labels existing
online payments as GCash. Legacy GCash settings, QR endpoints and proof clients
remain supported; omitted proof selections use GCash only when it is still enabled.
The existing `payment_method` column retains its cash-channel enum; new
`payment_method_id` and snapshot columns identify configurable online methods.
No new Cloudflare binding or storage bucket is required.

Revenue cards form a 2×2 mobile grid. Ledger filters start collapsed on phones,
and CSV export stays at the header's right edge. Dashboard collected revenue
uses verification date, matching the revenue report. Facility segments represent
availability **right now**, including opening hours, closures, maintenance,
disabled resources and occupying bookings; open play remains open/in service.
Counts include disabled facilities so they appear as unavailable segments.

`npm run test:payment-methods` runs isolated migration/API/storage/accounting tests.
`npm run test:mobile-payments` uses the read-only browser fixture server at
localhost:8805 (or `BASE_URL`) for 320, 375, 390, 430 and 1440px UI checks.
Both suites are included in `npm run verify`.

## Facility location and console calendar

Admin Settings → Facility info includes an optional **Maps location link**.
Paste an HTTPS map share URL to set the precise location used by Directions on
the public site and player home screen. Clearing it restores directions based
on the address. This uses the existing settings table; no additional migration
or Cloudflare binding is required.

The admin/staff calendar combines the date picker and day navigation with a
14-day strip of live availability. It retains the resource/time grid and booking
review links. Resource labels and time headings stay visible while scrolling;
phones have swipe support and explicit earlier/later time controls. Date,
activity and Today controls remain available at phone, tablet and desktop sizes.
Changes cancel older requests so delayed responses cannot replace the current
date/filter. The grid refreshes using the existing visibility-aware polling.

`npm run test:calendar-maps` checks settings persistence, authorization, URL
validation, Directions fallback and the real console availability API using
isolated SQLite fixtures. `npm run test:calendar-maps-ui` uses the read-only
browser fixture at localhost:8805 (or `BASE_URL`) for responsive calendar,
settings and Directions checks. Both are included in `npm run verify`.

## Run it locally

Requires Node.js 24 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars      # Windows: copy .dev.vars.example .dev.vars
npm run db:reset:local              # local database + demo data + demo screenshots
npm run dev                         # http://localhost:8787  (staff: /staff/, admin: /admin/)
```

Put any long random string in `FILE_SIGNING_SECRET` inside `.dev.vars`. Keep the
`PASSWORD_PEPPER` line from `.dev.vars.example` as it is: the demo accounts' password hashes
are keyed with that development value. After changing demo accounts, rebuild their rows in
`db/seed.dev.sql` with `npm run db:seed:generate`.

`npm run db:reset:local` wipes the local database and loads demo data. Every demo account
uses the password **demo-pass-2026**. They exist only in your local database.

| Who | Email | Sign in at | Notes |
|---|---|---|---|
| Player (member) | juan.delacruz@example.com | `/login` | has a confirmed booking |
| Player (member) | maria.santos@example.com | `/login` | proof waiting for verification |
| Player (non-member) | pedro.cruz@example.com | `/login` | proof waiting, amount differs |
| Player (membership pending) | kim.aquino@example.com | `/login` | confirmed booking tomorrow |
| Staff | rhea.lim@lespinners.example | `/staff/login` | staff console |
| Admin | ana.reyes@lespinners.example | `/admin/login` | admin console |

The demo "screenshots" are labelled **DEMO · NOT A REAL RECEIPT**.

### Cron in local development

Holds also expire on their own whenever someone loads the app, so local testing works
without cron. To run the scheduled job by hand, start the server with
`npm run dev:test` and open:

```
http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*
```

### API smoke test

```bash
npm run db:reset:local
npm run dev:test          # keep it running in another terminal
npm run test:smoke        # about 480 checks: sign-in per role, API access by role, holds, double booking,
                          # uploads, privacy, approve/reject, expiry, chat, courts, hours, closures, revenue,
                          # cancel & credit, disruptions, rebooking with credit, double spending, ledger…
```

The suite edits the local database, so run `npm run db:reset:local` before each run.

`npm run typecheck` type-checks the Worker.

Production-readiness work is tracked in [SYSTEM_REPORT_IMPLEMENTATION.md](SYSTEM_REPORT_IMPLEMENTATION.md).
The first integrity fixes and migration procedure are documented in
[specs/readiness-p0.md](specs/readiness-p0.md). With Node 24, run `npm run test:readiness`
for isolated date, payment-transition, schedule-race, refund/booking replay, maintenance recovery, polling and upgrade regressions.
Booking creation now requires an `Idempotency-Key` header; see [specs/readiness-recovery.md](specs/readiness-recovery.md) for client compatibility, bounded catch-up, current quota projections and remaining staging checks.
Outbox claims, replay bounds and safe rollback are described in [specs/readiness-outbox.md](specs/readiness-outbox.md).
Image acceptance and upload recovery are described in [specs/readiness-storage.md](specs/readiness-storage.md).
The new Worker requires migrations **0009–0021**. Follow the readiness migration/recovery
procedure before any live rollout; current local test results do not establish production readiness.

Credential/session versioning and administrative reset requirements are described in
[specs/readiness-auth.md](specs/readiness-auth.md). Password changes retain only their
initiating live session. Resetting credentials, changing roles or disabling an account
invalidates earlier versions; re-enabling an account does not revive old sessions.
Provisioning with `npm run create-admin` requires migration 0015 and rejects a concurrent
account change instead of silently replacing its credentials.

Administrators can manage staff at `/admin/staff` (sidebar or mobile **More**, above
Settings): search/filter the paginated list, add an account, edit its name/email,
activate/deactivate it, or reset its password after confirming their own administrator
password. Accounts use email sign-in and always receive the Staff role. New accounts
do not replace the administrator's session. Password resets and email/status changes
revoke every staff session; activation requires a fresh sign-in at `/staff/login`.
The API uses `/api/admin/staff` for listing/creation, `PATCH /api/admin/staff/:id`
for edits/status, and `POST /api/admin/staff/:id/reset-password` for resets.
Edits/resets require the returned `authVersion` and `updatedAt` as
`expectedAuthVersion` and `expectedUpdatedAt`, so a stale form cannot overwrite a
later change. Account responses omit credential and session data.

Apply **migration 0021** before deploying these Worker changes. It adds the staff
list index, includes email changes in session versioning, and creates a constant
authorization assertion table. Staff operations recheck the acting account and live
session within the transaction that performs the write, so a request paused before
deactivation cannot commit afterward. Existing accounts and valid sessions are
preserved by the migration. Run `npm run test:staff` for isolated account/security
regressions and `npm run test:staff-ui` with the local fixture server running for
responsive forms and navigation. `npm run verify` includes both suites and staff
login/revocation tests against disposable local D1.

Route cancellation, authentication generations and dialog/listener cleanup are described in
[specs/readiness-lifecycle.md](specs/readiness-lifecycle.md). `npm run test:readiness`
includes their deterministic regressions. For actual-browser checks with synthetic APIs,
start the read-only `node tests/helpers/browser-server.mjs` in one terminal and run
`npm run test:lifecycle-ui` in another. It uses localhost:8799 and needs Playwright/Chromium;
`PLAYWRIGHT_MODULE` and `BROWSER_EXECUTABLE` can select an existing installation.
Truthful retryable logout is described in [specs/readiness-logout.md](specs/readiness-logout.md).
Run `npm run test:logout-ui` against the same fixture server. Pending/failed sign-out hides
private screens and blocks session restoration until a server acknowledgement, followed by
explicit fresh sign-in. Intended-device/PWA, storage-fallback and real cookie-ordering checks
remain pending in the tracker.

Validated login/registration return targets and portal routing are described in
[specs/readiness-redirect.md](specs/readiness-redirect.md). `npm run test:redirect-ui`
uses the same localhost fixture server. Untrusted targets fall back to the matching
portal home; valid deep links retain their query and fragment through reauthentication.

The public calendar has a separate integration check with isolated local fixtures (leave
your normal development database intact):

```bash
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/landing-test-state
npx wrangler d1 execute DB --local --persist-to .wrangler/landing-test-state --file=db/facility.sql
npx wrangler dev --local --persist-to .wrangler/landing-test-state --port 8791
# In another terminal:
node tests/public-calendar.mjs
```

This test writes fixtures only to `.wrangler/landing-test-state` and expects that isolated
server on port 8791. It checks anonymous access, privacy for every role, booking states,
nonconsecutive slots, date limits, closures, maintenance, and open play.

## Repeatable readiness verification

Use Node 24+ (CI pins 24.14.0). Install the exact locked toolchain and matching browser, then run the maintained suites:

```sh
npm ci
npx playwright install chromium
npm run verify
npm audit --audit-level=high
```

Linux CI uses `npx playwright install --with-deps chromium`. Verification checks generated bindings, syntax, TypeScript, deterministic regressions, all browser suites, the dry-run bundle, and real local D1/R2/auth/calendar flows. It owns localhost ports 8805 and 8810–8812 and creates disposable state under `.wrangler`; stop other fixtures on those ports first. It never resets your normal development database or sends provider mail. The capacity component is a 15-second read ramp; mixed staging load, real-device PWA, accessibility and independent review remain release gates.

See [history/time/auth contracts](specs/readiness-remaining.md), [toolchain and CI evidence](specs/readiness-tooling.md), and [migration, retention, recovery and incident procedures](specs/readiness-operations.md). Existing-account operator recovery is `npm run recover-account` (local by default); remote recovery needs an explicitly mapped named environment and the reviewed identity/recovery procedure. Production readiness remains tracked in [SYSTEM_REPORT_IMPLEMENTATION.md](SYSTEM_REPORT_IMPLEMENTATION.md).

## Deploy to Cloudflare

The [8 October concurrency audit](specs/concurrency-audit-2026-10-08.md) records simultaneous
booking tests through 50 players, the implemented race fixes, and remaining production gates.
`npm run test:concurrency` creates disposable local D1/R2 state and runs actual HTTP workloads;
`npm run test:concurrency:regressions` exercises forced interleavings and browser behavior.
Before rollout, run [the resource-name preflight](scripts/audit-resource-names.sql), reconcile
duplicate physical mappings, and apply migrations 0017–0019 in order. Updated staff decisions
require `proofId`, so deploy the API and frontend together and refresh cached clients.

Password derivation (PBKDF2) runs in the browser; the Worker verifies an HMAC and
performs authentication database work. Image uploads validate container bytes and
rebuild retained segments without decoding pixels. Both paths, complete cron work,
polling and near-limit concurrent uploads still need intended-plan CPU/query/quota
measurements. The readiness plan proposes **Workers Paid with D1 Paid**, pending
account and cost acceptance; local passes do not establish production headroom.
See [the workload budget](specs/readiness-recovery.md) and
[the image contract](specs/readiness-storage.md) before selecting a launch plan.

1. Sign in: `npx wrangler login`
2. Create the database and copy the printed `database_id` into `wrangler.jsonc`
   (replacing `00000000-0000-0000-0000-000000000000`):
   ```bash
   npx wrangler d1 create le-spinners
   ```
3. Create the **private** bucket for payment screenshots. Don't turn on public access or
   a public `r2.dev` URL for it.
   ```bash
   npx wrangler r2 bucket create le-spinners-proofs
   ```
4. Set the signing secret used for private screenshot links:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   npx wrangler secret put FILE_SIGNING_SECRET
   ```
   Then set the password pepper, a **different** random value from the development one.
   Keep a copy in your password manager: `create-admin` asks for it, and if it is lost,
   every password has to be reset.
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   npx wrangler secret put PASSWORD_PEPPER
   ```
   Never put the production pepper in D1, source code, `wrangler.jsonc`, frontend code, Git
   or logs.
5. In `wrangler.jsonc`, set `APP_ORIGIN` to the address players will use (for example
   `https://le-spinners.your-subdomain.workers.dev` or your own domain). It is used for
   links in emails and for the cross-site request check.
6. Create the tables, then add the courts and tables. Edit names and prices in
   `db/facility.sql` first if needed. **Never load `db/seed.dev.sql` into production.**
   ```bash
   npm run db:migrate:remote
   npx wrangler d1 execute DB --remote --file=db/facility.sql
   ```
7. Deploy: `npm run deploy`
8. Create the first administrator. You'll be asked for the email, name, a password of
   12+ characters and the production `PASSWORD_PEPPER` (hidden input, never a command-line
   argument). The script derives the hash on your machine and stores only the HMAC, salt,
   scheme and iteration count:
   ```bash
   npm run create-admin -- --remote
   ```
   After signing in, use **Staff Management → Add Staff** for front-desk accounts;
   `--role staff` remains available for command-line provisioning. Staff sign in at `/staff/login` and can verify
   payments and manage courts, hours and closed dates, but can't open Settings or change prices.
   Running the script again for the same email resets that account's password and role.
9. Sign in at `/admin/login` → **Settings**. Configure the payment methods and their optional
   account details/QR images, add alert email addresses and the facility address, and check the prices.

Existing deployments need no database migration for roles: `users.role` already holds
`player`, `staff` or `admin`. After deploying, staff accounts that used `/admin/` are sent to
`/staff/` automatically (old links in alert emails keep working).

The revenue page adds two indexes. On an existing deployment, run `npm run db:migrate:remote`
once (it applies `migrations/0003_revenue_indexes.sql`); it doesn't change any data.

Disruptions and booking credits add tables and columns (`migrations/0007_disruptions_credits.sql`,
additive only). Run `npm run db:migrate:remote` **before** `npm run deploy`: the old Worker
ignores the new columns, the new one needs them.

### Email alerts (optional)

Staff get an email for every payment proof ("Le Spinners — Booking Requires Payment
Verification"), and players get an email when a booking is confirmed or rejected, and when
Le Spinners cancels or cuts short a booking and adds a booking credit.
Messages are written to the `outbox` table and sent through [Resend](https://resend.com)
once both of these are set:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM        # e.g. Le Spinners <alerts@your-domain.com>
```

Without them, emails stay queued and can be seen under **Settings → Message delivery**.
The queue distinguishes provider acceptance, scheduled retries, rejected sends and uncertain
deliveries requiring review. Provider acceptance does not confirm inbox arrival. Retries reuse
the stored provider key and frozen payload, stop after five claims or before the replay window
expires, and recover abandoned leases. See the [outbox recovery procedure](specs/readiness-outbox.md)
before changing credentials, migrating, rolling back or reviewing old attempted messages.

### SMS

SMS alerts are retained as unsent outbox records and labeled **SMS not connected**.
No SMS provider is connected. A future integration needs its own claim, replay and recovery
contract; historical queued texts must be reviewed before sending.

## Security and privacy

- **Roles.** One `users` table holds every account; `users.role` is `player`, `staff` or `admin`
  and is only ever read from the database, never from a request.
  - Sign-in is per role: `POST /api/auth/user/login`, `/api/auth/staff/login`,
    `/api/auth/admin/login` (the original `/api/auth/login` is the player one). An account
    signing in through another role's endpoint gets the same `401 Email or password is incorrect`
    as a wrong password, after the same work, counts against the same rate limits, and no
    session is created or replaced. `GET /api/auth/session` returns the account and its dashboard.
  - API namespaces are guarded before any handler runs, and handlers check again:

    | Path | Allowed |
    |---|---|
    | `/api/bookings/*`, `/api/credits/*`, `/api/notifications/*`, `/api/availability*` | players (their own bookings and credits only) |
    | `/api/staff/*` | staff and admins: dashboard, verification, bookings, chat, staff notifications, schedule, courts, hours, closures, disruptions (cancel & credit), credit lookups |
    | `/api/admin/*` | admins: the same operations, plus staff account management (`/api/admin/staff/*`), settings, payment methods and QR images, prices, the outbox, revenue (`/api/admin/revenue/*`) and credit changes (`/api/admin/credits/*`) |
    | `/api/me`, `/api/auth/*`, `/api/files/proofs/:id`, `/api/facility*` | shared, checked per route |

    Missing or expired sessions get `401`; signed-in accounts without the role get `403`, and
    the attempt goes to `audit_log` (`forbidden_access`). The consoles and their navigation only
    reflect this; they are not the security boundary.
  - Nobody can change a role through the app. Administrators create Staff accounts in
    **Staff Management**; `npm run create-admin` also provisions staff/admin accounts.
- **Facility changes never cancel bookings on their own.** Putting a court into maintenance or
  open play (free for all: players see it marked OPEN PLAY and can't book it), disabling it,
  closing a date or time, or changing weekly hours first lists the active bookings it would
  affect (`409 AFFECTS_BOOKINGS`). The change is applied only when the request confirms every
  one of them by id. Staff then either keep the bookings and follow up in chat, or choose
  **Cancel & credit**, which previews and applies a disruption. Courts are never deleted, only disabled, and past closures can't be removed.
  Every change is written to `audit_log` with the affected booking references.
- **Passwords** never reach the server. The browser derives
  `clientHash = PBKDF2-SHA256(password, salt, 600 000 iterations)` (16-byte random salt per
  password, new on every change). The Worker stores only `HMAC-SHA256(PASSWORD_PEPPER, clientHash)`
  and compares it in constant time. `clientHash` is password-equivalent, so it is only ever sent
  over HTTPS in a request body and never stored or logged.
  - Sign-in takes two requests: `POST /api/auth/salt` returns the salt, and
    `POST /api/auth/login` checks the clientHash. For unknown emails, the salt endpoint returns
    a deterministic fake salt with the same shape, and login runs the same HMAC and comparison.
  - `PASSWORD_PEPPER` is a Worker secret. The committed `dev-only-` pepper is refused anywhere
    but localhost.
  - Password strength (8+ characters, or 12+ for staff) is checked in the browser and in
    `create-admin`. The server never sees the password.
- **Sessions** use a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie
  (`Secure` over HTTPS). Only its SHA-256 is stored.
  - Player sessions last 30 days and extend with use. Unticking "Keep me logged in"
    ends the session when the browser closes.
  - Staff and administrator sessions end 12 hours after sign-in. Every request checks
    the current account status and credential version; staff writes also check the
    acting session within their database transaction.
- **Rate limits** apply to salt lookups and sign-in (per IP and per email; temporary 15-minute
  windows, never a permanent lockout), registration, password changes, holds, uploads and chat messages.
- **Cross-site requests.** Every state-changing request must come from the app's own
  origin (the `Origin` check), on top of SameSite cookies.
- **Status changes are server-only.** Players can only ask for actions (reserve, upload,
  release an unpaid hold). The server checks ownership, role and the current status inside one
  database batch. Players never cancel a booking.
- **Money is computed on the server.** Prices, credit amounts and balances never come from the
  browser (unknown fields such as `amount` are refused). A disruption confirmation needs the
  preview's token and an `Idempotency-Key`; every booking update checks the status and version
  the preview saw. Spending credit runs in the same transaction as the booking, and
  `CHECK (remaining >= 0)` makes a second spend of the same value fail as a whole.
- **No double booking.** Each hold is a single atomic `INSERT … WHERE NOT EXISTS
  (overlap)`, backed by a partial unique index.
- **Payment screenshots:**
  - Static JPG, PNG and WEBP are detected from their bytes. Container structure,
    required headers/order, lengths and PNG CRCs are checked; malformed or truncated
    containers are rejected. Proofs allow 10 MB, QR images 5 MB; both allow at most
    8192 pixels per side and 16 million pixels. Animation and unsupported encodings are rejected.
  - Before storing, private EXIF fields (GPS/camera), XMP, text, C2PA, comments,
    thumbnails and trailing bytes are removed. A valid orientation tag is rebuilt on
    its own; ICC profiles and supported rendering/color information are retained.
    This validates containers without decoding compressed pixels or sanitizing ICC
    profile internals. It cannot prove every accepted bitstream is decodable or erase
    information visible in pixels. The same contract applies to payment-method QR uploads.
  - Upload ownership is stored before R2 writes; attachment commits with the proof
    or QR setting. Failed/abandoned uploads receive fenced cleanup and retry records.
    Settings → Upload recovery shows pending work and manual review counts. Historical
    orphan discovery remains disabled until existing files and retention are reviewed;
    see the [migration/reconciliation procedure](specs/readiness-storage.md).
  - Files are stored in a private bucket under random names.
  - A screenshot is served only through a signed link that expires in 5–10 minutes,
    **and** only to the booking's player or to staff, with `Cache-Control: private, no-store`.
  - Every staff view is recorded in `audit_log`.
- **Chat** threads are per booking. Only that player and staff can read or post.
- **Headers.** Pages get a strict Content-Security-Policy (`script-src 'self'`, no inline
  scripts or styles) and `frame-ancestors 'none'` (see `public/_headers`); API responses
  are `no-store`. The frontend renders through an escaping template helper, so user
  input never becomes HTML.
- **Audit.** Sign-ins, failed sign-ins, approvals, rejections, cancellations, settings
  changes, proof views and revenue CSV exports go to `audit_log`, with the booking history
  in `booking_events`.
- **Revenue exports.** The ledger and CSV never include proof storage keys or links. CSV
  cells that start with `=`, `+`, `-` or `@` get a leading `'` so spreadsheets don't run them.

## Project layout

```
public/                 static PWA (player app at /, staff console at /staff/, admin console at /admin/ and /revenue/)
  css/                  design tokens + components (app.css), player.css, admin.css
  js/core/              templating, API client, router, formatting, icons, UI helpers, account dialogs
  js/player/            player app screens
  js/admin/             console screens shared by /staff/ and /admin/ (console.js picks which)
  staff/, admin/        each console's HTML shell and manifest
  sw.js, manifest       offline shell (API calls are never cached)
src/worker/             Hono API (TypeScript)
  routes/               auth, facility/availability, bookings, notifications/files,
                        admin.ts (operations, served at /api/staff and /api/admin),
                        admin-settings.ts and admin-staff.ts (admin only), facilities.ts (courts, hours, closures),
                        disruptions.ts (cancel & credit), credits.ts (players, staff, admin),
                        revenue.ts (admin only: revenue summary, ledger, CSV)
  lib/                  bookings, payments, availability, facility, disruptions, credits, chat, notify, images, auth, …
migrations/             D1 schema
db/                     facility.sql (courts/tables), seed.dev.sql + demo images (local only)
scripts/                reset-local-db.mjs, create-admin.mjs
tests/smoke.mjs         end-to-end API checks
specs/                  technical design
```

## Not in this version

Tournaments, player account management screens (membership is still confirmed in the database), moving a booking
to another court or time, staff booking for a walk-in player with their credit, credit expiry
(no policy decided), a real SMS provider, push notifications, and live WebSocket chat (the app
refreshes active screens every 10–60 seconds, with hidden/offline/idle pauses).
