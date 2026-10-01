import { api } from '../../core/api.js';
import { $, html, on, render, setBusy } from '../../core/dom.js';
import { icon, courtArt } from '../../core/icons.js';
import { bookingTime, clock, dayClock, firstName, initials, isoDate, longDate, minutesLabel, shortDate, weekdayShort } from '../../core/format.js';
import { errorState, memberTag, openModal, poll, skeletonRows, statusPill, toast } from '../../core/ui.js';
import { frame } from '../shell.js';
import { openViewer } from './verify.js';
import { miniChat } from '../minichat.js';
import { API, BASE } from '../console.js';

const CHIPS = [
  { key: 'all', label: 'All', count: (c) => Object.values(c).reduce((a, b) => a + b, 0) },
  { key: 'PAYMENT_SUBMITTED', label: 'Needs verification', count: (c) => c.PAYMENT_SUBMITTED || 0, violet: true },
  { key: 'holds', label: 'Temporary', count: (c) => (c.TEMPORARY || 0) + (c.REJECTED || 0) },
  { key: 'CONFIRMED', label: 'Confirmed', count: (c) => c.CONFIRMED || 0 },
  { key: 'COMPLETED', label: 'Completed', count: (c) => c.COMPLETED || 0 },
  { key: 'closed', label: 'Cancelled & expired', count: (c) => (c.CANCELLED || 0) + (c.EXPIRED || 0) },
];

function readFilters(query) {
  return {
    status: query.get('status') || 'all',
    q: query.get('q') || '',
    date: query.get('date') || '',
    activity: query.get('activity') || '',
    scope: query.get('scope') || 'upcoming',
  };
}

function toQuery(f) {
  const p = new URLSearchParams();
  if (f.status && f.status !== 'all') p.set('status', f.status);
  if (f.q) p.set('q', f.q);
  if (f.date) p.set('date', f.date);
  if (f.activity) p.set('activity', f.activity);
  if (f.scope && f.scope !== 'upcoming') p.set('scope', f.scope);
  return p.toString();
}

/** "Online", or who made it in a console: "Admin · Carl Dindo Cejas". */
export function bookedByLabel(b, { short = false } = {}) {
  const by = b.bookedBy;
  if (!by || by.source === 'online') return short ? 'Online' : 'Online · player app';
  const name = by.name ? (short ? firstName(by.name) : by.name) : '';
  return name ? `${by.label} · ${name}` : by.label;
}

function tableRow(b) {
  return html`<tr>
    <td><a class="ref" href="${BASE}/bookings/${b.id}">${b.ref}</a><span class="sub">${bookedByLabel(b, { short: true })}</span></td>
    <td><span class="strong">${b.user.name}</span><span class="sub ${b.user.membership === 'member' ? 'green-text' : ''}">${b.user.membership === 'member' ? 'Member' : b.user.membership === 'pending' ? 'Membership pending' : 'Non-member'}</span></td>
    <td>${b.resource.name}<span class="sub">${b.activityLabel}</span></td>
    <td>${weekdayShort(b.date)}, ${shortDate(b.date)}<span class="sub">${bookingTime(b)}${b.durationMin > 60 ? ` · ${b.durationLabel}` : ''}</span></td>
    <td class="r mono">${b.amountLabel}</td>
    <td>${statusPill(b.status, { small: true })}</td>
    <td><div class="row-actions">
      ${b.status === 'PAYMENT_SUBMITTED' ? html`<a class="btn btn-violet btn-xs" href="${BASE}/verify/${b.id}">Review</a>` : ''}
      <a class="icon-btn" href="${BASE}/messages/${b.id}" aria-label="Open chat with ${b.user.name}${b.unreadMessages ? `, ${b.unreadMessages} unread` : ''}">${icon('chat', 18)}${b.unreadMessages ? html`<span class="dot-unread"></span>` : ''}</a>
      <a class="icon-btn" href="${BASE}/bookings/${b.id}" aria-label="Details for ${b.ref}">${icon('chevron-right', 18, 2.2)}</a>
    </div></td>
  </tr>`;
}

