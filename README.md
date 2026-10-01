# Le Spinners Recreational Hub

A mobile-first booking app (PWA) for pickleball courts and table tennis tables, with
consoles for staff and administrators.

Each role has its own sign-in page and dashboard. An account can only sign in through the
page for its role:

| Role | Sign in | Dashboard | What it's for |
|---|---|---|---|
| User (player) | `/login` | `/` | Live availability, booking any open times on a court or table (back to back or with gaps, price × slots), a 10-minute temporary hold, GCash payment instructions, payment-screenshot upload, booking chat, notifications, profile |
| Staff | `/staff/login` | `/staff/` | Dashboard, payment verification (approve after ticking the required "Before you approve" checklist, or reject with a reason), bookings with their author ("Online" or "Staff · name" / "Admin · name"), personal bookings on site (**New booking**: confirmed at once, paid at the desk or free), per-booking chat that opens in place on the booking and review pages, notification center, calendar, courts and tables, weekly hours and closed dates, own profile |
| Admin | `/admin/login` | `/admin/` | Everything staff can do, plus Settings (GCash details and QR, prices, alert recipients, booking rules, the email/SMS outbox) and **Revenue** at `/revenue/` (collected revenue and the booking ledger) |

Member and non-member are a player's *membership* (it sets the price), not a role, and it
never grants console access.

One Cloudflare Worker serves all three apps and the API:

