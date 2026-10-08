# Le Spinners — Design Memory

The design reference for the Le Spinners Recreational Hub PWA. Everything here is
taken from the mock PDFs in [design_mock_pdf/](design_mock_pdf/). This is the
**initial** design concept. New features will add to it, so treat this file as a
living document (see [Extending the design](#extending-the-design-new-features)).

- Exact token values live in [public/css/app.css](public/css/app.css). If this file and the CSS disagree, the CSS wins for values and this file wins for intent.
- Behaviour and requirements (EARS) live in [specs/core-flow_design.md](specs/core-flow_design.md).

---

## 1. Source files

| PDF | Covers | Canvas screens |
|---|---|---|
| `le_spinners_overview.pdf` | Product pitch, core journey, booking status model, visibility/privacy, notification matrix | — |
| `le_spinners_pwa_uiux.pdf` | Same canvas cover as the overview (index of boards) | — |
| `le_spinners_design_system.pdf` | DS01–DS07: brand & color, type, status system, controls, booking components, feedback & overlays, layout/motion/PWA | 7 boards + 3 components |
| `le_spsinners_user_signin.pdf` | Sign in, sign up, home (mobile + desktop), 5-step booking wizard (mobile + desktop) | 1–8 |
| `le_spinners_payment.pdf` | Payment screen, GCash QR sheet, countdown states, proof upload, submitted, verifying, expired, rejected, confirmed | 9, 25–33 |
| `le_spinners_booking.pdf` | My bookings, booking details, cancel dialog, booking chat, notifications, notification detail, profile | 10–12, 34–36 |
| `le_spinners_admin_desktop.pdf` | Staff sign in, dashboard, notifications + alert channels, verification queue + review + approve/reject dialogs, bookings table + details, messages, resources (list/add/edit), availability, calendar, users (list/profile), settings | 13–24, 37–44 |
| `le_spinners_admin_mobile.pdf` | Key staff flows on a phone: sign in, home, verify list, review, bookings + filter sheet, messages, chat, availability, calendar, more menu, notifications | — |
| `le_spinners_status_and_errors.pdf` | Empty, no availability, maintenance, booking created, cancelled, slot taken (409), offline, loading, session expired, time already started, unsupported file, "booking opens soon", admin setup checklist | — |

(The sign-in PDF filename has a typo, `spsinners`. Keep it unless the user renames it.)

---

## 2. Product in one paragraph

A mobile-first PWA for booking **pickleball courts** and **table tennis tables**.
Members and non-members book any open slots on one court or table that day (back to back or with gaps,
no limit; price × slots), pay by **GCash** (number or QR), upload a
screenshot as **proof**, and chat with staff in a **per-booking thread**. Staff verify
payments, manage schedules and resources, and keep the hub running from the
**Staff Console** (desktop and phone).

**Core journey:** Book → Pay (10-minute hold) → Submit proof → Staff verifies → Confirmed.

**Personas used in mocks:** Juan Dela Cruz (player, member, on his phone) and Ana Reyes
(staff/Administrator, on desktop or phone). Other sample players: Maria Santos, Pedro Cruz
(non-member), Bea Villanueva, Liza Mendoza, Carlo Garcia, Kim Aquino (membership pending), Grace Tan, Rhea Lim.

**Sample facility:** 3 pickleball courts and 3 table tennis tables. Court 3 is in maintenance
("Resurfacing · back Sat, Oct 3"). Sample prices per hour: pickleball 500 for members and 600 for
non-members; table tennis 250 for members and 300 for non-members. Prices are set in Settings.
Booking reference format: `LS-YYYYMMDD-NNN` (e.g. `LS-20261002-001`). Member ID format:
`LS-M-0142`. GCash number `0917 123 4567`, account "Le Spinners Recreational Hub".

---

## 3. Design principles (cross-cutting rules)

1. **Server owns status and time.** The app sends actions (reserve, upload proof, release, cancel, approve, reject). The server checks the current status and the user's role, changes the status, and logs it. The API returns `expiresAt`. The app only counts down to it, re-syncs on focus, and never resets the timer.
2. **Honest payment words.** An upload is "Payment proof submitted", never "Payment received". Only staff approval shows "Payment verified".
3. **Privacy by default.** Other players never see names, amounts, proofs or payment details. A slot shows only Available / On hold / Unavailable / Booked / Maintenance.
4. **Every status is an icon + a word + a color family.** The status must still read correctly in grayscale.
5. **One primary button per screen.**
6. **Nobody is left on a blank screen.** Every empty, loading and error state says what happened and offers the next step.
7. **Never fake success offline.** Actions that need the network are disabled and show the reason. They are never silently queued: "a booking must never look made when it wasn't."
8. **Calm urgency.** The countdown stays blue until 2:00, then turns amber with one sentence. No red, no flashing.
9. **Everything staff decide is logged** with their name and time: approvals, rejections, cancellations, blocks, settings changes.
10. **Each component exists once** and is reused across the player app and the staff console.

---

## 4. Brand & color (DS01)

Court Blue carries action and selection. Volt marks what is open or confirmed. Everything
else stays calm so status reads instantly.

| Token | Hex | Use |
|---|---|---|
| `--blue-600` Court Blue | `#2350E0` | Primary buttons, selection, links (6.4:1) |
| `--blue-700` | `#1A3DB8` | Hover, pressed, text on blue tint |
| `--blue-50` | `#EBF0FF` | Active tab pill, info tint |
| `--volt-400` Volt | `#C9F24D` | Open & confirmed fills, brand accent |
| `--volt-100` | `#E9F8BE` | Confirmed badge, available tint |
| `--volt-800` | `#335C00` | "Available" text & icons on white |
| `--ink-900` | `#0D1626` | Text, dark surfaces |
| `--ink-700` | `#2C3648` | Body text |
| `--ink-500` | `#5A6376` | Captions |
| `--ink-400` | `#7C8494` | Icons only (UI 5.4:1) |
| `--line-strong` | `#CFCCC0` | Input borders |
| `--line` | `#E3E1D9` | Dividers |
| `--chalk` | `#F5F4EE` | App background |
| white | `#FFFFFF` | Cards, sheets |
| placeholder | `#6B7383` | Input placeholder |

**Status families**

- **Amber** means *you need to act*: temporary hold, countdown warning, slot on hold.
- **Violet** means *staff are reviewing*: payment verification, proof submitted.
- **Volt** means *good to go*: available slot, confirmed booking, success.
- **Red** means *something went wrong*: proof rejected, errors, destructive actions, unread count.
- **Neutral** means *closed or finished*: booked, unavailable, maintenance (hatched), expired, cancelled.
- **Blue info tint, dashed edge** means *open play*: the court or table is in service and free for all, but can't be booked (`users` icon).

**Logos:** "Le Spinners / RECREATIONAL HUB" for players and "Le Spinners / STAFF CONSOLE" for staff.
App icons: 512, 192 and maskable. Keep the ball inside the 80% safe circle.

---

## 5. Typography (DS02)

| Role | Font | Size (mobile → desktop) |
|---|---|---|
| Display | Bricolage Grotesque 800 | 40/44 → 56/60, −2.5% |
| H1 | Bricolage 800 | 28/34 → 36/42, −2% |
| H2 | Bricolage 700 | 22/28 → 26/32, −1% |
| H3 | Figtree 800 | 18/24 → 20/26 |
| Body | Figtree 400/500 | 16/24 (never below 14) |
| Body small / field label | Figtree 500 | 14/20 (meta, helper text) |
| Caption / overline / badge | Figtree 800 caps +12% | 12/16 (overlines and badges only) |
| Buttons / labels | Figtree 700 / 600 | 17/20 buttons, 15/20 labels |
| Numeric (timers, refs) | JetBrains Mono 700 | 32–40 timer, 15–18 codes |

- Use `font-variant-numeric: tabular-nums` on slots, prices and tables so columns never jitter.
- Nothing interactive is smaller than 15px. Captions are for overlines and badges, never sentences.
- Fallback stack: `Figtree, system-ui, -apple-system, 'Segoe UI', sans-serif`.

---

## 6. Status system (DS03)

### Booking statuses (7)

| API value | Badge label | Family | Meaning / next |
|---|---|---|---|
| `TEMPORARY` | TEMPORARY HOLD | Amber | Held 10:00 while the player pays. Next: proof uploaded, or it expires. |
| `PAYMENT_SUBMITTED` | PAYMENT VERIFICATION | Violet | Proof is in and the timer stops. Next: staff approve or reject. |
| `CONFIRMED` | CONFIRMED | Volt | Staff verified the payment. |
| `REJECTED` | PROOF REJECTED | Red | Reason given. 10-minute resubmit window, then it expires. |
| `EXPIRED` | EXPIRED | Neutral | No proof in time. Slot released. Final. |
| `CANCELLED` | CANCELLED | Neutral | A hold the player released, or a booking Le Spinners cancelled (**Cancel & credit** or a disruption; paid bookings get a booking credit). Players never cancel. Slot released. Final. |
| `COMPLETED` | COMPLETED | Neutral | The booked hour is over. Shown under Past. Final. |

**Booked by** (built 2026-10-01, staff only): every booking records its author — `online` (player app) or made in a console by `staff` / `admin` (with the name). Shown as a sub-line under the reference in the Bookings list and a "Booked by" row on booking details. Console bookings skip `TEMPORARY`/`PAYMENT_SUBMITTED` and start `CONFIRMED`; payment method `on_site` (revenue, ledger method "Paid on site") or `none` (no charge, not in the ledger). Players still see only "Booked".
Console bookings also record the **booker's name** (required "Name" field, built 2026-10-02, `bookings.booker_name`, migration `0008_booker_name.sql`). It is a reference only: the booking still belongs to the staff account. Staff see it as the customer wherever the booking is listed (Bookings list with "Member rate" / "Non-member rate" under it, booking details Customer card, calendar and New booking slot names, dashboard today list, Revenue ledger with "On site · staff name" under it and the CSV "Customer" column, disruption and affected-bookings lists), and Bookings and Revenue search match it.

**Transitions:** reserve → `TEMPORARY` → (proof uploaded) `PAYMENT_SUBMITTED` → (staff approve)
`CONFIRMED` → (hour is over) `COMPLETED`. `TEMPORARY` goes to `EXPIRED` after 10 min with no proof,
or the player can release it. `PAYMENT_SUBMITTED` goes to `REJECTED` when staff reject. `REJECTED`
goes back to `PAYMENT_SUBMITTED` with new proof, or to `EXPIRED` after 10 min. `CONFIRMED` goes to
`CANCELLED` when Le Spinners cancels it (Cancel & credit, or a disruption), with a booking credit for the value paid.
A booking already under way when play stops stays `CONFIRMED` and gets credit for the time that couldn't be played
(REBOOKING.md).
Arrow colours on the diagram: player action, staff action, automatic (timer/clock).

### What other players see

| Booking status | Others see |
|---|---|
| TEMPORARY, REJECTED | On hold · may reopen |
| PAYMENT_SUBMITTED | Unavailable |
| CONFIRMED | Booked |
| EXPIRED, CANCELLED | Available |

### Slot states (time picker)

AVAILABLE · SELECTED · ON HOLD · MAY REOPEN · BOOKED · UNAVAILABLE · MAINTENANCE (hatched) · OPEN PLAY (blue, dashed).
They must stay readable in grayscale through icon + word + pattern.

| Slot state | Admin | Booking owner | Other players |
|---|---|---|---|
| AVAILABLE | Available | — | Available · bookable |
| TEMPORARILY_HELD | Held · 07:12 · Juan D. | Your hold · 07:12 left | On hold · may reopen |
| PAYMENT_VERIFICATION | Verifying · Juan D. · 500 | Yours · payment verification | Unavailable |
| BOOKED | Booked · Juan D. | Yours · confirmed | Booked |
| UNAVAILABLE | Closed by schedule | — | Unavailable |

Admin calendar adds **Blocked / BOOKED BY STAFF**.

### Other tags

- **Membership:** MEMBER · NON-MEMBER · MEMBERSHIP PENDING
- **Resource:** ACTIVE · OPEN PLAY · MAINTENANCE · DISABLED. Open play (API status `open_play`, stored as
  `status = 'active'` + `open_play = 1`, migration `0006_open_play.sql`): players see the court or table in the
  booking flow and on Home marked OPEN PLAY ("Open for all. Just come and play"), every slot has state
  `open_play`, and a hold is refused with `422 OPEN_PLAY`. Staff and admins switch it from Resources
  (Open play / End open play buttons, or the status select in Edit); like maintenance, it lists affected
  bookings first and keeps them.
- **Booking credit:** AVAILABLE (volt) · PARTLY USED (blue) · USED · REFUNDED · EXPIRED (neutral) · VOIDED (neutral in
  the player app, red in the consoles). Gift icon, blue tile. Always called "booking credit", never "refund".
- **Disruption category:** WEATHER · UNSAFE CONDITIONS · MAINTENANCE · EQUIPMENT FAILURE · EMERGENCY · FACILITY ERROR ·
  CUSTOMER REQUEST (admin only) · OTHER, as amber pills; a `calendar-x` icon marks disruptions.
- **User account:** ACTIVE · DISABLED
- **Payment check:** AMOUNT MATCHES · AMOUNT DIFFERS (plus NO REF. NO.)

---

## 7. Visibility, privacy & server rules

| Information | Player (own bookings) | Other players | Staff |
|---|---|---|---|
| Slot status | Full, e.g. TEMPORARY HOLD · 07:12 left | Available, On hold, Unavailable, Booked, Maintenance, Open play | Every status, with names |
| Who booked | Only their own name | Never | Yes |
| Payment screenshot | Their own, in the app | Never | Yes, through a signed link that expires in 5 min |
| GCash ref & amount | What they typed | Never | Yes, next to the amount due |
| Booking chat | One thread per own booking | Never | All threads, each tied to its booking |
| Phone & email | Their own | Never | Yes |
| Booking credit | Their own credits and history ("Le Spinners" as the actor) | Never | Every credit, with staff names and internal notes |
| Can change | Reserve, upload proof, release an unpaid hold, rebook with credit. Never cancel a booking | Nothing | Approve, reject with reason, cancel holds, cancel & credit paid bookings, record disruptions, block slots; admins also issue, void and refund credits (all logged) |

**Server rules (Workers + Hono + D1)**
1. Check ownership on every request. Hiding something in the UI is not enough.
2. Proofs live in private storage (R2) with no public URLs. Links are signed and expire in 5 min. Strip location data on upload.
3. Status changes happen only on the server.
4. Staff-only API routes sit behind a staff-role check in Hono middleware. Admin screens are never linked from the player app.
5. Public availability is anonymous and returns slot states only.
6. Use the honest payment words from section 3.
7. Keep an audit log of approvals, rejections, cancellations and blocks, with the staff name and time.

---

## 8. Notifications matrix

| Event | Player in-app | Player email | Staff in-app (bell) | Staff email | Staff SMS |
|---|---|---|---|---|---|
| Booking created / slot held | "Pay within 10 min" | — | New booking | — | — |
| Hold has 2 min left | "Will expire soon" | — | Hold expiring | — | — |
| Payment proof submitted | "Waiting for admin verification" | — | Needs verification | Yes, with Review Booking link | Queued until a provider is set |
| Payment verified | "Booking confirmed" | Yes, with ticket | — | — | — |
| Proof rejected | Reason + resubmit link | Yes, with reason | — | — | — |
| Booking expired | "Booking expired" | — | — | — | — |
| New chat message | Unread badge | — | Unread badge | — | — |
| Booking cancelled (hold, by staff) | "Booking cancelled" | Yes | Cancelled | Yes | — |
| Cancelled by Le Spinners (disruption) | "Booking cancelled by Le Spinners" + reason + credit (+ chat system message) | Yes, with Rebook link | One summary per disruption (unresolved while bookings need follow-up) | — | — |
| Part of a booking credited | "Part of your booking couldn't go ahead" + credit | Yes | In the summary | — | — |
| Booking time closed, proof waiting | "Your booking time is closed" · credit follows verification | — | Disruption follow-up | — | — |
| Booked with booking credit | "Booking confirmed" · paid with credit | Yes | New booking · paid with credit (resolved) | — | — |
| Credit returned / changed by an admin | "Your booking credit is back" / what changed and why | — / Yes | — | — | — |

- Staff email subject: **"Le Spinners — Booking Requires Payment Verification"**, sent from "Le Spinners Staff Console". The screenshot is never attached; it opens only inside the console.
- SMS: sender "LeSpinners". Keep it GSM-7 and one segment of 160 characters or less. Use a plain hyphen ("6-7 PM"), because an en dash or emoji switches the message to UCS-2 (70 chars). With no provider connected, every SMS is written to an outbox with status `QUEUED`.
- Staff console toast: slides in bottom-right on every page and stays until acted on. The sidebar badge and bell count update live.
- Default staff alert channels (Settings): proof submitted is on for App, Email and SMS. Temporary booking created, new message and window expiring are App only. Booking cancelled is on for App and Email.
- Player notifications never mention other players. Staff notifications link straight to the booking.

---

## 9. Controls (DS04)

- Touch targets are at least 44×44. Inputs use 16px text so iOS never zooms.
- **Buttons:** Primary, Secondary, Tertiary, Destructive and On-color, each with default, hover, pressed, focus, disabled and loading states ("Reserving…", "Saving…"). Destructive comes in two forms: solid is the final decision inside a dialog, outline is the entry point. Links in text use the same blue, underlined.
- **Sizes:** L 56 (mobile sticky CTA), M 48–52, S 40 (desktop tables only). Icon buttons are 44×44 and need an `aria-label`.
- **Inputs:** default, focus (blue border + 4px halo), error with helper text, disabled (chalk fill). Phone inputs have a `+63` prefix. Password shows "At least 8 characters". Pill search is used in admin lists.
- **Dropdown:** opens a menu on desktop and a bottom sheet on mobile.
- **Selection & navigation:** segmented tabs for the player app (Upcoming · 3 / Past / Cancelled), underline tabs for admin desktop (Pending · 3 / Approved today / Rejected), filter chips, toggles (Email alerts / SMS alerts), and a booking progress stepper (Activity → Date → Time → Pay).

---

## 10. Booking components (DS05)

Each exists once and is reused:

- **Activity card:** "Pickleball · Book a court · 3 courts · 500/hr" / "Table tennis · Book a table · 3 tables · 250/hr", with an "N open today" overline.
- **Date carousel item:** day + date + Open / Few left / Full / Closed. **Calendar** (month grid) uses the same legend. Grey dates aren't open yet. Bookings open 14 days ahead.
- **Resource card:** name, status, hours ("Open 4:00 PM – 11:00 PM"), availability bar. States include FULLY BOOKED with "Next open: …" and MAINTENANCE with a reason and back-on date.
- **Booking card:** activity overline, status badge, resource, date/time, "View details". Bookings that need action show the countdown and a "Pay now" CTA.
- **Booking ticket:** activity · resource, full date, time, BOOKING REFERENCE in mono, "Payment verified · 500". Shown at the front desk.
- **Booking timeline:** Booking created → Payment proof submitted → Admin verification ("Waiting · we'll notify you") → Booking confirmed, with timestamps.
- **Notification row:** title, context line, status badge, relative time.
- **Payment countdown:** PAYMENT WINDOW 09:42 · "Slot held until 4:12 PM". At 2:00 it becomes EXPIRING SOON 01:48 (amber), and at 0:00 it shows WINDOW CLOSED · Slot released.
- **Payment proof upload:** empty ("JPG, PNG or WEBP · up to 10 MB", "Choose screenshot"), uploading (64%, "Keep this screen open"), ready ("1.2 MB · ready to submit", Replace / Remove), and error (HEIC not supported → "Choose another file").
- **Booking chat:** system events inline ("Payment proof submitted · 4:07 PM"), staff bubbles signed "Le Spinners · Ana", read receipts ("Seen" / "Sent" / "New"), proof thumbnail card, and the header "Private · you & staff". Typed messages (player and staff) are capped at **120 characters**: every composer shows a live `n/120` under the text box, right-aligned in ink-500, which turns red-700 and bold at 120 while typing stops there; screen readers hear "Limit reached" once. The server enforces the same cap. Staff approve/reject notes posted into the chat are not typed in a composer and keep their own longer cap.

---

## 11. Feedback & overlays (DS06)

- **Confirmation dialog:** radius 24, focus trapped. Esc or the scrim closes it, except while submitting. A destructive action states its consequence.
- **Bottom sheet:** top radius 28, grab handle, swipe down to close, primary action pinned above the safe area (e.g. filter sheet → "Show 3 bookings").
- **Toasts:** ink toast above the tab bar, 16px from the edges. Info toasts last 4s. Errors stay until dismissed or retried. Announced via `role="status"` / `role="alert"`. Toasts that stay until acted on (errors, "New payment proof to verify") have a ✕ ("Dismiss") after the action, and on touch screens a sideways swipe past a third of the width dismisses them (a short swipe snaps back).
- **Inline banners:** info (not confirmed until verified), warning (expiring), error (rejected with the reason quoted), success (verified), offline.
- **Empty state:** icon, title, explanation, CTA.
- **Loading:** "Checking live availability…" with skeletons that match the real row height.
- **Error state:** "Can't load availability" + reassurance ("Nothing was booked. Your selection is saved on this device.") + Try again.
- **Session expired:** "Please log in again" + Log in.

---

## 12. Layout, motion & PWA (DS07)

**Spacing (4pt grid):** 4 icon-label · 8 chips / tight stacks · 12 list rows · 16 card padding · 20 mobile screen margin · 24 section gap (mobile) · 32 section gap (desktop) · 56 page padding (desktop).

**Radii:** 12 icon buttons · 14 inputs · 16 buttons · 20 cards · 24 dialogs · 28 sheet tops · pill for chips and badges.
(app.css currently uses `--r-card: 22px` and adds `--r-tile: 18px`. Check this if you touch cards.)

**Elevation:** card (border only) · raised (hover) · overlay.

**Breakpoints**
- Phone 360–599: 4 columns, 20 margin, bottom tab bar, sheets, cards instead of tables.
- Tablet 600–1023: 8 columns, 32 margin, two-pane booking (resources + times).
- Desktop 1024+: 12 columns, 1200 max content, admin sidebar 248, tables.

**Motion**

| Interaction | Spec |
|---|---|
| Press | 90ms, scale .97, ease-out |
| Hover | 160ms |
| Select slot | 180ms, lift −2px + raised shadow (pointer devices only) |
| Page | 240ms. Forward slides 24px + fades; back reverses. |
| Sheet | 280ms, rises from bottom, `cubic-bezier(.32,.72,0,1)` |
| Success | 600ms: fill to blue, check pops. Outer ring 0→1 (240ms), inner volt disc, check stroke-dashoffset draw (360ms). Draws once, no confetti. |
| Countdown | 1s ticks, linear. Turns amber at 2:00, never flashes. |
| Reduced motion | `prefers-reduced-motion`: fades only, no slides or pops |

**Safe areas:** `viewport-fit=cover`. Header gets `padding-top: env(safe-area-inset-top) + 12px`, with no painted status bar. Tab bar and sticky CTAs get `padding-bottom: max(16px, env(safe-area-inset-bottom))`. Landscape adds left/right insets.

**PWA**
- Splash: logo on brand.
- Install prompt ("Install Le Spinners · Book from your home screen") appears after the first completed booking, never on the first visit. iOS shows Share → Add to Home Screen steps instead.
- **Works offline (cached):** app shell & navigation, Home (last synced), My bookings, Booking details & ticket, Facility info, Profile. Cached screens show "Last updated 4:05 PM".
- **Needs internet (network-only):** live availability, reserving a slot, payment proof upload, sending chat, all admin actions. These are disabled with a reason and never queued.
- **App update:** "A new version is ready · Refresh". The service worker waits and never reloads mid-payment or while a chat message is unsent.
- Icon files: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png`.

**Navigation**
- Player tab bar: Home · Bookings · **Book** (center) · Alerts (badge) · Profile. The desktop player header has Home / Book / My bookings + avatar.
- Staff mobile tab bar: Home · Bookings · **Verify** (badge) · Messages (badge) · More.
- Staff desktop sidebar (248px, dark ink): Dashboard; **OPERATIONS** Payment verification (badge), Bookings, Messages (badge), Notifications (badge); **FACILITY** Resources, Availability, Calendar; **ADMIN** Users, Settings. The current user (avatar, name, role) sits at the bottom. The admin console adds **Revenue** right below Dashboard (built 2026-10-01; on phones it is under More → Reports).
- **Consoles by role (built 2026-10-01).** The mocks show one staff console; it is built as two
  consoles from the same screens: the **staff console** at `/staff/` (sidebar label
  "STAFF CONSOLE", no ADMIN group) and the **admin console** at `/admin/` (label
  "ADMIN CONSOLE", with Settings). Each has its own sign-in page using the staff sign-in layout,
  with copy naming the role and a link to the other console's sign-in. The name and role at the
  bottom of the sidebar open the user's own profile.

---

## 13. Screen inventory

### Player app

| Screen | Key content |
|---|---|
| Public landing page (built 2026-10-04) | Visitors at `/`, all roles at `/welcome`. Court Blue hero with court/paddle artwork and Volt booking CTA; sports with configured member/non-member rates; public Court Calendar; booking steps; chat, updates and credits; facility address and regular hours; FAQs; staff/admin links in the footer. Signed-in players keep their dashboard at `/`. Responsive desktop navigation and mobile booking CTA. |
| Public Court Calendar (built 2026-10-04) | Date strip and date picker bounded by the configured booking window, sport and court/table filters, resource cards with labeled time slots. Available times lead through login/registration to the selected booking review. Public `GET /api/facility/calendar` returns only allowlisted resource and slot fields, identical for visitors and signed-in roles; no booking IDs, names, references, payment data, maintenance notes, or closure reasons. Refresh every 30 seconds while visible and on focus. Stale times disappear after a failed refresh or offline event, with Retry. Browsing never holds a slot. |
| Sign in | "Welcome back". Email or mobile number + password, Forgot password?, "Keep me logged in on this device", Create an account. "Members and non-members use the same app." |
| Sign up | Full name, email, mobile (+63, "Never shown to other players"), password with strength hint, member toggle (Not yet / I'm a member) + member code ("Membership pending" until staff confirm; non-member rates apply), agree to house rules |
| Home (mobile) | Greeting + date, MEMBER chip "Member rates apply", Book a court (activity tiles with N open today), Upcoming booking card (Chat / View booking), Available today (live list with on-hold markers, maintenance row), Recent history, facility card (OPEN NOW, hours, address, resource count) |
| Home (desktop) | Same content, with "Available today" as a resource × hour grid (Book / Booked / On hold / Maintenance) |
| Booking wizard (mobile) | Step 1 Activity → 2 Date (carousel or Calendar view) → 3 Court/Table (cards with availability bars) → 4 Time ("Choose your times · Tap as many open times as you like. They don't have to be back to back."; 1-hour slots are checkboxes: tap to pick, tap again to drop, **Clear** in the title row; picked slots are solid blue "Selected"; no length control and no limit; sticky summary: back-to-back picks merge into one range, up to two ranges are listed ("4:00 – 6:00 PM, 7:00 – 8:00 PM · 3 hours"), more show "N times · N hours"; price `₱500 × 3` → total; picks someone else takes meanwhile are dropped with a toast) → 5 Review (Time/Times row with one range per line, Duration "3 hours · 3 slots", "3 × ₱500 member rate", **Reserve & pay** total, Change booking keeps the picks) (built 2026-10-02) |
| Booking wizard (desktop) | Single page: stepper, date carousel, courts list + times grid, sticky "YOUR BOOKING" summary card with Reserve & pay |
| Booking created | "Court 2 is held for you", 09:56 left to pay, TEMPORARY HOLD summary, mini stepper Held → Pay & upload → Staff verify → Confirmed, Continue to payment, Release this slot |
| Payment | Countdown bar, PAYMENT REQUIRED amount, "How to pay" 1-2-3, GCash info (account name, number + Copy, QR + Save QR / Full screen), amount-match reminder, proof upload, optional GCash ref + amount paid, "not confirmed until verified" banner, Submit payment proof, privacy line, chat link |
| GCash QR sheet | Full-screen QR, copy number, "Paying on this phone?" steps, Save QR image, "I've paid — upload proof" |
| Proof submitted | "Waiting for admin verification", status now PAYMENT VERIFICATION, "The 10-minute timer has stopped", View booking / Open chat / Back to home |
| Booking details (verifying) | Status banner, progress timeline, YOUR PAYMENT PROOF (private) summary, booking chat preview |
| Proof rejected | Reason quoted with staff + time, RESUBMIT WINDOW countdown, Submit new proof, Open chat, timeline |
| Booking expired | "Your hold on Court 2 ended", EXPIRED card, "Book another time", "Already paid but ran out of time? Send your screenshot in the booking chat." |
| Booking confirmed | Success animation, ticket with reference, "Show this reference at the front desk" |
| My bookings | Tabs Upcoming / Past / Cancelled. Sections ACTION NEEDED (hold with countdown + Pay now) and COMING UP |
| Booking details (confirmed) | Ticket, progress, booking table (Payment: "₱1,000 · GCash · verified", "paid with booking credit" or "GCash + credit"), customer card, chat preview, "Bookings can't be cancelled in the app" note. Part of it disrupted → "5:00 – 6:00 PM couldn't go ahead · ₱600" credit card. **No cancel button** (the mock's cancel dialog is not built: players never cancel) |
| Booking cancelled by Le Spinners (built 2026-10-02) | Neutral status banner (calendar-x tile, "CANCELLED BY LE SPINNERS", reason, when · category), struck-through booking, Paid line, **Booking credit** card (gift tile, amount or "₱X left", "It isn't a cash refund: it pays for your next booking automatically", **Rebook**, See my booking credits), chat preview. A released hold keeps the plain cancelled view |
| Booking credits (built 2026-10-02, `/credits`) | "AVAILABLE TO SPEND" hero with the total + Book with my credit; Ready to use / Used and past lists (amount, "From LS-… · reason", state pill); "How booking credit works" 1-2-3. Detail `/credits/:id`: amount left of issued, reserved-by-a-hold banner, why/from/issued/expires, Rebook LS-…, History (issued, used for LS-…, returned, refund recorded, voided) |
| Rebook (built 2026-10-02) | The booking wizard with a blue "Rebooking LS-… · your booking credit pays at checkout" banner (Stop) on every step; the time step preselects the original times where open; Review shows Price, Booking credit (Use my credit ✓) and "Nothing to pay" / "To pay by GCash"; button **Book with credit** (confirmed at once) or **Reserve & pay ₱X** (top-up hold) |
| Booking chat | Header with resource/time, reference + status badge, "Private · only you and Le Spinners staff", system events, proof card, composer |
| Notifications | Mark all read, filter All / Bookings / Messages, grouped TODAY / EARLIER |
| Notification detail | Message, booking card, reference, View booking / Open booking chat / Notification settings |
| Profile | Contact, membership card (MEMBER, Active, Member ID, Valid until), Personal information, Membership, Booking history, Account settings, Install the app, Log out |

### Staff console: desktop

| Screen | Key content |
|---|---|
| Staff sign in | Split layout: value prop on the left, form on the right. "Player accounts can't sign in here." Sessions end after 12 h. Every sign-in and payment decision is logged. |
| Dashboard | Greeting, KPIs (new bookings since last check, payment verification pending + oldest wait, unread messages, holds expiring), verification queue preview, today's KPIs (today's bookings, upcoming 7 days, available courts/tables, total users), today's activity timeline with a NOW line, messages preview, resources summary |
| Notifications | Tabs All / Unresolved / Verification / Messages / Bookings. Event cards with channel chips (In-app / Email / SMS queued) and action buttons. Side panel with counts and "How you're alerted" |
| Payment verification queue | Tabs Pending / Approved today / Rejected, sorted oldest first. Rows show customer + membership, booking, amount due vs paid (claimed), MATCHES/DIFFERS, GCash ref, submitted time, Chat, Review. Side panel "Before you approve" checklist + "While pending" note |
| Booking verification (review) | Booking info, "What Juan submitted", proof image viewer (zoom, signed link expires in 5 min, every view logged), CHECKED checklist, conversation preview, Reject payment / Approve payment. **The "Before you approve" checklist is required** (built 2026-10-01): Approve stays disabled until all 4 are ticked ("N of 4 checked"; the decision bar says how many are left; a complete list gets a volt edge). Ticks survive repaints and reset when a new proof arrives. The approve dialog opened from the full-screen viewer without a completed checklist shows the 4 checks itself. The API refuses an approval without `checklist: true` |
| Approve dialog | Summary + optional "post in chat" message + what the player gets |
| Reject dialog | Required reason radio (amount mismatch / unclear proof / ref not found / wrong account / other), message to player, keep slot on hold 10 min for corrected proof |
| Bookings | Tabs All / Needs verification / Temporary / Confirmed / Cancelled & expired, search, date range, Activity/Resource/Status filters, Export CSV, paginated table |
| Booking details | Header with status + Open chat + **Cancel & credit** (paid/confirmed; "verify the payment first" hint while a proof waits) + Cancel hold (unpaid holds) + Issue credit (admins), Disruption and Booking credit panels (built 2026-10-02), timeline ("Verified by Ana Reyes"), payment, customer card (bookings count, no-shows, **Booked by**: "Online · player app" or "Admin · Ana Reyes"), conversation, "Next" to continue verifying. **Booking chat expands in place** (built 2026-10-01): the "Booking chat" card is a toggle (chevron flips); open, the two columns stretch to one height and the chat fills what's left of its column, ending level with the bottom card of the other column (one-line header when open, floor 240px; on phones a fixed `min(70vh, 520px)`); the thread scrolls inside, with quick replies, composer and "Open in Messages". Same card on the payment review page |
| New booking (built 2026-10-01, staff + admin, `/bookings/new`) | Personal booking on site, made under the signed-in staff/admin account. Info banner; activity seg, date, court/table chips, time slots picked like the player app (any open times, gaps allowed; staff see names on taken slots), **Name** (required, the booker's name; "Book & confirm" reads "Enter the booker's name" until it's filled), Rate seg (Member / Non-member), Payment radio (**Paid on site** — counted as revenue / **No charge** — personal use), summary (Booked by "Staff · name" / "Admin · name", Total), **Book & confirm**. Confirmed at once, no GCash proof. "New booking" button on the Bookings list (desktop topbar, "New" on phones) |
| Messages | Conversation list (Verifying / Unread / All) + thread + "THIS BOOKING" side panel with Review payment. Quick replies. One conversation per booking |
| Resources | Tabs All / Pickleball courts / Table tennis tables. Cards with status, weekly hours, today's load, Edit / Availability / Disable / End maintenance |
| Add resource | Type, name, description, Active/Disabled, copy starting schedule from an existing resource |
| Edit resource | Details (type locked once it has bookings), weekly schedule summary, "What players see" preview, status Active / Maintenance (back-on date + reason) / Disabled, danger zone listing affected bookings with Move to … / Cancel & notify |
| Availability | Resource tabs, weekly schedule (per-day ranges, + adds a second range), copy to other resources, slot duration 30/60/90/120, preview, special unavailable dates, maintenance toggle, booking rules summary |
| Availability calendar | Day/Week/Month, mini month, legend with counts, resource × hour grid with names, selected-slot detail bar |
| Users | Tabs All / Members / Non-members, status filter, table (name, email, phone, type, status, registered, View / Disable / Enable), "1 membership request" |
| User profile | Stats (bookings, upcoming, cancelled, expired, holds), contact, membership (member ID, valid until, rate), bookings list, conversations, Send password reset, Disable account |
| Settings | Sections: Booking rules (payment window, expiring-soon warning, resubmit window, bookings open N days ahead, cancel until N hours before, default slot length), GCash payments (account name, number, QR image), Pricing per hour (resource type × member/non-member), Admin alerts (In-app always on, Email, SMS + Connect provider), Facility info (name, address, time zone), Staff accounts. "Changes are logged with your name." |
| Setup checklist (empty facility) | "SET UP BOOKING 1 of 4": add courts/tables → weekly hours & slot length → GCash & prices → open booking to players. "Players see right now: Booking opens soon", Preview player view |
| Affected bookings dialog (built) | Shown before any facility change that touches active bookings: amber alert tile, "This change affects N bookings", list of ref (mono) · resource · date · time · player · status pill (each opens the booking), **Cancel & credit these bookings…** (2026-10-02; the mock's "Cancel & notify") / **Apply change, keep these bookings** / Go back |
| Cancel & credit dialog (built 2026-10-02) | Step 1: category chips, "Reason players see", internal note, "Couldn't be played from" (started bookings), Also close these times, No booking credit (admins). Step 2 preview: totals (Bookings, Credit now, After payment check), one card per booking (ref, player, status, affected time, paid, flags, Cancel all / Keep the rest where allowed, credit), New bookings blocked line, not-affected list; red **Cancel N · ₱X credit**. Step 3: Done, follow-ups, Open the record |
| Disruptions (built 2026-10-02, `/disruptions`) | All / Needs follow-up chips; cards (category pill, "N to finish", scope · date · time, reason, bookings, credited, by whom). **Record a disruption** form: date, where (whole facility / all pickleball / all table tennis / one court or table), From now to closing / All day, From–Until, category, reason, note → preview dialog. Record page: totals, closures, one card per booking with outcome, credit link, Verify payment / Apply now / Review again |
| Booking credits (built 2026-10-02, `/credits`) | Search (player, email, reference), All / Can be spent, rows with player · amount · origin · state. Detail: amount, reserved banner, player, why, from, disruption, issued, History with staff names; admins: Record a cash refund (amount, GCash/cash, reference, note) and Void credit (reason) |
| My profile (built, staff + admin) | Avatar, name, role tag, email, mobile; Personal information and Change password (12+ characters for staff and admins); session note (12 hours) |
| Revenue (built, admin only, `/revenue/`) | Top bar: day, date and time + "Revenue". Four summary cards: Daily (volt tile), Weekly (blue), Monthly (violet), Yearly (amber); calendar icon, uppercase label, navy Bricolage amount `₱28,460.00`, change chip (volt up / red down / neutral "No change") "vs ₱X by this point last week", payment count and range, amber line when verified bookings were cancelled after payment. Note on what counts. **Booking Ledger** panel: search (reference, customer, email, court) + Clear filters; Facility (optgroups per activity), Type, Method, Payment status selects; date period row (7D / 30D / 3M / 1Y chips, Custom + From–To dates; ink chip = active) with the range label "Sep 26 – Oct 2, 2026 · facility time" under it (moved into the ledger 2026-10-02; it only filters the ledger); totals strip (Collected, Pending verification, Cancelled after payment); sortable table (Date & time, Booking ID, User, Facility, Type, Duration, Amount, Payment method, Payment status, action) with short status badges + a detail line; cards with a sort menu below 1024px; pager (Showing 1–10 of N records, Rows 10/25/50, Previous · pages · Next, Page X of Y); Export CSV. Read-only: rows open the booking (or Review for pending proofs) |

### Staff console: mobile

Staff sign in · Home (verification queue, unread/new counts, hold expiring, today's KPIs, Up next, messages) ·
Verify payments list · Payment verification review (with "Before you approve 2 of 4 checked") · Bookings (day strip,
filter chips, NOW line, expandable rows) · Filter bookings sheet · Messages · Chat (quick replies, "Review payment") ·
Availability (maintenance toggle, weekly hours, slot duration, special dates) · Calendar · More menu (Facility, People &
alerts, Settings, Log out) · Notifications (with "How you're alerted").

---

## 14. States & edge cases

| Case | Pattern |
|---|---|
| Revenue: nothing in the period | "No revenue records found for the selected period" + try a longer period / Clear filters. Totals show ₱0.00; a zero baseline shows "+₱X" instead of a percentage |
| Revenue: staff account | "Revenue is for administrators" + Go to the staff console (the API answers 403 too) |
| No upcoming bookings | Empty state + "How booking works" 1-2-3-4 |
| No courts/tables on a date | Explanation (holds may reopen), "One of them is yours" if applicable, nearest open times, Choose another date |
| Resource in maintenance | Reason, back-in-service date, "Staff will message you in that booking's chat to move it" |
| Booking credit changed while booking | Review step reloads the credit, toast "Your booking credit changed. Check the new total, then book again." (`409 CREDIT_CHANGED`); nothing was held or spent |
| Disruption preview went stale | Dialog shows the fresh preview with an amber "Bookings changed since your preview" banner (`409 DISRUPTION_CHANGED`) |
| No credit left | Credits screen shows ₱0, the empty state explains when credit is issued; disrupted bookings show "Book another time" instead of Rebook |
| Slot just taken (409) | "This slot was just taken… Nothing was held or charged." + open times nearby + Continue with … |
| Time already started | "This time has already started", Pick a later time. Reserve & pay is off until it's fixed. |
| Offline | Banner "Showing what was saved at 4:09 PM". Live availability is never shown stale. Saved bookings show "Status as of …" |
| Loading availability | "Checking live availability…" with the reason it's checked live |
| Session expired | "Please sign in again", "Nothing is lost", Use a different account |
| Unsupported file (HEIC) | Explain and suggest taking a screenshot of the GCash receipt instead |
| Booking not open yet | Player home "GETTING READY · Booking opens soon" + while-you-wait tasks |
| Admin with empty facility | Setup checklist (see above) |

---

## 15. Copy & formatting conventions

- Currency: show the bare amount `500` in the UI (the peso sign is rendered by the font/icon in the mocks). Use `500.00` in GCash contexts.
- Dates: `Fri, Oct 2` short, `Friday, October 2, 2026` long. Times: `6:00 – 7:00 PM` (en dash in the UI, plain hyphen in SMS).
- Countdown: `MM:SS` in JetBrains Mono.
- Phone: `0917 123 4567`. Input prefix `+63`.
- Names to other staff: "Juan D." in compact grids, full name elsewhere.
- Tone: plain and reassuring, and states the consequence ("will be released to other players", "Nothing was held or charged").

---

## 16. Implementation status (as of 2026-10-02)

Built: player app ([public/js/player/](public/js/player/)) and the staff and admin consoles, which
share [public/js/admin/](public/js/admin/) (dashboard, verify, bookings, calendar, messages,
notifications, resources, availability, profile, more; settings and revenue in the admin console only).

Revenue ([public/js/admin/screens/revenue.js](public/js/admin/screens/revenue.js), API in
[src/worker/routes/revenue.ts](src/worker/routes/revenue.ts)) has no mock PDF; it follows the
console's existing cards, tiles, chips, tables and pills. Payment status families: Paid (volt),
Pending (violet), Rejected (red), Cancelled after payment (amber, refund not recorded),
Cancelled before verification (neutral).

Resources and Availability are built more simply than the mocks: one weekly schedule for the whole
facility (no per-resource schedules, second ranges, slot-duration picker or "copy to other
resources"); closed dates per day or time range, for the facility or one court; a resource card
with status, upcoming booking count and prices, plus Edit / Maintenance / End maintenance /
Disable. "Move to …" is not built: affected bookings are listed, then kept or cancelled & credited.

Built 2026-10-02 without a mock: **disruptions and booking credits** (REBOOKING.md; migration
`0007_disruptions_credits.sql`): Cancel & credit on booking details, the Disruptions list/form/record, the
console Booking credits screens with admin void and refund records, Cancel & credit in the affected-bookings
dialog, the player's cancelled-by-Le-Spinners view, Booking credits screens, credit banners (Home, My bookings,
Profile row) and Rebook through the wizard with credit at checkout. The player cancel dialog and "Booking cancelled
· By you" screen from the mocks were removed: players never cancel.

Built 2026-10-01/02 without a mock: bookings of several slots with gaps (migration `0005_booking_slots.sql`:
`booking_slots` holds the booked ranges, the `booking_times` view is what overlap checks read; one booking,
one payment, one reference; every time label lists all ranges, e.g. "4:00 – 6:00 PM, 7:00 – 8:00 PM"),
console "New booking" with booked-by tracking (migration `0004_booking_source.sql`), the required approval
checklist, and the in-place booking chat ([public/js/admin/minichat.js](public/js/admin/minichat.js)).
When a picked slot was just taken: one slot → nearby open times; several → the same times on another
court or table, or "Keep the N of your M times still open".
Not built: booking on behalf of a walk-in player (console bookings belong to the staff account and only
record the booker's name), and
console bookings for a slot that has already started.

Designed but **not built yet** (per the README's "Not in this version"): the Users list and
profile screens (including membership approval and staff accounts in Settings), the setup
checklist, a real SMS provider, push notifications, live chat (the app polls instead). Update this
list as features land.

---

## Extending the design (new features)

This is the initial concept and more features will follow. When a new feature or mock is added:

1. Put the new PDF in [design_mock_pdf/](design_mock_pdf/) and add a row to **§1 Source files**.
2. Reuse existing tokens, status families and components (§4–§11) before inventing new ones. If a new status or tag is needed, give it an API value, a badge label, a color family, an icon, and a rule for what other players see (§6).
3. Add any new visibility or notification rules to the tables in §7 and §8.
4. Add the new screens to §13 and their empty/error/offline states to §14.
5. Record the change in the changelog below, and update §16.

Ideas mentioned or implied in the mocks for later: tournaments (README), membership request
approval flow, staff accounts management, SMS provider connection, "Move to …" another court
for affected bookings, booking credit expiry and reminders (policy pending), staff booking for a
walk-in player with their credit, no-show tracking on user profiles, CSV export of the Bookings
list (the revenue ledger has one).

## Changelog

| Date | Change |
|---|---|
| 2026-10-04 | Public landing page and Court Calendar: browse availability before sign-in; preserve the chosen time through login/registration; reuse current booking rules and facility data. Added responsive layout, FAQ, directions, anonymous availability allowlist, and failure/offline states. |
| 2026-10-01 | Initial design memory created from the 9 mock PDFs. |
| 2026-10-02 | Disruptions and booking credits (REBOOKING.md): players never cancel; Le Spinners cancels with **Cancel & credit** or a disruption and issues booking credit; Rebook with credit; Booking credits screens; console Disruptions and Booking credits; Cancel & credit in the affected-bookings dialog (§6, §7, §8, §13, §14, §16). |
| 2026-10-01 | Role-based consoles: separate sign-in pages for players (`/login`), staff (`/staff/login`) and admins (`/admin/login`); the staff console at `/staff/` shares the admin screens without Settings. Added Resources, Availability, the affected-bookings dialog and My profile (§12, §13, §16). |
| 2026-10-01 | Revenue page at `/revenue/` (admin only): summary cards, booking ledger, CSV export (§12, §13, §14, §16). Toasts gain a ✕ and swipe-to-dismiss (§11). |
| 2026-10-02 | Open play: a court or table can be set to OPEN PLAY (free for all, shown to players, not bookable) from Resources by staff and admins. Shown on the player Home, date card, court cards and time step, the console calendar, dashboard, New booking and Settings → Pricing (§4, §6, §7). |
| 2026-10-02 | The time step picks any number of open slots, gaps allowed (replaces "How long?"); the console New booking picks the same way. Open booking chat is compact (one-line header, 240px floor) so it ends level with the other column on the payment review page too. Dialogs now open above the full-screen proof viewer. Free console bookings no longer count as payments on the Revenue cards (§2, §13, §16). |
| 2026-10-02 | Console New booking requires the booker's **Name**; staff see it as the customer on console bookings (Bookings, booking details, calendar, dashboard, Revenue, disruptions) and can search it (§2, §13, §16). |
| 2026-10-01 | Multi-hour bookings (How long? control, price × hours), console New booking (personal bookings on site, paid on site or free), Booked by (online / staff / admin), required "Before you approve" checklist, booking chat expanding in place on booking details and payment review (§2, §6, §13, §16). |
| 2026-10-02 | Chat messages capped at 120 characters with a live `n/120` counter under every composer (red at the limit, typing stops) in the player chat, staff Messages and the booking chat card (§10). |