function mobileCard(b) {
  const [h, ap] = minutesLabel(b.start).split(' ');
  return html`<a class="m-card" href="${b.status === 'PAYMENT_SUBMITTED' ? `${BASE}/verify/${b.id}` : `${BASE}/bookings/${b.id}`}">
    <div class="row" data-gap="12">
      <span class="m-time">${h}<br><span class="meta">${ap}</span></span>
      <span class="grow"><span class="strong">${b.user.name}</span><br><span class="small">${b.resource.name} · ${weekdayShort(b.date)}, ${shortDate(b.date)}${b.durationMin > 60 ? ` · ${b.durationLabel}` : ''} · ${bookedByLabel(b, { short: true })}</span></span>
      ${b.status === 'TEMPORARY' && b.holdExpiresAt ? html`<span class="pill amber sm">${icon('hourglass', 12, 2.4)}On hold</span>` : statusPill(b.status, { small: true })}
    </div>
  </a>`;
}

export function bookingsListView({ query }) {
  const f = readFilters(query);
  const root = frame({
    key: 'bookings',
    title: 'Bookings',
    actions: html`<label class="search-pill only-desktop">${icon('search', 18)}<input type="search" placeholder="Search customer or reference" aria-label="Search bookings" data-q value="${f.q}"></label>
      <a class="btn btn-primary btn-sm only-desktop" href="${BASE}/bookings/new">${icon('plus', 18, 2.4)}New booking</a>`,
    template: html`<div class="page">
      <div class="row only-mobile" data-gap="8"><label class="search-pill grow">${icon('search', 18)}<input type="search" placeholder="Name or booking reference" aria-label="Search bookings" data-q value="${f.q}"></label><a class="btn btn-primary btn-sm" href="${BASE}/bookings/new">${icon('plus', 18, 2.4)}New</a></div>
      <div class="chip-row" role="group" aria-label="Status" data-chips></div>
      <div class="filters">
        <select class="select" data-f="scope" aria-label="Dates"><option value="upcoming">Upcoming</option><option value="past">Past</option><option value="all">All dates</option></select>
        <input class="input" type="date" data-f="date" aria-label="Exact date" value="${f.date}">
        <select class="select" data-f="activity" aria-label="Activity"><option value="">Activity: All</option><option value="pickleball">Pickleball</option><option value="table_tennis">Table tennis</option></select>
        <button type="button" class="btn btn-text btn-sm" data-act="clear">Clear filters</button>
      </div>
      <div data-list>${skeletonRows(6)}</div>
    </div>`,
  });
  for (const sel of root.querySelectorAll('select[data-f]')) sel.value = f[sel.dataset.f] || '';
  const list = $('[data-list]', root);
  let data = null;
  let timer = null;

  function sync() {
    const qs = toQuery(f);
    history.replaceState(history.state, '', `${BASE}/bookings${qs ? `?${qs}` : ''}`);
  }

  function paint() {
    render($('[data-chips]', root), CHIPS.map((c) => html`<button type="button" class="chip${c.violet ? ' violet' : ''}" data-status="${c.key}" aria-pressed="${f.status === c.key ? 'true' : 'false'}">${c.label} · ${c.count(data.counts)}</button>`));
    if (!data.bookings.length) {
      render(list, html`<div class="empty"><span class="tile blue lg">${icon('search', 26)}</span><p class="empty-title">No bookings match</p><p class="empty-body">Try another status or clear the filters.</p></div>`);
      return;
    }
    render(list, html`<div class="table-wrap only-desktop"><table class="grid">
        <thead><tr><th>Reference</th><th>Customer</th><th>Activity · resource</th><th>Date &amp; time</th><th class="r">Amount</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${data.bookings.map(tableRow)}</tbody></table></div>
      <div class="stack stack-8 only-mobile">${data.bookings.map(mobileCard)}</div>
      <p class="small">Showing ${data.bookings.length} booking${data.bookings.length === 1 ? '' : 's'}${data.bookings.length === 200 ? ' (first 200 — narrow the filters to see more)' : ''}.</p>`);
  }

  async function load() {
    const qs = new URLSearchParams();
    if (f.status !== 'all') qs.set('status', f.status);
    if (f.q) qs.set('q', f.q);
    if (f.date) qs.set('date', f.date);
    if (f.activity) qs.set('activity', f.activity);
    if (!f.date) qs.set('scope', f.scope);
    try {
      data = await api.get(`${API}/bookings?${qs}`);
      paint();
    } catch (err) {
      render(list, errorState(err));
      $('[data-act="retry"]', list)?.addEventListener('click', load);
    }
  }

  on(root, 'click', '[data-status]', (_e, btn) => {
    f.status = btn.dataset.status;
    if (f.status === 'PAYMENT_SUBMITTED' || f.status === 'holds') f.scope = 'all';
    for (const sel of root.querySelectorAll('select[data-f="scope"]')) sel.value = f.scope;
    sync();
    load();
  });
  on(root, 'change', '[data-f]', (_e, el) => {
    f[el.dataset.f] = el.value;
    sync();
    load();
  });
  const offTop = on(document.getElementById('topbar'), 'input', '[data-q]', (_e, el) => search(el.value));
  on(root, 'input', '[data-q]', (_e, el) => search(el.value));
  function search(v) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      f.q = v.trim();
      sync();
      load();
    }, 300);
  }
  on(root, 'click', '[data-act="clear"]', () => {
    Object.assign(f, { status: 'all', q: '', date: '', activity: '', scope: 'upcoming' });
    for (const el of document.querySelectorAll('[data-q]')) el.value = '';
    for (const sel of root.querySelectorAll('[data-f]')) sel.value = f[sel.dataset.f] || '';
    sync();
    load();
  });
  load();
  const stop = poll(load, 30_000);
  return () => {
    stop();
    offTop();
    clearTimeout(timer);
  };
}

