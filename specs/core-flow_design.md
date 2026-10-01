# Core flow: book → pay → submit proof → staff verifies → confirmed

This is the technical design for the first implementation pass of the Le Spinners
Recreational Hub PWA. The UI follows the design canvas (tokens, statuses, screens).

## Requirements (EARS)

**Booking and holds**

- When a signed-in player picks an available slot and taps *Reserve & pay*, the
  system shall create a `TEMPORARY` booking that holds the slot for 10 minutes.
- While a slot is held, paid-but-unverified, or confirmed, the system shall refuse
  every other booking of that slot and answer `409 SLOT_TAKEN` with nearby
  alternatives.
- If a `TEMPORARY` booking has no payment proof when its 10 minutes end, the system
  shall set it to `EXPIRED`, release the slot, and notify the player.
- When 2 minutes remain on a hold, the system shall send the player an in-app
  warning once.
- The system shall only accept bookings that start in the future, fall inside
  opening hours, avoid closures and maintenance, sit within 14 days, and don't
  overlap another active booking of the same player.

**Payment proof**

- When the player uploads a JPG, PNG or WEBP screenshot (≤ 10 MB) for a
  `TEMPORARY` booking whose hold is still running, the system shall store it
  privately, set the booking to `PAYMENT_SUBMITTED`, stop the timer, and notify
  staff in-app and queue an email and SMS.
- The system shall never tell the player a payment was received; it shall say
  "Payment proof submitted" and "Waiting for admin verification".

**Verification**

- When staff approve a `PAYMENT_SUBMITTED` booking, the system shall set it to
  `CONFIRMED`, record who approved it and when, and notify the player
  ("Payment verified", "Booking confirmed").
- When staff reject a `PAYMENT_SUBMITTED` booking, the system shall require a
  reason, set it to `REJECTED`, notify the player with the reason, and (if staff
  keep the hold) give the player 10 minutes to submit new proof; otherwise, or
  when that window ends, the booking becomes `EXPIRED`.

**Cancellation and completion**

- The player may release a `TEMPORARY` hold at any time and cancel a `CONFIRMED`
  booking up to 24 hours before it starts; staff may cancel any active booking
  with a reason.
- After the booked hour ends, a `CONFIRMED` booking becomes `COMPLETED`.

**Chat and notifications**

- Each booking has one private conversation between its player and staff.
- Players get in-app notifications for their bookings; staff get a shared
  notification center with unresolved counts.

## Architecture

One Cloudflare Worker serves both the static PWA and the API.

| Layer | Choice |
|---|---|
| Static files | Workers static assets from `public/` (player shell at `/`, staff shell at `/admin/`) |
| API | Hono (TypeScript) under `/api/*` |
| Database | D1 (SQLite), migrations in `migrations/` |
| Files | Private R2 bucket `PROOFS` (payment screenshots, GCash QR) |
| Jobs | Cron trigger every minute: expire holds, send warnings, complete past bookings, flush outbox |
| Frontend | Vanilla ES modules, no build step; history-API router; CSS tokens from the design system |
| Realtime | Polling (10 s chat, 15 s badges) in this pass; Durable Objects + WebSockets later |

Time zone: Asia/Manila (UTC+8, no DST). Booking dates are local `YYYY-MM-DD`
strings with minutes-from-midnight; instants are epoch milliseconds.

Money is stored in centavos.

## Data model

`users`, `sessions`, `rate_limits`, `resources`, `opening_hours`, `closures`,
`bookings`, `booking_events`, `payment_proofs`, `messages`, `message_reads`,
`notifications`, `outbox`, `settings`, `audit_log`. See `migrations/0001_init.sql`.

Double booking is prevented twice:

1. The insert is a single `INSERT … SELECT … WHERE NOT EXISTS (overlap)`
   statement, which D1 runs atomically.
2. A partial unique index on `(resource_id, date, start_min)` for active
   statuses backs it up.

