import { api } from '../../core/api.js';
import { $, html, on } from '../../core/dom.js';
import { icon, courtArt } from '../../core/icons.js';
import { bookingTime, clock, dateLabel, dayClock, initials, isoDate, longDate, peso } from './util.js';
import { copyText, errorState, memberTag, openModal, poll, ringSvg, skeletonRows, startCountdown, statusPill, toast } from '../../core/ui.js';
import { navigate, show, state, subHeader } from '../shell.js';
import { lockLine } from '../components.js';
import { rebookFromBooking } from '../rebook.js';

function when(ms) {
  return isoDate(ms) === isoDate(Date.now()) ? clock(ms) : dayClock(ms);
}

function chatHeaderButton(d) {
  const n = d.unreadMessages || 0;
  return html`<a class="icon-btn tonal" href="/bookings/${d.booking.id}/chat" aria-label="${n ? `Open booking chat, ${n} unread` : 'Open booking chat'}">${icon('chat', 20)}${n ? html`<span class="badge" aria-hidden="true">${n}</span>` : ''}</a>`;
}

function detailsHeader(d, { chat = true } = {}) {
  return subHeader({
    backHref: '/bookings',
    backLabel: 'Back to my bookings',
    title: 'Booking details',
    sub: d.booking.ref,
    subMono: true,
    right: chat ? chatHeaderButton(d) : '',
  });
}

/** PROGRESS timeline from the booking's events plus the steps still to come. */
function progress(d) {
  const b = d.booking;
  const items = d.timeline
    .filter((e) => e.type !== 'completed' || b.status === 'COMPLETED')
    .map((e) => ({
      label: e.type === 'created' ? 'Booking created' : e.type === 'approved' ? 'Payment verified' : e.type === 'rejected' ? 'Proof rejected' : e.label,
      time: when(e.at),
      state: e.type === 'rejected' || e.type === 'disrupted' ? 'error' : 'done',
      sub: ['rejected', 'cancelled', 'disrupted', 'partially_disrupted', 'credit_applied', 'credit_booked'].includes(e.type) ? e.note : '',
    }));
  if (b.status === 'CONFIRMED' || b.status === 'COMPLETED') {
    const approved = d.timeline.find((e) => e.type === 'approved');
    if (approved) items.splice(items.findIndex((i) => i.label === 'Payment verified') + 1, 0, { label: 'Booking confirmed', time: when(approved.at), state: 'final' });
  }
  if (b.status === 'PAYMENT_SUBMITTED') {
    items.push({ label: 'Admin verification', sub: "Waiting · we'll notify you", state: 'current' }, { label: 'Booking confirmed', state: 'future' });
  }
  if (b.status === 'REJECTED' && b.canSubmitProof) {
    items.push({ label: 'New proof · admin verification', state: 'pending-retry' }, { label: 'Booking confirmed', state: 'future' });
  }
  return html`<section class="card card-pad-lg stack stack-16">
    <p class="overline">Progress</p>
    <ol class="timeline">${items.map((i) => html`<li class="tl-item ${i.state}">
      <span class="tl-node">${i.state === 'done' ? icon('check', 14, 3) : i.state === 'final' ? icon('check', 14, 3) : i.state === 'error' ? icon('x', 14, 3) : ''}</span>
      <span class="tl-text">${i.label}${i.sub ? html`<span class="tl-sub">${i.sub}</span>` : ''}</span>
      <span class="tl-time">${i.time || ''}</span>
    </li>`)}</ol>
  </section>`;
}

function bookingSummaryCard(b) {
  return html`<section class="card card-pad row" data-gap="14">
    <span class="tile blue lg">${icon(b.activity === 'table_tennis' ? 'pingpong' : 'paddle', 24)}</span>
    <div class="grow"><p class="h3">${b.resource.name} · ${b.activityLabel}</p><p class="small">${dateLabel(b.date)} · ${bookingTime(b)}</p></div>
    <span class="mono">${b.amountLabel}</span>
  </section>`;
}