| Layer | Choice |
|---|---|
| Hosting | Cloudflare Workers + static assets (`public/`) |
| API | [Hono](https://hono.dev) in TypeScript (`src/worker/`) |
| Database | Cloudflare D1 (SQLite), migrations in `migrations/` |
| Files | Private R2 bucket for payment screenshots and the GCash QR |
| Jobs | Cron trigger every minute (expire holds, warnings, completions, email) |
| Frontend | Plain HTML, CSS and vanilla JavaScript modules — no build step |

## Booking flow

```
Select time ─▶ TEMPORARY (slot held 10 min, countdown)
                 │ upload GCash screenshot
                 ▼
           PAYMENT_SUBMITTED  ("Payment proof submitted" · "Waiting for admin verification")
             │ staff approve                     │ staff reject (reason required)
             ▼                                   ▼
          CONFIRMED ─▶ COMPLETED            REJECTED (optional 10-min resubmit window)
                                                 │ no new proof in time
TEMPORARY with no proof in time ─▶ EXPIRED ◀─────┘        Player/staff cancel ─▶ CANCELLED
```

The app never says "Payment received". An upload is "Payment proof submitted";
only staff approval shows "Payment verified" and "Booking confirmed".

What other players see for a slot: **On hold · may reopen** (TEMPORARY, or REJECTED during
its resubmit window), **Unavailable** (PAYMENT_SUBMITTED), **Booked** (CONFIRMED). Never a
name, amount or screenshot.

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
| Cancelled after payment (verified, then cancelled) | No, reported separately: refunds happen outside the app and aren't recorded |
| Cancelled before verification | No |

Each booking is one ledger row, so resubmitted proofs never double count. Days, weeks
(Monday–Sunday), months and years use facility time (`TZ_OFFSET_MINUTES`, Asia/Manila).
GCash is the only payment method the app records. The API is
`GET /api/admin/revenue/summary`, `/ledger` and `/export`. The CSV is built in parts of
1,000 rows (`?part=N`, about 4 ms of Worker CPU each, so it fits the Free plan); the page
fetches every part and saves one file of up to 50,000 rows. If payments change between
parts, the page starts the file over. Each export is logged in `audit_log`.

## Run it locally

Requires Node.js 20 or newer.

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
npm run test:smoke        # about 360 checks: sign-in per role, API access by role, holds, double booking,
                          # uploads, privacy, approve/reject, expiry, chat, courts, hours, closures, revenue…
```

The suite edits the local database, so run `npm run db:reset:local` before each run.

`npm run typecheck` type-checks the Worker.

## Deploy to Cloudflare

Sign-in and registration fit the **Workers Free** plan: the slow password derivation
(PBKDF2) runs in the browser, and the Worker only computes one HMAC. Payment screenshots
are different. Each upload is decoded and rebuilt inside the Worker to strip metadata,
which can exceed the Free plan's 10 ms of CPU for large photos ("Worker exceeded
resource limits"). Use the **Workers Paid** plan if uploads fail that way. Local
development has no CPU limit.

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
   Use `--role staff` for front-desk accounts. Staff sign in at `/staff/login` and can verify
   payments and manage courts, hours and closed dates, but can't open Settings or change prices.
   Running the script again for the same email resets that account's password and role.
9. Sign in at `/admin/login` → **Settings**. Set the GCash account name and number, upload the
   GCash QR, add alert email addresses and the facility address, and check the prices.

Existing deployments need no database migration for roles: `users.role` already holds
`player`, `staff` or `admin`. After deploying, staff accounts that used `/admin/` are sent to
`/staff/` automatically (old links in alert emails keep working).

The revenue page adds two indexes. On an existing deployment, run `npm run db:migrate:remote`
once (it applies `migrations/0003_revenue_indexes.sql`); it doesn't change any data.

### Email alerts (optional)

Staff get an email for every payment proof ("Le Spinners — Booking Requires Payment
Verification"), and players get an email when a booking is confirmed or rejected.
Messages are written to the `outbox` table and sent through [Resend](https://resend.com)
once both of these are set:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM        # e.g. Le Spinners <alerts@your-domain.com>
```

Without them, emails stay queued and can be seen under **Settings → Sent & queued**.

### SMS

SMS alerts are written to the outbox with status `queued`. No SMS provider is connected
yet. Adding one later means sending the queued rows in `flushOutbox`
(`src/worker/lib/notify.ts`); the rest of the app doesn't change.

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
    | `/api/bookings/*`, `/api/notifications/*`, `/api/availability*` | players (their own bookings only) |
    | `/api/staff/*` | staff and admins: dashboard, verification, bookings, chat, staff notifications, schedule, courts, hours, closures |
    | `/api/admin/*` | admins: the same operations, plus settings, GCash QR, prices, the outbox and revenue (`/api/admin/revenue/*`) |
    | `/api/me`, `/api/auth/*`, `/api/files/proofs/:id`, `/api/facility*` | shared, checked per route |

    Missing or expired sessions get `401`; signed-in accounts without the role get `403`, and
    the attempt goes to `audit_log` (`forbidden_access`). The consoles and their navigation only
    reflect this; they are not the security boundary.
  - Nobody can change a role through the app. Staff and admin accounts are created with
    `npm run create-admin`.
- **Facility changes never cancel bookings.** Putting a court into maintenance or open play
  (free for all: players see it marked OPEN PLAY and can't book it), disabling it, closing a
  date or time, or changing weekly hours first lists the active bookings it would
  affect (`409 AFFECTS_BOOKINGS`). The change is applied only when the request confirms every
  one of them by id, and the bookings stay as they are for staff to follow up in chat or cancel
  with a reason. Courts are never deleted, only disabled, and past closures can't be removed.
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
  - Staff sessions end 12 hours after sign-in.
- **Rate limits** apply to salt lookups and sign-in (per IP and per email; temporary 15-minute
  windows, never a permanent lockout), registration, password changes, holds, uploads and chat messages.
- **Cross-site requests.** Every state-changing request must come from the app's own
  origin (the `Origin` check), on top of SameSite cookies.
- **Status changes are server-only.** Players can only ask for actions (reserve, upload,
  release, cancel). The server checks ownership, role and the current status inside one
  database batch.
- **No double booking.** Each hold is a single atomic `INSERT … WHERE NOT EXISTS
  (overlap)`, backed by a partial unique index.
- **Payment screenshots:**
  - File type is checked from the file's bytes (JPG, PNG or WEBP only), up to 10 MB.
  - Before storing, the image is rebuilt from only the parts needed to draw it. EXIF
    (GPS, camera), XMP, text chunks, C2PA content credentials, comments, embedded
    thumbnails and anything appended after the image are removed. The same applies to
    the GCash QR that staff upload.
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
                        admin-settings.ts (admin only), facilities.ts (courts, hours, closures),
                        revenue.ts (admin only: revenue summary, ledger, CSV)
  lib/                  bookings, payments, availability, facility, chat, notify, images, auth, …
migrations/             D1 schema
db/                     facility.sql (courts/tables), seed.dev.sql + demo images (local only)
scripts/                reset-local-db.mjs, create-admin.mjs
tests/smoke.mjs         end-to-end API checks
specs/                  technical design
```

## Not in this version

Tournaments, user and staff account management screens (accounts are created with
`npm run create-admin`, and membership is still confirmed in the database), moving a booking
to another court or time, a real SMS provider, push notifications, live WebSocket chat
(the app refreshes every 10–15 seconds instead), and recording refunds (the revenue page
reports cancelled-after-payment bookings separately because a refund can't be recorded yet).