// ── Booking details (A16) ──────────────────────────────────────────────────

function heroSide(b) {
  if ((b.status === 'CONFIRMED' || b.status === 'COMPLETED') && b.paymentMethod === 'none') return html`<span class="small light-blue">Booked on site</span><span class="mono hero-amt">No charge</span>`;
  if ((b.status === 'CONFIRMED' || b.status === 'COMPLETED') && b.paymentMethod === 'on_site') return html`<span class="small light-blue">Paid on site</span><span class="mono hero-amt">${b.amountLabel}</span>`;
  if (b.status === 'CONFIRMED' || b.status === 'COMPLETED') return html`<span class="small light-blue">Paid · verified</span><span class="mono hero-amt">${b.amountLabel}</span>`;
  if (b.status === 'PAYMENT_SUBMITTED') return html`<span class="small light-blue">Proof submitted · verify</span><span class="mono hero-amt">${b.amountLabel}</span>`;
  if (b.status === 'TEMPORARY' || b.status === 'REJECTED') return html`<span class="small light-blue">Unpaid hold</span><span class="mono hero-amt">${b.amountLabel}</span>`;
  return html`<span class="small light-blue">${b.status === 'CANCELLED' ? 'Cancelled' : 'Expired'}</span><span class="mono hero-amt">${b.amountLabel}</span>`;
}

function openStaffCancel(b, onDone) {
  let busy = false;
  const m = openModal({
    label: 'Cancel this booking?',
    locked: () => busy,
    content: () => html`<span class="tile red">${icon('circle-slash', 24)}</span>
      <h2 class="dialog-title">Cancel this booking?</h2>
      <p class="body"><b>${b.resource.name} · ${weekdayShort(b.date)}, ${shortDate(b.date)} · ${bookingTime(b)}</b> is released to other players and ${b.user.name} is notified with your reason.${b.status === 'CONFIRMED' ? ' Arrange any refund in the booking chat.' : ''}</p>
      <div class="field"><label class="label" for="c-reason">Reason for ${b.user.name.split(' ')[0]} <span class="req">*</span></label><textarea class="textarea" id="c-reason" maxlength="300" placeholder="e.g. Court closed for an emergency repair"></textarea></div>
      <div class="dialog-actions"><button type="button" class="btn btn-danger btn-block" data-act="go" disabled>Cancel booking</button><button type="button" class="btn btn-secondary btn-block" data-close>Keep booking</button></div>`,
    onOpen: (panel) => {
      const ta = panel.querySelector('#c-reason');
      const go = panel.querySelector('[data-act="go"]');
      ta.addEventListener('input', () => (go.disabled = ta.value.trim().length < 3));
      go.addEventListener('click', async () => {
        busy = true;
        setBusy(go, true, 'Cancelling…');
        try {
          await api.post(`${API}/bookings/${b.id}/cancel`, { reason: ta.value.trim() });
          busy = false;
          m.close();
          toast('Booking cancelled', { sub: `${b.user.name} was notified.` });
          onDone();
        } catch (err) {
          busy = false;
          setBusy(go, false);
          toast(err.message, { type: 'error' });
        }
      });
    },
  });
}