function proofCard(d) {
  const p = d.proofs[0];
  if (!p) return '';
  return html`<section class="card card-pad-lg stack stack-12">
    <div class="card-head"><span class="overline">Your payment proof</span><span class="row small" data-gap="6">${icon('lock', 14, 2.2)}Private</span></div>
    <div class="row row-top" data-gap="14">
      <button type="button" class="proof-thumb" data-act="view-proof" aria-label="View your payment screenshot"><img src="${p.url}" alt="" loading="lazy"></button>
      <dl class="kv grow compact-kv">
        <div><dt>Screenshot</dt><dd class="ellipsis">${p.fileName || 'Payment screenshot'}</dd></div>
        <div><dt>Reference no.</dt><dd class="mono">${p.gcashRef || 'Not entered'}</dd></div>
        <div><dt>Amount paid</dt><dd>${p.amountClaimed != null ? peso(p.amountClaimed, { decimals: true }) : 'Not entered'}</dd></div>
      </dl>
    </div>
    ${lockLine('Visible only to you and Le Spinners staff.')}
  </section>`;
}

function chatPreview(d) {
  const b = d.booking;
  const m = d.lastMessage;
  const n = d.unreadMessages || 0;
  return html`<a class="card card-link card-pad stack stack-8" href="/bookings/${b.id}/chat">
    <div class="card-head"><span class="overline">Booking chat</span>${n ? html`<span class="pill red sm">${n} new</span>` : ''}</div>
    ${m ? html`<div class="row row-top" data-gap="10"><span class="avatar xs ${m.sender === 'staff' ? 'blue' : ''}">${m.sender === 'staff' ? 'LS' : initials(state.user.name)}</span><div class="grow"><p class="small strong ink">${m.senderName} · ${when(m.at)}</p><p class="small">"${m.body.length > 120 ? `${m.body.slice(0, 117)}…` : m.body}"</p></div></div>` : html`<p class="small">Questions about this booking? Message Le Spinners staff here.</p>`}
    <span class="btn btn-tonal btn-sm">${icon('chat', 18)}Open chat</span>
  </a>`;
}

function viewProof(d) {
  const p = d.proofs[0];
  if (!p) return;
  openModal({
    label: 'Your payment screenshot',
    wide: true,
    content: () => html`<div class="sheet-head"><h2 class="h3">Your payment screenshot</h2><button type="button" class="icon-btn sm flat" data-close aria-label="Close">${icon('x', 18, 2.2)}</button></div>
      <img class="proof-full" src="${p.url}" alt="Your payment screenshot">
      ${lockLine('Visible only to you and Le Spinners staff.')}`,
  });
}

// ── Disruptions and booking credit (REBOOKING.md §12) ────────────────────────

/** "₱1,000 · GCash · verified", "₱1,000 · Paid with credit", "₱1,200 · ₱600 GCash + ₱600 credit". */
function paymentLine(b) {
  if (b.creditApplied > 0 && b.amountDue > 0) return `${b.totalLabel} · ${b.amountLabel} GCash + ${b.creditAppliedLabel} booking credit`;
  if (b.creditApplied > 0) return `${b.totalLabel} · paid with booking credit`;
  if (b.paymentMethod === 'on_site') return `${b.amountLabel} · paid on site`;
  return `${b.amountLabel} · GCash · verified`;
}

/** Where the booking credit that paid for this booking came from. */
function creditUsedCard(d) {
  const uses = d.credit?.creditUses;
  if (!uses || !uses.sources.length) return '';
  const refs = [...new Set(uses.sources.map((s) => s.sourceRef).filter(Boolean))];
  return html`<p class="banner info compact">${icon('gift', 18, 2.2)}<span>${d.booking.creditAppliedLabel} booking credit applied${refs.length ? html` · from <b class="mono">${refs.join(', ')}</b>` : ''}${uses.returned ? ' · returned when this hold ended' : ''}.</span></p>`;
}