Expired holds are swept in the same batch before the insert, so a stale hold
never blocks a new booking.

## Status machine (server-only)

```
TEMPORARY ──proof──▶ PAYMENT_SUBMITTED ──approve──▶ CONFIRMED ──hour over──▶ COMPLETED
    │                     │                              │
    │ 10 min              │ reject (reason)              │ cancel ≥24 h (player) / staff
    ▼                     ▼                              ▼
 EXPIRED ◀──no proof── REJECTED ──new proof──▶ PAYMENT_SUBMITTED        CANCELLED
    ▲
    └── player releases the hold ──▶ CANCELLED
```

The app only sends actions. Each action checks the current status, the actor's
role and ownership, then changes status inside one batch with its event row.

## What other players see

| Booking status | Slot state for others |
|---|---|
| TEMPORARY, REJECTED (resubmit window) | `held` → "On hold · may reopen" |
| PAYMENT_SUBMITTED | `unavailable` → "Unavailable" |
| CONFIRMED | `booked` → "Booked" |
| EXPIRED, CANCELLED | `available` |

Availability responses never include names, user ids, amounts or proofs.

## Security

- **Auth**: scheme `client_pbkdf2_hmac_v1`. The browser runs PBKDF2-SHA256
  (600 000 iterations, 16-byte random salt) and sends the 32-byte `clientHash`. The Worker
  stores `HMAC-SHA256(PASSWORD_PEPPER, clientHash)` plus the salt, iterations and scheme.
  Sign-in is `POST /api/auth/salt` (a deterministic fake salt for unknown emails), then
  `POST /api/auth/login`. Password change verifies the current clientHash and requires a
  new salt. Sessions are random
  256-bit tokens; only their SHA-256 is stored. The cookie is `HttpOnly; Secure;
  SameSite=Lax`, 30-day sliding expiry.
- **CSRF**: SameSite=Lax plus an `Origin` check on every non-GET request.
- **Authorization**: every booking, proof, message and notification query is
  scoped to the signed-in user unless the role is `staff` or `admin`. Admin
  routes sit behind `requireStaff`; settings writes need `admin`.
- **Validation**: zod schemas on every body and query; the client validates too
  but is never trusted.
- **Uploads**: type checked by magic bytes (not the file name), 10 MB cap. The
  image is rebuilt from an allowlist of the parts needed to draw it (EXIF/GPS,
  XMP, text, C2PA, comments, thumbnails and bytes after the image are dropped).
  Files are stored under random keys in a private bucket and served only to the
  owner or staff through HMAC-signed links that expire in 5–10 minutes, with
  `Cache-Control: private, no-store`.
- **Output encoding**: the frontend renders through an escaping `html` template
  tag; there is no `innerHTML` with raw user input.
- **Headers**: CSP (`script-src 'self'`), `X-Content-Type-Options`,
  `Referrer-Policy`, `frame-ancestors 'none'`, `no-store` on API responses.
- **Rate limits**: sign-in and registration per IP and per email.
- **Audit**: sign-ins, failed sign-ins, approvals, rejections, cancellations and
  settings changes go to `audit_log` / `booking_events` with actor and time.
- **Secrets**: `FILE_SIGNING_SECRET` via `wrangler secret put`; nothing secret is
  committed.

## Implementation plan

- [x] Design (this file)
- [x] Schema, migrations, dev seed, create-admin script
- [x] Worker: middleware, auth, availability, bookings, proofs, chat,
      notifications, admin, cron
- [x] Frontend foundation: tokens, components, router, API client, PWA
- [x] Player screens
- [x] Staff screens
- [x] Smoke tests (API, `tests/smoke.mjs`) and a browser run-through

## Not in this pass

Tournaments and games, resource and schedule editing screens (seeded instead),
user management screens, real email/SMS providers (messages are queued in
`outbox`), push notifications, WebSocket chat.
