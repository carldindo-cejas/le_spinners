import { html, listen } from '../core/dom.js';
import { icon } from '../core/icons.js';

/**
 * Rebooking after Le Spinners cancelled a booking (REBOOKING.md §12): the booking wizard remembers
 * which booking is being replaced, preselects its times, and the review step applies the player's
 * booking credit. Kept for this tab only; booking works the same without it.
 */
const KEY = 'ls_rebook';
const MAX_AGE_MS = 2 * 60 * 60_000;

/** ctx: { bookingId, ref, activity, resourceId, starts: [minutes], creditLabel } */
export function startRebook(ctx) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...ctx, at: Date.now() }));
  } catch {
    /* storage blocked: the wizard still works, just without the reminder */
  }
}

/**
 * Starts rebooking a booking (a DTO from /api/bookings/:id): same activity, its times as slot
 * starts (4–6 PM with 60-minute slots → 4 PM and 5 PM). Returns where the wizard starts.
 */
export function rebookFromBooking(b, slotMinutes) {
  const starts = (b.segments || []).flatMap((s) => {
    const out = [];
    for (let t = s.start; t + slotMinutes <= s.end; t += slotMinutes) out.push(t);
    return out;
  });
  startRebook({ bookingId: b.id, ref: b.ref, activity: b.activity, resourceId: b.resource.id, starts, creditLabel: b.creditIssuedLabel });
  return `/book/${b.activity}`;
}

export function rebookContext(activity) {
  try {
    const ctx = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (!ctx || Date.now() - ctx.at > MAX_AGE_MS) return null;
    if (activity && ctx.activity !== activity) return null;
    return ctx;
  } catch {
    return null;
  }
}

export function endRebook() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

/** Reminder at the top of each booking step. Wire `[data-act="end-rebook"]` with wireRebookBanner. */
export function rebookBanner(ctx) {
  if (!ctx) return '';
  return html`<p class="banner info compact rebook-banner" data-rebook>${icon('gift', 18, 2.2)}<span class="grow">Rebooking <b class="mono">${ctx.ref}</b> · your booking credit pays at checkout</span><button type="button" class="btn btn-text btn-xs" data-act="end-rebook">Stop</button></p>`;
}

export function wireRebookBanner(root) {
  listen(root.querySelector('[data-act="end-rebook"]'), 'click', () => {
    endRebook();
    root.querySelector('[data-rebook]')?.remove();
  });
}