/** Part of a confirmed or completed booking couldn't go ahead and was credited. */
function partialCards(d) {
  const parts = (d.credit?.disruptions || []).filter((x) => x.outcome === 'partial');
  return parts.map((x) => html`<section class="card card-pad stack stack-8 credit-note">
    <div class="row" data-gap="12"><span class="tile blue">${icon('gift', 22)}</span>
      <div class="grow"><p class="strong">${x.affectedLabel} couldn't go ahead</p><p class="small">${x.reason}</p></div>
      ${x.credit > 0 ? html`<span class="mono strong">${x.creditLabel}</span>` : ''}</div>
    ${x.credit > 0 ? html`<p class="small ink2">Added to your booking credits. It isn't a cash refund: it pays for your next booking. <a href="/credits">See my credits</a></p>` : ''}
  </section>`);
}

/** The booking's time was closed while its payment is still being checked. */
function pendingCard(d) {
  const p = (d.credit?.disruptions || []).find((x) => x.outcome === 'deferred');
  if (!p) return '';
  return html`<section class="banner warn" role="status">${icon('calendar-x', 20, 2.2)}<div><b>Le Spinners closed this time · ${p.reason}.</b><br>Once staff verify your payment, the booking is cancelled and what you paid becomes booking credit.</div></section>`;
}

// ── Views by status ────────────────────────────────────────────────────────

function verifyingView(d) {
  const b = d.booking;
  return html`${detailsHeader(d)}
  <div class="screen tight screen-enter">
    <section class="status-banner violet" role="status">
      <span class="tile violet-solid">${icon('shield-clock', 22)}</span>
      <div><p class="overline violet">Payment verification</p><p class="h3">Waiting for admin approval</p>
        <p class="small ink2">Payment proof submitted at ${b.submittedAt ? clock(b.submittedAt) : ''}. We'll notify you as soon as staff verify it.</p></div>
    </section>
    ${pendingCard(d)}
    ${bookingSummaryCard(b)}
    ${creditUsedCard(d)}
    ${progress(d)}
    ${proofCard(d)}
    ${chatPreview(d)}
    <p class="small center">Bookings can't be cancelled in the app. Questions or a change of plans? Ask in the booking chat.</p>
  </div>`;
}

function rejectedView(d) {
  const b = d.booking;
  return html`${detailsHeader(d, { chat: false })}
  <div class="screen tight screen-enter">
    <section class="status-banner red" role="alert">
      <span class="tile red">${icon('x-circle', 22)}</span>
      <div class="grow stack stack-8"><div><p class="overline red-text">Payment proof rejected</p><p class="h3">Staff couldn't verify your payment</p></div>
        <div class="reason-box"><span class="small">Reason</span><p class="strong">"${b.rejectReason}"</p><span class="meta">Le Spinners staff · ${b.rejectedAt ? clock(b.rejectedAt) : ''}</span></div></div>
    </section>
    <div class="countdown amber-always" data-countdown role="timer" aria-live="off" aria-label="Time left to send new proof">
      ${ringSvg(48)}
      <div class="grow stack stack-4"><span class="cd-caption">Resubmit window</span><span class="cd-line">Send corrected proof to keep ${b.resource.name}</span></div>
      <span class="cd-time" data-cd-time>--:--</span>
    </div>
    <a class="btn btn-primary btn-lg btn-block" href="/bookings/${b.id}/pay">${icon('upload', 20)}Submit new proof</a>
    <a class="btn btn-secondary btn-block" href="/bookings/${b.id}/chat">${icon('chat', 20)}Open chat${d.unreadMessages ? html`<span class="badge inline">${d.unreadMessages}</span>` : ''}</a>
    ${progress(d)}
    ${bookingSummaryCard(b)}
    ${d.lastMessage && d.lastMessage.sender === 'staff' ? html`<section class="card card-pad stack stack-4"><p class="meta">${d.lastMessage.senderName} · ${when(d.lastMessage.at)}</p><p class="body">"${d.lastMessage.body}"</p></section>` : ''}
  </div>`;
}

function expiredView(d) {
  const b = d.booking;
  const afterReject = Boolean(b.rejectedAt);
  const created = d.timeline.find((e) => e.type === 'created');
  return html`<div class="screen screen-enter">
    <div class="row row-between"><span></span><a class="icon-btn" href="/" aria-label="Close">${icon('x', 20, 2.2)}</a></div>
    <div class="done-ring neutral" aria-hidden="true"><span>${icon('hourglass', 36)}</span></div>
    <div class="stack stack-8 center">
      <p class="overline">Booking expired</p>
      <h1 class="h1">Your hold on ${b.resource.name} ended</h1>
      <p class="body">${afterReject
        ? 'Your payment proof was rejected and no new proof arrived in time, so the slot was released.'
        : 'Your temporary reservation has expired because payment proof was not submitted within the payment window.'}</p>
    </div>
    <section class="card card-pad stack stack-8">
      <div class="card-head"><span class="overline">${b.activityLabel}</span>${statusPill('EXPIRED', { small: true })}</div>
      <p class="h3">${b.resource.name} · ${dateLabel(b.date)} · ${bookingTime(b)}</p>
      <p class="small">${afterReject ? `Proof rejected: "${b.rejectReason}"` : `Held ${created ? clock(created.at) : ''}${created ? ` – ${clock(created.at + state.facility.rules.holdMinutes * 60_000)}` : ''} · no payment proof received`}</p>
    </section>
    <p class="banner success compact">${icon('check-circle', 18, 2.2)}<span>The slot is open to everyone again. If it's still free, you can book it now.</span></p>
    <div class="stack stack-8">
      <a class="btn btn-primary btn-lg btn-block" href="/book/${b.activity}/${b.date}/${b.resource.id}">Book another time</a>
      <a class="btn btn-secondary btn-block" href="/">Back to home</a>
    </div>
    <p class="small center">Already paid but ran out of time? <a href="/bookings/${b.id}/chat">Send your screenshot in the booking chat.</a></p>
  </div>`;
}

function confirmedDetails(d) {
  const b = d.booking;
  const u = state.user;
  return html`${detailsHeader(d)}
  <div class="screen tight screen-enter">
    <section class="hero-ticket">
      <span class="ticket-art">${courtArt()}</span>
      <div class="ht-top">
        <div class="card-head"><span class="overline ht-over">${b.activityLabel}</span>${statusPill(b.status, { small: true, onBlue: true })}</div>
        <p class="ht-name">${b.resource.name}</p>
        <p class="ht-when">${longDate(b.date)} · ${bookingTime(b)}</p>
      </div>
      <div class="ht-strip"><span class="mono">${b.ref}</span><span>Show at the front desk</span></div>
    </section>
    ${partialCards(d)}
    ${progress(d)}
    <section class="card card-pad-lg stack stack-8">
      <p class="overline">Booking</p>
      <dl class="kv">
        <div><dt>Activity</dt><dd>${b.activityLabel}</dd></div>
        <div><dt>${b.activity === 'table_tennis' ? 'Table' : 'Court'}</dt><dd>${b.resource.name}</dd></div>
        <div><dt>Date</dt><dd>${longDate(b.date)}</dd></div>
        <div><dt>Time</dt><dd>${bookingTime(b, { full: true })}</dd></div>
        <div><dt>Status</dt><dd class="${b.status === 'CONFIRMED' ? 'green-text' : ''}">${b.status === 'COMPLETED' ? 'Completed' : 'Confirmed'}</dd></div>
        <div><dt>Payment</dt><dd>${paymentLine(b)}</dd></div>
      </dl>
    </section>
    ${creditUsedCard(d)}
    <section class="card card-pad-lg stack stack-12">
      <p class="overline">Customer</p>
      <div class="row" data-gap="12"><span class="avatar">${initials(u.name)}</span>
        <div class="grow"><p class="strong">${u.name}</p><p class="small">${[u.phone, u.email].filter(Boolean).join(' · ')}</p></div>${memberTag(u.membership, { small: true })}</div>
    </section>
    ${chatPreview(d)}
    ${b.status === 'CONFIRMED' ? html`<p class="small center">Bookings can't be cancelled in the app. If something comes up, message staff in the booking chat. If Le Spinners has to cancel, you get booking credit.</p>` : ''}
  </div>`;
}

/** Le Spinners cancelled the booking (closure, weather, repairs…): the credit and the way to rebook. */
function disruptedDetails(d) {
  const b = d.booking;
  const x = (d.credit?.disruptions || []).filter((r) => r.outcome === 'cancelled').pop();
  const credit = x ? x.credit : b.creditIssued;
  const left = x && x.creditRemaining != null ? x.creditRemaining : credit;
  const wasHold = !b.confirmedAt;
  return html`${detailsHeader(d)}
  <div class="screen tight screen-enter">
    <section class="status-banner neutral" role="status">
      <span class="tile neutral">${icon('calendar-x', 22)}</span>
      <div><p class="overline">Cancelled by Le Spinners</p><p class="h3">${x ? x.reason : b.cancelReason || 'Cancelled'}</p>
        <p class="small ink2">${b.cancelledAt ? dayClock(b.cancelledAt) : ''}${x ? ` · ${x.categoryLabel}` : ''}</p></div>
    </section>
    <section class="card card-pad-lg stack stack-12">
      <div class="card-head"><span class="mono">${b.ref}</span>${statusPill('CANCELLED', { small: true })}</div>
      <dl class="kv">
        <div><dt>Booking</dt><dd class="strike">${b.resource.name} · ${dateLabel(b.date)} · ${bookingTime(b)}</dd></div>
        <div><dt>Paid</dt><dd>${wasHold ? 'Nothing · the hold ended' : paymentLine(b)}</dd></div>
      </dl>
    </section>
    ${credit > 0 ? html`<section class="card card-pad-lg stack stack-12 credit-hero">
      <div class="row" data-gap="12"><span class="tile blue">${icon('gift', 22)}</span>
        <div class="grow"><p class="overline blue">Booking credit</p><p class="credit-amount mono">${left < credit ? `${peso(left)} left` : peso(credit)}</p></div></div>
      <p class="small ink2">${left < credit ? `${peso(credit)} was added for this booking. ` : ''}It isn't a cash refund: it pays for your next booking automatically.</p>
      ${left > 0 ? html`<button type="button" class="btn btn-primary btn-lg btn-block" data-act="rebook">${icon('calendar-plus', 20)}Rebook</button>` : ''}
      <a class="btn btn-secondary btn-block" href="/credits">See my booking credits</a>
    </section>` : html`<p class="banner neutral compact">${icon('info', 18, 2.2)}<span>${wasHold ? 'Nothing was charged for this booking.' : 'Questions about this booking? Ask in its chat.'}</span></p>
      <a class="btn btn-primary btn-lg btn-block" href="/book">Book another time</a>`}
    ${chatPreview(d)}
  </div>`;
}

function cancelledDetails(d) {
  const b = d.booking;
  if (b.cancelledBy === 'staff' && b.disrupted) return disruptedDetails(d);
  const ev = [...d.timeline].reverse().find((e) => e.type === 'cancelled' || e.type === 'released');
  const byYou = !ev || ev.actor === 'You';
  const paid = Boolean(b.confirmedAt);
  return html`${detailsHeader(d)}
  <div class="screen tight screen-enter">
    <section class="card card-pad-lg stack stack-12">
      <div class="card-head"><span class="mono">${b.ref}</span>${statusPill('CANCELLED', { small: true })}</div>
      <dl class="kv">
        <div><dt>Booking</dt><dd class="strike">${b.resource.name} · ${dateLabel(b.date)} · ${bookingTime(b)}</dd></div>
        <div><dt>${ev && ev.type === 'released' ? 'Released' : 'Cancelled'}</dt><dd>${byYou ? 'By you' : 'By Le Spinners'}${b.cancelledAt ? ` · ${dayClock(b.cancelledAt)}` : ''}</dd></div>
        ${b.cancelReason && b.cancelReason !== 'Released by player' ? html`<div><dt>Reason</dt><dd>${b.cancelReason}</dd></div>` : ''}
      </dl>
    </section>
    ${paid ? html`<section class="card card-pad-lg stack stack-12 refund-card">
      <p class="h3">About your ${b.amountLabel}</p>
      <p class="small ink2">Refunds aren't automatic. Staff will reply in this booking's chat about a refund or credit.</p>
      <a class="btn btn-secondary btn-sm" href="/bookings/${b.id}/chat">${icon('chat', 18)}Open booking chat</a>
    </section>` : ''}
    <a class="btn btn-primary btn-lg btn-block" href="/book">Book another time</a>
  </div>`;
}

export async function bookingView({ params }) {
  show(html`<div class="screen">${skeletonRows(1, 'sk-card')}${skeletonRows(4)}</div>`);
  let d;
  const load = () => api.get(`/api/bookings/${encodeURIComponent(params.id)}`);
  try {
    d = await load();
  } catch (err) {
    const root = show(html`<div class="screen">${err.status === 404 ? html`<div class="empty"><p class="empty-title">Booking not found</p><p class="empty-body">It may belong to another account, or the link is old.</p><a class="btn btn-primary btn-md" href="/bookings">My bookings</a></div>` : errorState(err)}</div>`);
    $('[data-act="retry"]', root)?.addEventListener('click', () => bookingView({ params }));
    return undefined;
  }
  const b = d.booking;
  if (b.status === 'TEMPORARY' && b.canSubmitProof) return navigate(`/bookings/${b.id}/pay`, { replace: true });

  const paint = () => {
    const s = d.booking.status;
    if (s === 'PAYMENT_SUBMITTED') return show(verifyingView(d));
    if (s === 'REJECTED' && d.booking.canSubmitProof) return show(rejectedView(d));
    if (s === 'EXPIRED' || s === 'REJECTED' || s === 'TEMPORARY') return show(expiredView(d));
    if (s === 'CANCELLED') return show(cancelledDetails(d));
    return show(confirmedDetails(d));
  };
  let root = paint();
  const cleanups = [];
  const wire = () => {
    on(root, 'click', '[data-act="view-proof"]', () => viewProof(d));
    on(root, 'click', '[data-act="rebook"]', () => navigate(rebookFromBooking(d.booking, state.facility.rules.slotMinutes)));
    if (d.booking.status === 'REJECTED' && d.booking.canSubmitProof) {
      cleanups.push(startCountdown(root, {
        expiresAt: d.booking.holdExpiresAt,
        serverNow: d.now,
        totalMs: state.facility.rules.resubmitMinutes * 60_000,
        onEnd: () => setTimeout(refresh, 1500),
      }));
    }
  };
  async function refresh() {
    try {
      const next = await load();
      const changed = next.booking.status !== d.booking.status || next.unreadMessages !== d.unreadMessages || (next.lastMessage && next.lastMessage.at) !== (d.lastMessage && d.lastMessage.at);
      if (next.booking.status === 'CONFIRMED' && d.booking.status === 'PAYMENT_SUBMITTED') {
        navigate(`/bookings/${b.id}/confirmed`, { replace: true });
        return;
      }
      d = next;
      if (changed) {
        cleanups.splice(0).forEach((c) => c());
        root = paint();
        wire();
      }
    } catch {
      /* keep what we have */
    }
  }
  wire();
  const live = ['PAYMENT_SUBMITTED', 'REJECTED', 'CONFIRMED'].includes(b.status);
  const stopPoll = live ? poll(refresh, 10_000) : () => {};
  return () => {
    stopPoll();
    cleanups.forEach((c) => c());
  };
}

// ── U33: booking confirmed ─────────────────────────────────────────────────

export async function confirmedView({ params }) {
  show(html`<div class="screen">${skeletonRows(1, 'sk-card')}</div>`);
  let d;
  try {
    d = await api.get(`/api/bookings/${encodeURIComponent(params.id)}`);
  } catch (err) {
    return navigate(`/bookings/${params.id}`, { replace: true });
  }
  const b = d.booking;
  if (b.status !== 'CONFIRMED' && b.status !== 'COMPLETED') return navigate(`/bookings/${b.id}`, { replace: true });
  const root = show(html`<div class="screen screen-enter">
    <div class="done-ring green" aria-hidden="true"><span>${icon('check', 36, 3)}</span></div>
    <div class="stack stack-8 center">
      <h1 class="h1 big">Booking confirmed</h1>
      <p class="body">${b.creditApplied > 0 && b.amountDue === 0
        ? `Paid with ${b.creditAppliedLabel} of your booking credit. See you on the court!`
        : 'Your payment has been verified and your booking is confirmed. See you on the court!'}</p>
    </div>
    <section class="ticket">
      <div class="tk-top">
        <div class="card-head"><span class="overline ht-over">${b.activityLabel}</span>${statusPill(b.status, { small: true, onBlue: true })}</div>
        <p class="tk-name">${b.resource.name}</p>
        <p class="tk-when">${longDate(b.date)}<br>${bookingTime(b, { full: true })}</p>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <div class="row row-between"><div><p class="overline">Booking reference</p><p class="mono tk-ref">${b.ref}</p></div>
          <button type="button" class="icon-btn tonal" data-copy="${b.ref}" aria-label="Copy booking reference">${icon('copy', 20)}</button></div>
        <div class="grid-2"><div><p class="meta">Payment</p><p class="strong green-text">${b.creditApplied > 0 ? (b.amountDue > 0 ? `${b.amountLabel} GCash + ${b.creditAppliedLabel} credit` : `Booking credit · ${b.creditAppliedLabel}`) : `Verified · ${b.amountLabel}`}</p></div><div><p class="meta">Player</p><p class="strong">${state.user.name}</p></div></div>
        <p class="small">Show this reference at the front desk when you arrive.</p>
      </div>
    </section>
    <div class="stack stack-8">
      <a class="btn btn-primary btn-lg btn-block" href="/bookings/${b.id}" data-replace>View booking</a>
      <div class="grid-2"><a class="btn btn-secondary" href="/book">Book another</a><a class="btn btn-secondary" href="/">Back to home</a></div>
      <a class="btn btn-text btn-block" href="/bookings/${b.id}/chat">${icon('chat', 18)}Message Le Spinners about this booking</a>
    </div>
  </div>`);
  on(root, 'click', '[data-copy]', async (_e, btn) => {
    if (await copyText(btn.dataset.copy)) toast('Booking reference copied');
  });
}

// ── Old /bookings/:id/cancelled links ────────────────────────────────────────

/** Players can't cancel bookings (REBOOKING.md §4), so this screen only forwards old links. */
export function cancelledView({ params }) {
  navigate(`/bookings/${encodeURIComponent(params.id)}`, { replace: true });
}

