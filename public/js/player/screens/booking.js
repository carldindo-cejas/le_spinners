import { api } from '../../core/api.js';
import { $, html, on, render, setBusy } from '../../core/dom.js';
import { icon, courtArt } from '../../core/icons.js';
import { clock, dateLabel, dayClock, initials, isoDate, longDate, minutesLabel, peso, rangeLabel, rangeLabelFull, shortDate } from './util.js';
import { copyText, errorState, memberTag, openModal, poll, ringSvg, skeletonRows, startCountdown, statusPill, toast } from '../../core/ui.js';
import { navigate, show, state, subHeader } from '../shell.js';
import { lockLine } from '../components.js';

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
      state: e.type === 'rejected' ? 'error' : 'done',
      sub: e.type === 'rejected' || e.type === 'cancelled' ? e.note : '',
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
    <div class="grow"><p class="h3">${b.resource.name} · ${b.activityLabel}</p><p class="small">${dateLabel(b.date)} · ${rangeLabel(b.start, b.end)}</p></div>
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
    ${bookingSummaryCard(b)}
    ${progress(d)}
    ${proofCard(d)}
    ${chatPreview(d)}
    <p class="small center">Need to change or cancel while we verify? Ask in the booking chat.</p>
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
      <p class="h3">${b.resource.name} · ${dateLabel(b.date)} · ${rangeLabel(b.start, b.end)}</p>
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
        <p class="ht-when">${longDate(b.date)} · ${rangeLabel(b.start, b.end)}</p>
      </div>
      <div class="ht-strip"><span class="mono">${b.ref}</span><span>Show at the front desk</span></div>
    </section>
    ${progress(d)}
    <section class="card card-pad-lg stack stack-8">
      <p class="overline">Booking</p>
      <dl class="kv">
        <div><dt>Activity</dt><dd>${b.activityLabel}</dd></div>
        <div><dt>${b.activity === 'table_tennis' ? 'Table' : 'Court'}</dt><dd>${b.resource.name}</dd></div>
        <div><dt>Date</dt><dd>${longDate(b.date)}</dd></div>
        <div><dt>Time</dt><dd>${rangeLabelFull(b.start, b.end)}</dd></div>
        <div><dt>Status</dt><dd class="${b.status === 'CONFIRMED' ? 'green-text' : ''}">${b.status === 'COMPLETED' ? 'Completed' : 'Confirmed'}</dd></div>
        <div><dt>Payment</dt><dd>${b.amountLabel} · GCash · verified</dd></div>
      </dl>
    </section>
    <section class="card card-pad-lg stack stack-12">
      <p class="overline">Customer</p>
      <div class="row" data-gap="12"><span class="avatar">${initials(u.name)}</span>
        <div class="grow"><p class="strong">${u.name}</p><p class="small">${[u.phone, u.email].filter(Boolean).join(' · ')}</p></div>${memberTag(u.membership, { small: true })}</div>
    </section>
    ${chatPreview(d)}
    ${b.canCancel ? html`<section class="cancel-box stack stack-8">
      <p class="strong">Need to cancel?</p>
      <p class="small">You can cancel until <b>${dateLabel(isoDate(b.cancelDeadline))} · ${clock(b.cancelDeadline)}</b> (${state.facility.rules.cancelCutoffHours} hours before). Refunds are arranged with staff in the booking chat.</p>
      <button type="button" class="btn btn-danger-outline btn-block" data-act="cancel">Cancel booking</button>
    </section>` : b.status === 'CONFIRMED' ? html`<p class="small center">It's less than ${state.facility.rules.cancelCutoffHours} hours before your booking, so it can't be cancelled here. Message staff in the booking chat if something came up.</p>` : ''}
  </div>`;
}

function cancelledDetails(d) {
  const b = d.booking;
  const ev = [...d.timeline].reverse().find((e) => e.type === 'cancelled' || e.type === 'released');
  const byYou = !ev || ev.actor === 'You';
  const paid = Boolean(b.confirmedAt);
  return html`${detailsHeader(d)}
  <div class="screen tight screen-enter">
    <section class="card card-pad-lg stack stack-12">
      <div class="card-head"><span class="mono">${b.ref}</span>${statusPill('CANCELLED', { small: true })}</div>
      <dl class="kv">
        <div><dt>Booking</dt><dd class="strike">${b.resource.name} · ${dateLabel(b.date)} · ${rangeLabel(b.start, b.end)}</dd></div>
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

