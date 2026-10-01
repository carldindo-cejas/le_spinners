# Le Spinners Recreational Hub

A mobile-first booking app (PWA) for pickleball courts and table tennis tables, with a
staff console for GCash payment verification.

- **Player app** at `/`: live availability, a 10-minute temporary hold, GCash payment
  instructions, payment-screenshot upload, booking chat, notifications, profile.
- **Staff console** at `/admin/`: dashboard, payment verification queue (approve or reject
  with a reason), bookings, per-booking chat, notification center, availability calendar
  and settings (GCash details and QR, prices, alert recipients, booking rules).

One Cloudflare Worker serves both apps and the API:

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

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars      # Windows: copy .dev.vars.example .dev.vars
npm run db:reset:local              # local database + demo data + demo screenshots
npm run dev                         # http://localhost:8787  (staff: http://localhost:8787/admin/)
```

Put any long random string in `FILE_SIGNING_SECRET` inside `.dev.vars`. Keep the
`PASSWORD_PEPPER` line from `.dev.vars.example` as it is: the demo accounts' password hashes
are keyed with that development value. After changing demo accounts, rebuild their rows in
`db/seed.dev.sql` with `npm run db:seed:generate`.

`npm run db:reset:local` wipes the local database and loads demo data. Every demo account
uses the password **demo-pass-2026**. They exist only in your local database.

| Who | Email | Notes |
|---|---|---|
| Player (member) | juan.delacruz@example.com | has a confirmed booking |
| Player (member) | maria.santos@example.com | proof waiting for verification |
| Player (non-member) | pedro.cruz@example.com | proof waiting, amount differs |
| Player (membership pending) | kim.aquino@example.com | confirmed booking tomorrow |
| Admin | ana.reyes@lespinners.example | staff console |

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
npm run test:smoke        # about 140 checks: holds, double booking, uploads, privacy, approve/reject, expiry, chat…
```

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
   Use `--role staff` for front-desk accounts that can verify payments but can't change settings.
9. Sign in at `/admin/` → **Settings**. Set the GCash account name and number, upload the
   GCash QR, add alert email addresses and the facility address, and check the prices.

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
  changes and proof views go to `audit_log`, with the booking history in `booking_events`.

## Project layout

```
public/                 static PWA (player app at /, staff console at /admin/)
  css/                  design tokens + components (app.css), player.css, admin.css
  js/core/              templating, API client, router, formatting, icons, UI helpers
  js/player/            player app screens
  js/admin/             staff console screens
  sw.js, manifest       offline shell (API calls are never cached)
src/worker/             Hono API (TypeScript)
  routes/               auth, facility/availability, bookings, notifications/files, admin
  lib/                  bookings, payments, availability, chat, notify, images, auth, …
migrations/             D1 schema
db/                     facility.sql (courts/tables), seed.dev.sql + demo images (local only)
scripts/                reset-local-db.mjs, create-admin.mjs
tests/smoke.mjs         end-to-end API checks
specs/                  technical design
```

## Not in this version

Tournaments, editing courts/tables and weekly hours in the console (they are set in
`db/facility.sql` and the `opening_hours` table), user management screens, a real SMS
provider, push notifications, and live WebSocket chat (the app refreshes every 10–15
seconds instead).