export async function bookingDetailView({ params }) {
  const id = params.id;
  let d = null;
  let chat = null;
  let paintedKey = '';
  const root = frame({
    key: 'bookings',
    eyebrow: 'Bookings / Details',
    title: 'Booking details',
    mobileHeader: null,
    tabs: false,
    template: html`<div data-body>${skeletonRows(4, 'sk-card')}</div>`,
  });
  const body = $('[data-body]', root);

  function paint() {
    const b = d.booking;
    const p = d.proofs[0];
    // Polls repaint only when something changed, so an open chat isn't disturbed.
    const key = JSON.stringify({ ...d, now: 0 });
    if (key === paintedKey) return;
    paintedKey = key;
    const topTitle = document.querySelector('#topbar .tb-title');
    if (topTitle) {
      topTitle.textContent = b.ref;
      topTitle.classList.add('mono');
    }
    const canCancel = d.actions.canCancel;
    render(body, html`<div class="tb-mobile">
        <div class="row row-between"><a class="icon-btn" href="${BASE}/bookings" data-back aria-label="Back to bookings">${icon('chevron-left', 22, 2.2)}</a>${statusPill(b.status, { small: true })}</div>
        <div><p class="m-title">${b.user.name}</p><p class="small light-text mono">${b.ref}</p></div>
      </div>
      <div class="page no-tabbar">
        <div class="row row-wrap only-desktop" data-gap="12"><a class="icon-btn" href="${BASE}/bookings" data-back aria-label="Back to bookings">${icon('chevron-left', 22, 2.2)}</a>${statusPill(b.status, { small: true })}
          <span class="ml-auto row" data-gap="8"><button type="button" class="btn btn-tonal btn-sm" data-act="open-chat">${icon('chat', 18)}Open chat</button>${canCancel ? html`<button type="button" class="btn btn-danger-outline btn-sm" data-act="cancel">Cancel booking</button>` : ''}</span></div>
        ${b.status === 'PAYMENT_SUBMITTED' ? html`<div class="banner violet">${icon('shield-clock', 20, 2.2)}<div class="grow"><b>Waiting for payment verification.</b> ${b.user.name} sent proof ${b.submittedAt ? `at ${clock(b.submittedAt)}` : ''}.</div><a class="btn btn-violet btn-sm" href="${BASE}/verify/${b.id}">Review payment</a></div>` : ''}
        <div class="cols c-155">
          <div class="stack stack-16">
            <section class="hero-ticket admin-hero"><span class="ticket-art">${courtArt()}</span>
              <div class="ht-top row row-between row-top">
                <div class="stack stack-4"><span class="overline ht-over">${b.activityLabel}</span><p class="ht-name">${b.resource.name}</p><p class="ht-when">${longDate(b.date)} · ${bookingTime(b)}${b.durationMin > 60 ? ` · ${b.durationLabel}` : ''}</p></div>
                <div class="stack stack-4 hero-side">${heroSide(b)}</div>
              </div></section>
            <section class="panel panel-body stack stack-12"><p class="eyebrow">Booking timeline</p>
              <ol class="timeline">${d.timeline.map((e, i) => html`<li class="tl-item ${e.type === 'rejected' ? 'error' : i === d.timeline.length - 1 && (b.status === 'CONFIRMED' || b.status === 'COMPLETED') ? 'final' : 'done'}">
                <span class="tl-node">${icon(e.type === 'rejected' ? 'x' : 'check', 14, 3)}</span>
                <span class="tl-text">${e.label}<span class="tl-sub">${[e.actor ? `by ${e.actor}` : '', e.note].filter(Boolean).join(' · ')}</span></span>
                <span class="tl-time">${isoDate(e.at) === isoDate(Date.now()) ? clock(e.at) : dayClock(e.at)}</span></li>`)}</ol></section>
            <section class="panel panel-body stack stack-12"><p class="eyebrow">Payment</p>
              ${p ? html`<div class="row row-top" data-gap="16">
                <button type="button" class="vq-thumb" data-act="proof" aria-label="Open payment proof"><img src="${p.url}" alt=""><span class="view-chip">View</span></button>
                <dl class="kv grow">
                  <div><dt>Method</dt><dd>GCash · proof</dd></div>
                  <div><dt>Reference</dt><dd class="mono">${p.gcashRef || 'Not provided'}</dd></div>
                  <div><dt>Amount</dt><dd>${p.amountClaimedLabel ? `${p.amountClaimedLabel} claimed` : 'Not entered'} · ${b.amountLabel} due</dd></div>
                  <div><dt>${b.status === 'CONFIRMED' || b.status === 'COMPLETED' ? 'Verified by' : 'Proof status'}</dt><dd>${b.confirmedBy || (p.status === 'rejected' ? `Rejected${b.rejectedBy ? ` by ${b.rejectedBy}` : ''}` : p.status === 'submitted' ? 'Waiting for verification' : p.status)}</dd></div>
                </dl></div>` : b.paymentMethod !== 'gcash' ? html`<dl class="kv">
                  <div><dt>Method</dt><dd>${b.paymentMethodLabel}</dd></div>
                  <div><dt>Amount</dt><dd>${b.paymentMethod === 'none' ? 'No charge · not counted as revenue' : html`<span class="mono">${b.amountLabel}</span> · collected at the front desk`}</dd></div>
                  <div><dt>Recorded by</dt><dd>${b.confirmedBy || '—'}</dd></div>
                </dl>` : html`<p class="small">No payment proof${b.status === 'TEMPORARY' ? ' yet — the player is still in the payment window.' : '.'}</p>`}
              ${d.proofs.length > 1 ? html`<p class="small">${d.proofs.length} proofs uploaded for this booking.</p>` : ''}
            </section>
          </div>
          <div class="stack stack-16">
            <section class="panel panel-body stack stack-12"><p class="eyebrow">Customer</p>
              <div class="row" data-gap="12"><span class="avatar">${initials(b.user.name)}</span><span class="grow strong">${b.user.name}</span>${memberTag(b.user.membership, { small: true })}</div>
              <dl class="kv"><div><dt>Phone</dt><dd>${b.user.phone ? html`<a href="tel:${b.user.phone.replace(/[^\d+]/g, '')}" data-native>${b.user.phone}</a>` : '—'}</dd></div><div><dt>Email</dt><dd class="ellipsis"><a href="mailto:${b.user.email}" data-native>${b.user.email}</a></dd></div><div><dt>Rate</dt><dd>${b.rate === 'member' ? 'Member' : 'Non-member'} · ${b.amountLabel}${b.durationMin > 60 ? ` for ${b.durationLabel}` : ''}</dd></div><div><dt>Booked by</dt><dd>${bookedByLabel(b)}</dd></div></dl>
            </section>
            <div data-chat-slot></div>
            ${canCancel ? html`<button type="button" class="btn btn-danger-outline btn-block only-mobile" data-act="cancel">Cancel booking</button>` : ''}
            ${b.cancelReason ? html`<section class="panel panel-body"><p class="eyebrow">Cancellation</p><p class="body">${b.cancelReason}</p><p class="meta">${b.cancelledAt ? dayClock(b.cancelledAt) : ''}</p></section>` : ''}
          </div>
        </div>
      </div>`);
    for (const a of body.querySelectorAll('[data-back]')) {
      a.addEventListener('click', (e) => {
        if (history.state && history.state.depth > 0) {
          e.preventDefault();
          history.back();
        }
      });
    }
    if (!chat) chat = miniChat({ bookingId: b.id, playerName: b.user.name, unread: d.unreadMessages });
    chat.setUnread(d.unreadMessages);
    chat.mount($('[data-chat-slot]', body));
  }

  on(body, 'click', '[data-act="cancel"]', () => openStaffCancel(d.booking, load));
  on(body, 'click', '[data-act="open-chat"]', () => chat?.show());
  on(body, 'click', '[data-act="proof"]', () => {
    const p = d.proofs[0];
    openViewer({ url: p.url, booking: d.booking, proof: { ...p, submittedAt: p.createdAt }, onDecision: load, canDecide: d.booking.status === 'PAYMENT_SUBMITTED' });
  });

  async function load() {
    try {
      d = await api.get(`${API}/bookings/${encodeURIComponent(id)}`);
      paint();
    } catch (err) {
      paintedKey = '';
      render(body, html`<div class="page">${errorState(err, { retry: err.status !== 404, title: err.status === 404 ? 'Booking not found' : undefined })}</div>`);
      $('[data-act="retry"]', body)?.addEventListener('click', load);
    }
  }
  await load();
  const stop = poll(load, 20_000);
  return () => {
    stop();
    chat?.destroy();
  };
}

