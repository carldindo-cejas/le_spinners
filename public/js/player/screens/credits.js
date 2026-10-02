import { api } from '../../core/api.js';
import { $, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { dateLabel, dayClock, isoDate } from './util.js';
import { errorState, skeletonRows, toast } from '../../core/ui.js';
import { navigate, show, state, subHeader } from '../shell.js';
import { rebookFromBooking } from '../rebook.js';

/**
 * Booking credits (REBOOKING.md §12): value Le Spinners owes the player after cancelling or cutting
 * short a paid booking. Shown as money, never as a refund, and kept apart from bookings: a credit
 * is not a booking until the player books with it.
 */

const STATE_PILL = { available: 'volt', partly_used: 'blue', used: 'neutral', refunded: 'neutral', expired: 'neutral', voided: 'neutral' };

function stateTag(c) {
  return html`<span class="pill sm ${STATE_PILL[c.state] || 'neutral'}">${c.stateLabel}</span>`;
}

function creditRow(c) {
  return html`<a class="list-row credit-row" href="/credits/${c.id}">
    <span class="tile sm ${c.spendable ? 'blue' : 'neutral'}">${icon('gift', 20)}</span>
    <span class="grow"><span class="row-title"><span class="mono">${c.spendable ? c.remainingLabel : c.amountLabel}</span>${c.spendable && c.remaining < c.amount ? html` <span class="small">of ${c.amountLabel}</span>` : ''}</span><br>
      <span class="row-meta">${c.source && c.source.ref ? `From ${c.source.ref} · ` : ''}${c.reason}</span></span>
    ${stateTag(c)}
  </a>`;
}

/** Starts a rebooking for the booking a credit came from: same activity, its times preselected. */
async function rebookFrom(bookingId, btn) {
  setBusy(btn, true, 'Opening…');
  try {
    const d = await api.get(`/api/bookings/${encodeURIComponent(bookingId)}`);
    navigate(rebookFromBooking(d.booking, state.facility.rules.slotMinutes));
  } catch (err) {
    setBusy(btn, false);
    toast(err.message, { type: 'error' });
  }
}

export async function creditsView() {
  const root = show(html`${subHeader({ backHref: '/profile', backLabel: 'Back to profile', title: 'Booking credits' })}
    <div class="screen tight screen-enter" data-body>${skeletonRows(1, 'sk-card')}${skeletonRows(3)}</div>`);
  const body = $('[data-body]', root);
  let d;
  try {
    d = await api.get('/api/credits');
  } catch (err) {
    show(html`${subHeader({ backHref: '/profile', backLabel: 'Back to profile', title: 'Booking credits' })}<div class="screen">${errorState(err)}</div>`);
    return;
  }
  const spendable = d.credits.filter((c) => c.spendable);
  const past = d.credits.filter((c) => !c.spendable);
  render(body, html`<section class="card card-pad-lg stack stack-12 credit-hero">
      <p class="overline blue">Available to spend</p>
      <p class="credit-amount mono">${d.summary.availableLabel}</p>
      <p class="small ink2">Applied automatically when you book. It isn't a cash refund.</p>
      ${d.summary.available > 0 ? html`<a class="btn btn-primary btn-lg btn-block" href="/book">${icon('calendar-plus', 20)}Book with my credit</a>` : ''}
    </section>
    ${spendable.length ? html`<section class="section"><h2 class="h3">Ready to use</h2><div class="card menu">${spendable.map(creditRow)}</div></section>` : ''}
    ${past.length ? html`<section class="section"><h2 class="h3">Used and past</h2><div class="card menu">${past.map(creditRow)}</div></section>` : ''}
    ${!d.credits.length ? html`<div class="empty"><span class="tile blue lg">${icon('gift', 26)}</span><p class="empty-title">No booking credits</p>
      <p class="empty-body">If Le Spinners has to cancel or cut short a booking you paid for, its value comes back here as credit for your next booking.</p></div>` : ''}
    <section class="card card-pad-lg stack stack-12">
      <p class="overline">How booking credit works</p>
      <ol class="steps-list">
        <li><span class="n blue">1</span><span>Le Spinners cancels or cuts short a booking you paid for (rain, repairs, an emergency…).</span></li>
        <li><span class="n blue">2</span><span>What you paid for the lost time comes back as credit. Time you already played isn't credited.</span></li>
        <li><span class="n blue">3</span><span>Book any court or table: the credit pays first. If the new booking costs more, pay the rest by GCash; if less, the rest stays here.</span></li>
      </ol>
      <p class="small">Questions about a credit? Ask in the chat of the booking it came from.</p>
    </section>`);
}

export async function creditDetailView({ params }) {
  const back = () => subHeader({ backHref: '/credits', backLabel: 'Back to credits', title: 'Booking credit' });
  show(html`${back()}<div class="screen tight">${skeletonRows(1, 'sk-card')}${skeletonRows(3)}</div>`);
  let d;
  try {
    d = await api.get(`/api/credits/${encodeURIComponent(params.id)}`);
  } catch (err) {
    show(html`${back()}<div class="screen">${err.status === 404 ? html`<div class="empty"><p class="empty-title">Credit not found</p><a class="btn btn-primary btn-md" href="/credits">My credits</a></div>` : errorState(err)}</div>`);
    return;
  }
  const c = d.credit;
  const root = show(html`${back()}
  <div class="screen tight screen-enter">
    <section class="card card-pad-lg stack stack-12 credit-hero">
      <div class="card-head"><span class="overline blue">${c.spendable ? 'Left to spend' : 'Booking credit'}</span>${stateTag(c)}</div>
      <p class="credit-amount mono">${c.spendable ? c.remainingLabel : c.amountLabel}</p>
      ${c.spendable && c.remaining < c.amount ? html`<p class="small">of ${c.amountLabel} issued</p>` : ''}
      ${c.reserved > 0 ? html`<p class="banner warn compact">${icon('hourglass', 18, 2.2)}<span>${c.reservedLabel} is paying for a booking that's waiting for payment. It comes back if that hold ends unpaid.</span></p>` : ''}
      <dl class="kv">
        <div><dt>Why</dt><dd>${c.reason}</dd></div>
        ${c.source ? html`<div><dt>From</dt><dd><a href="/bookings/${c.source.bookingId}" class="mono">${c.source.ref}</a>${c.source.label ? html`<br><span class="small">${c.source.label}</span>` : ''}</dd></div>` : ''}
        <div><dt>Issued</dt><dd>${dateLabel(isoDate(c.issuedAt))}</dd></div>
        <div><dt>Expires</dt><dd>${c.expiresAt ? dateLabel(isoDate(c.expiresAt)) : 'Never'}</dd></div>
      </dl>
      <p class="small ink2">A booking credit isn't a cash refund. It pays for your next booking automatically.</p>
      ${c.spendable ? html`<div class="stack stack-8">
        ${c.source ? html`<button type="button" class="btn btn-primary btn-lg btn-block" data-act="rebook">${icon('calendar-plus', 20)}Rebook ${c.source.ref}</button>` : ''}
        <a class="btn ${c.source ? 'btn-secondary' : 'btn-primary btn-lg'} btn-block" href="/book">Book something else</a>
      </div>` : ''}
    </section>
    <section class="section">
      <h2 class="h3">History</h2>
      <ol class="card menu credit-history">${d.history.map((h) => html`<li class="list-row">
        <span class="grow"><span class="row-title">${h.label}</span><br><span class="row-meta">${dayClock(h.at)}${h.actor ? ` · ${h.actor}` : ''}${h.note && h.kind !== 'issue' ? ` · ${h.note}` : ''}</span></span>
        <span class="mono ${h.amount < 0 ? '' : 'green-text'}">${h.amountLabel}</span>
      </li>`)}</ol>
    </section>
  </div>`);
  on(root, 'click', '[data-act="rebook"]', (_e, btn) => rebookFrom(c.source.bookingId, btn));
}
