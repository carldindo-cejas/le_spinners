import { html } from '../core/dom.js';
import { icon, resourceGlyph } from '../core/icons.js';
import { dateLabel, isoDate, peso, rangeLabel } from '../core/format.js';
import { ringSvg, startCountdown, statusPill } from '../core/ui.js';

export const HOLDING = new Set(['TEMPORARY', 'REJECTED']);
export const ACTIVE = new Set(['TEMPORARY', 'REJECTED', 'PAYMENT_SUBMITTED', 'CONFIRMED']);

/** Where a booking card or notification should take the player. */
export function bookingHref(b) {
  if (b.status === 'TEMPORARY' && b.canSubmitProof) return `/bookings/${b.id}/pay`;
  return `/bookings/${b.id}`;
}

function chatButton(b) {
  const n = b.unreadMessages || 0;
  return html`<a class="icon-btn tonal" href="/bookings/${b.id}/chat" aria-label="${n ? `Open booking chat, ${n} unread` : 'Open booking chat'}">${icon('chat', 20)}${n ? html`<span class="badge" aria-hidden="true">${n}</span>` : ''}</a>`;
}

/**
 * Booking card for lists. Holds get the amber "action needed" footer with a
 * live countdown (call `startCardCountdowns(root, now)` after rendering).
 */
export function bookingCard(b) {
  const where = html`<span class="row" data-gap="16"><span class="row" data-gap="6">${icon('calendar', 16)}${dateLabel(b.date)}</span><span class="row" data-gap="6">${icon('clock', 16)}${rangeLabel(b.start, b.end)}</span></span>`;
  const holding = HOLDING.has(b.status) && b.holdExpiresAt;
  const past = b.status === 'COMPLETED' || b.status === 'EXPIRED' || b.status === 'CANCELLED';
  return html`<article class="card bcard${holding ? ' action' : ''}${past ? ' past' : ''}">
    <div class="bcard-body">
      <div class="card-head"><span class="overline ${past ? '' : 'blue'}">${b.activityLabel}</span>${statusPill(b.status, { small: true })}</div>
      <div class="bcard-title${b.status === 'CANCELLED' ? ' strike' : ''}">${b.resource.name}</div>
      <div class="bcard-meta">${where}</div>
      ${b.status === 'PAYMENT_SUBMITTED' ? html`<p class="bcard-line violet">${icon('shield-clock', 16, 2.2)}Payment proof submitted · waiting for admin verification</p>` : ''}
      ${b.status === 'EXPIRED' ? html`<p class="bcard-line">${b.rejectedAt ? 'Proof rejected · slot released' : 'No payment proof within the payment window'}</p>` : ''}
      ${b.status === 'CANCELLED' ? html`<p class="bcard-line">${b.cancelReason === 'Released by player' ? 'Hold released by you' : 'Cancelled'}${b.cancelledAt ? ` · ${dateLabel(isoDate(b.cancelledAt))}` : ''}</p>` : ''}
      ${!holding ? html`<div class="bcard-foot">
        <a class="btn btn-secondary btn-sm grow" href="${bookingHref(b)}">View details</a>
        ${b.status !== 'EXPIRED' ? chatButton(b) : ''}
      </div>` : ''}
    </div>
    ${holding ? html`<div class="bcard-hold" data-hold="${b.holdExpiresAt}" data-countdown>
      ${ringSvg(48)}
      <div class="grow">
        <div class="hold-line">${b.status === 'REJECTED' ? 'Send new proof within' : 'Complete payment within'} <span class="mono" data-cd-time>--:--</span></div>
        <div class="hold-sub">${peso(b.amountDue)} · ${b.status === 'REJECTED' ? 'your last proof was rejected' : 'then upload your proof'}</div>
      </div>
      <a class="btn btn-primary btn-sm" href="/bookings/${b.id}/pay">${b.status === 'REJECTED' ? 'Fix now' : 'Pay now'}</a>
    </div>` : ''}
  </article>`;
}

/** Starts one countdown per hold footer. Returns a cleanup function. */
export function startCardCountdowns(root, serverNow, onEnd) {
  const stops = [];
  for (const el of root.querySelectorAll('[data-hold]')) {
    stops.push(startCountdown(el.parentElement, { expiresAt: Number(el.dataset.hold), serverNow, onEnd }));
  }
  return () => stops.forEach((s) => s());
}

export function resourceTile(activity, { size = 'lg' } = {}) {
  const tt = activity === 'table_tennis';
  return html`<span class="tile ${size} ${tt ? 'ink' : 'blue'}">${resourceGlyph(activity)}</span>`;
}

export function lockLine(text = 'Only you and Le Spinners staff can see your screenshot.') {
  return html`<p class="lock-line">${icon('lock', 16, 2.2)}<span>${text}</span></p>`;
}