function openCancel(d) {
  const b = d.booking;
  let reason = null;
  const reasons = ['Schedule changed', "Can't make it", 'Booked by mistake', 'Other'];
  let busy = false;
  const m = openModal({
    sheet: true,
    label: 'Cancel this booking?',
    locked: () => busy,
    content: () => html`<span class="tile red lg">${icon('circle-slash', 26)}</span>
      <h2 class="h2">Cancel this booking?</h2>
      <p class="body"><b>${b.resource.name} · ${dateLabel(b.date)} · ${rangeLabel(b.start, b.end)}</b> will be released to other players. This can't be undone.</p>
      <p class="label">Reason (optional, helps staff)</p>
      <div class="chip-row wrap" role="group" aria-label="Reason">${reasons.map((r) => html`<button type="button" class="chip" data-reason="${r}" aria-pressed="${reason === r ? 'true' : 'false'}">${r}</button>`)}</div>
      <p class="banner neutral compact">${icon('info', 18, 2.2)}<span>Your ${b.amountLabel} payment isn't refunded automatically — staff will follow up in the booking chat.</span></p>
      <button type="button" class="btn btn-danger btn-lg btn-block" data-act="confirm">Cancel booking</button>
      <button type="button" class="btn btn-secondary btn-block" data-close>Keep booking</button>`,
    onOpen: (panel) => {
      on(panel, 'click', '[data-reason]', (_e, btn) => {
        reason = reason === btn.dataset.reason ? null : btn.dataset.reason;
        for (const c of panel.querySelectorAll('[data-reason]')) c.setAttribute('aria-pressed', String(c.dataset.reason === reason));
      });
      on(panel, 'click', '[data-act="confirm"]', async (_e, btn) => {
        busy = true;
        setBusy(btn, true, 'Cancelling…');
        try {
          await api.post(`/api/bookings/${b.id}/cancel`, reason ? { reason } : {});
          busy = false;
          m.close();
          navigate(`/bookings/${b.id}/cancelled`, { replace: true });
        } catch (err) {
          busy = false;
          setBusy(btn, false);
          toast(err.message, { type: 'error' });
          if (err.code === 'CANCEL_WINDOW_CLOSED' || err.code === 'INVALID_STATUS') {
            m.close();
            navigate(`/bookings/${b.id}`, { replace: true });
          }
        }
      });
    },
  });
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
    on(root, 'click', '[data-act="cancel"]', () => openCancel(d));
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
      <p class="body">Your payment has been verified and your booking is confirmed. See you on the court!</p>
    </div>
    <section class="ticket">
      <div class="tk-top">
        <div class="card-head"><span class="overline ht-over">${b.activityLabel}</span>${statusPill(b.status, { small: true, onBlue: true })}</div>
        <p class="tk-name">${b.resource.name}</p>
        <p class="tk-when">${longDate(b.date)}<br>${rangeLabelFull(b.start, b.end)}</p>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <div class="row row-between"><div><p class="overline">Booking reference</p><p class="mono tk-ref">${b.ref}</p></div>
          <button type="button" class="icon-btn tonal" data-copy="${b.ref}" aria-label="Copy booking reference">${icon('copy', 20)}</button></div>
        <div class="grid-2"><div><p class="meta">Payment</p><p class="strong green-text">Verified · ${b.amountLabel}</p></div><div><p class="meta">Player</p><p class="strong">${state.user.name}</p></div></div>
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

// ── S06: booking cancelled ─────────────────────────────────────────────────

export async function cancelledView({ params }) {
  show(html`<div class="screen">${skeletonRows(1, 'sk-card')}</div>`);
  let d;
  try {
    d = await api.get(`/api/bookings/${encodeURIComponent(params.id)}`);
  } catch {
    return navigate(`/bookings/${params.id}`, { replace: true });
  }
  const b = d.booking;
  if (b.status !== 'CANCELLED') return navigate(`/bookings/${b.id}`, { replace: true });
  const paid = Boolean(b.confirmedAt);
  show(html`<div class="screen screen-enter">
    <div class="done-ring neutral" aria-hidden="true"><span>${icon('circle-slash', 38)}</span></div>
    <div class="stack stack-8 center">
      <h1 class="h1">Booking cancelled</h1>
      <p class="body">${b.resource.name} on ${dateLabel(b.date)} at ${minutesLabel(b.start)} is open again for other players.</p>
    </div>
    <section class="card card-pad-lg stack stack-12">
      <div class="card-head"><span class="mono">${b.ref}</span>${statusPill('CANCELLED', { small: true })}</div>
      <dl class="kv">
        <div><dt>Booking</dt><dd class="strike">${b.resource.name} · ${shortDate(b.date)} · ${rangeLabel(b.start, b.end)}</dd></div>
        <div><dt>Cancelled</dt><dd>By you${b.cancelledAt ? ` · ${dayClock(b.cancelledAt)}` : ''}</dd></div>
        ${b.cancelReason ? html`<div><dt>Reason</dt><dd>${b.cancelReason}</dd></div>` : ''}
      </dl>
    </section>
    ${paid ? html`<section class="card card-pad-lg stack stack-12 refund-card">
      <p class="h3">About your ${b.amountLabel}</p>
      <p class="small ink2">Refunds aren't automatic. Staff will reply in this booking's chat about a refund or credit.</p>
      <a class="btn btn-secondary btn-sm" href="/bookings/${b.id}/chat">${icon('chat', 18)}Open booking chat</a>
    </section>` : ''}
    <div class="stack stack-8">
      <a class="btn btn-primary btn-lg btn-block" href="/book">Book another time</a>
      <a class="btn btn-secondary btn-block" href="/">Back to home</a>
    </div>
  </div>`);
}

