import { api } from '../../core/api.js';
import { $, $$, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { addDays, durationLabel, isoDate, longDate, mergeStarts, minutesLabel, peso, rangeLabel, rangeLabelFull } from '../../core/format.js';
import { errorState, poll, skeletonRows, toast } from '../../core/ui.js';
import { frame, navigate, state } from '../shell.js';
import { API, BASE, CONSOLE } from '../console.js';

const ACTIVITIES = [
  { id: 'pickleball', label: 'Pickleball' },
  { id: 'table_tennis', label: 'Table tennis' },
];

const PAYMENTS = [
  { id: 'on_site', title: 'Paid on site', sub: 'Cash or GCash at the front desk · counted as revenue' },
  { id: 'none', title: 'No charge', sub: 'Personal use · not counted as revenue' },
];

const NOT_BOOKABLE = { maintenance: ' · maintenance', open_play: ' · open play' };
const LOCKED_LABEL = { held: 'On hold', unavailable: 'Verifying', booked: 'Booked', closed: 'Closed', past: 'Started', maintenance: 'Maintenance', open_play: 'Open play' };

async function rules() {
  if (!state.settings) {
    try {
      state.settings = (await api.get(`${API}/rules`)).settings;
    } catch {
      state.settings = { bookingWindowDays: 14, slotMinutes: 60 };
    }
  }
  return state.settings;
}

/**
 * A personal booking made on site by the signed-in staff member or admin (A-NB).
 * It is booked under their own account, skips the GCash proof step and is confirmed
 * at once. Like the player app, any open times on one court or table can be picked,
 * gaps allowed. The booking records who made it ("Staff · Ana Reyes" / "Admin · …").
 */
export async function newBookingView({ query }) {
  const r = await rules();
  const me = state.user;
  const today = isoDate(Date.now());
  const lastDay = addDays(today, r.bookingWindowDays ?? 14);
  const f = {
    activity: ACTIVITIES.some((a) => a.id === query.get('activity')) ? query.get('activity') : 'pickleball',
    date: /^\d{4}-\d{2}-\d{2}$/.test(query.get('date') || '') && query.get('date') >= today && query.get('date') <= lastDay ? query.get('date') : today,
    resourceId: query.get('resource') || null,
    rate: me.membership === 'member' ? 'member' : 'non_member',
    payment: 'on_site',
  };
  const picked = new Set();
  let day = null;

  const root = frame({
    key: 'bookings',
    eyebrow: 'Bookings / New',
    title: 'New booking',
    mobileHeader: null,
    tabs: false,
    template: html`<div class="tb-mobile">
        <div class="row" data-gap="8"><a class="icon-btn" href="${BASE}/bookings" aria-label="Back to bookings">${icon('chevron-left', 22, 2.2)}</a><p class="m-title">New booking</p></div>
      </div>
      <div class="page no-tabbar">
        <p class="banner neutral compact">${icon('info', 18, 2.2)}<span>For <b>personal bookings on site</b>. It's booked under your account (${me.name}), confirmed right away with no GCash proof, and recorded as <b>booked by ${CONSOLE.roleLabel.toLowerCase()}</b>. Players book in the app.</span></p>
        <div class="cols c-155">
          <div class="stack stack-16">
            <section class="panel panel-body stack stack-12">
              <p class="eyebrow">Court or table</p>
              <div class="seg" role="group" aria-label="Activity" data-activity></div>
              <div class="field"><label class="label" for="nb-date">Date</label><input class="input" type="date" id="nb-date" min="${today}" max="${lastDay}" value="${f.date}" data-date></div>
              <div class="chip-row nb-resources" role="group" aria-label="Court or table" data-resources></div>
            </section>
            <section class="panel panel-body stack stack-12">
              <div class="row row-between"><p class="eyebrow">Times</p><span class="small" data-hours></span></div>
              <p class="small">Pick every time you want. They don't have to be back to back.</p>
              <div class="slots" role="group" aria-label="Times" data-slots>${skeletonRows(4)}</div>
            </section>
          </div>
          <div class="stack stack-16">
            <section class="panel panel-body stack stack-12" data-summary-panel>
              <p class="eyebrow">Your booking</p>
              <div class="stack stack-8"><span class="label" id="nb-rate">Rate</span><div class="seg" role="group" aria-labelledby="nb-rate" data-rate></div></div>
              <div class="stack stack-8" role="radiogroup" aria-labelledby="nb-pay"><span class="label" id="nb-pay">Payment</span><div class="stack stack-8" data-payment></div></div>
              <dl class="kv" data-summary></dl>
              <button type="button" class="btn btn-primary btn-block" data-act="book" disabled>Pick a time</button>
              <p class="small">Confirmed bookings can't be cancelled from the console, so check the times before booking.</p>
            </section>
          </div>
        </div>
      </div>`,
  });

  const slotsEl = $('[data-slots]', root);
  const bookBtn = $('[data-act="book"]', root);
  const slotMin = () => (day ? day.slotMinutes : r.slotMinutes || 60);
  const sorted = () => [...picked].sort((a, b) => a - b);
  const resource = () => (day ? day.resources.find((x) => x.id === f.resourceId) || null : null);

  function syncUrl() {
    const p = new URLSearchParams({ activity: f.activity, date: f.date });
    if (f.resourceId) p.set('resource', f.resourceId);
    history.replaceState(history.state, '', `${BASE}/bookings/new?${p}`);
  }

  function paintControls() {
    render($('[data-activity]', root), ACTIVITIES.map((a) => html`<button type="button" data-activity-id="${a.id}" aria-pressed="${String(f.activity === a.id)}">${a.label}</button>`));
    render($('[data-rate]', root), [['member', 'Member'], ['non_member', 'Non-member']].map(([k, label]) => html`<button type="button" data-rate-id="${k}" aria-pressed="${String(f.rate === k)}">${label}</button>`));
    render($('[data-payment]', root), PAYMENTS.map((p) => html`<button type="button" class="reason-opt choice" role="radio" aria-checked="${String(f.payment === p.id)}" data-pay="${p.id}"><span class="radio"></span><span><span class="strong">${p.title}</span><br><span class="small">${p.sub}</span></span></button>`));
  }

  function paintSummary() {
    const res = resource();
    const price = res ? (f.rate === 'member' ? res.priceMember : res.priceNonMember) : null;
    const starts = sorted();
    const n = starts.length;
    const ranges = mergeStarts(starts, slotMin());
    const total = f.payment === 'none' ? 0 : price != null ? price * n : null;
    render($('[data-summary]', root), html`
      <div><dt>${f.activity === 'table_tennis' ? 'Table' : 'Court'}</dt><dd>${res ? res.name : '—'}</dd></div>
      <div><dt>Date</dt><dd>${longDate(f.date)}</dd></div>
      <div><dt>${ranges.length > 1 ? 'Times' : 'Time'}</dt><dd>${n ? ranges.map((s, i) => html`${i ? html`<br>` : ''}${rangeLabelFull(s.start, s.end)}`) : '—'}</dd></div>
      <div><dt>Duration</dt><dd>${n ? `${durationLabel(n * slotMin())}${ranges.length > 1 ? ` · ${n} slots` : ''}` : '—'}</dd></div>
      <div><dt>Booked by</dt><dd>${CONSOLE.role === 'admin' ? 'Admin' : 'Staff'} · ${me.name}</dd></div>
      <div><dt>Total</dt><dd class="mono big-amt">${f.payment === 'none' ? 'No charge' : n && total != null ? peso(total) : '—'}</dd></div>
      ${f.payment === 'on_site' && price != null && n > 1 ? html`<div><dt></dt><dd class="small">${n} × ${peso(price)} ${f.rate === 'member' ? 'member' : 'non-member'} rate</dd></div>` : ''}`);
    bookBtn.disabled = !res || !n;
    bookBtn.textContent = !res ? 'Pick a court or table' : !n ? 'Pick a time' : `Book & confirm${f.payment === 'on_site' && total != null ? ` · ${peso(total)}` : ''}`;
  }

  function paintDay() {
    if (!day) return;
    const resources = day.resources;
    if (!resources.some((x) => x.id === f.resourceId)) f.resourceId = (resources.find((x) => x.status === 'active') || resources[0] || {}).id || null;
    render($('[data-resources]', root), resources.map((x) => html`<button type="button" class="chip" data-res="${x.id}" aria-pressed="${String(f.resourceId === x.id)}" ${x.status !== 'active' ? 'disabled' : ''}>${x.name}${NOT_BOOKABLE[x.status] || ''}</button>`));
    $('[data-hours]', root).textContent = day.hours ? `Open ${day.hours.label}` : day.closedReason || 'Closed';
    const res = resource();
    if (!res) {
      render(slotsEl, html`<p class="small">No courts or tables for this activity.</p>`);
    } else if (!res.slots.length) {
      render(slotsEl, html`<p class="small">${day.closedReason ? `Closed · ${day.closedReason}` : 'Closed on this day.'}</p>`);
    } else {
      render(slotsEl, res.slots.map((s) => {
        const range = rangeLabel(s.start, s.end);
        if (s.state === 'available') {
          const sel = picked.has(s.start);
          return html`<button type="button" class="slot available" role="checkbox" aria-checked="${String(sel)}" data-start="${s.start}" aria-label="${range}, ${sel ? 'selected' : 'available'}">
            <span class="s-time">${range}</span>
            ${sel ? html`<span class="s-state"><span class="s-check">${icon('check', 14, 3)}</span>Selected</span>` : html`<span class="s-state"><span class="s-dot"></span>Available</span>`}
          </button>`;
        }
        const who = s.booking ? s.booking.userName : '';
        return html`<div class="slot locked ${s.state}" role="checkbox" aria-checked="false" aria-disabled="true" aria-label="${range}, ${(LOCKED_LABEL[s.state] || 'Unavailable').toLowerCase()}"><span><span class="s-time">${range}</span>${who ? html`<span class="s-reason">${who}</span>` : ''}</span><span class="s-state">${LOCKED_LABEL[s.state] || 'Unavailable'}</span></div>`;
      }));
    }
    paintControls();
    paintSummary();
  }

  async function load(quiet = false) {
    try {
      day = await api.get(`${API}/schedule?date=${f.date}&activity=${f.activity}`);
      // Drop picked times that were taken meanwhile.
      const res = resource();
      const lost = res ? sorted().filter((s) => res.slots.find((x) => x.start === s)?.state !== 'available') : [];
      for (const s of lost) picked.delete(s);
      if (lost.length && quiet) toast(lost.length === 1 ? `${minutesLabel(lost[0])} was just taken` : `${lost.length} of your times were just taken`, { type: 'warn', sub: 'They were removed from your selection.' });
      paintDay();
    } catch (err) {
      if (quiet) return;
      render(slotsEl, errorState(err));
      $('[data-act="retry"]', slotsEl)?.addEventListener('click', () => load());
    }
  }

  function reset(what) {
    Object.assign(f, what);
    picked.clear();
    syncUrl();
    render(slotsEl, skeletonRows(4));
    load();
  }

  on(root, 'click', '[data-activity-id]', (_e, b) => reset({ activity: b.dataset.activityId, resourceId: null }));
  on(root, 'change', '[data-date]', (_e, el) => {
    if (el.value && el.value >= today && el.value <= lastDay) reset({ date: el.value });
    else el.value = f.date;
  });
  on(root, 'click', '[data-res]', (_e, b) => {
    f.resourceId = b.dataset.res;
    picked.clear();
    syncUrl();
    paintDay();
  });
  on(slotsEl, 'click', '.slot.available', (_e, b) => {
    const start = Number(b.dataset.start);
    if (picked.has(start)) picked.delete(start);
    else picked.add(start);
    paintDay();
    slotsEl.querySelector(`[data-start="${start}"]`)?.focus();
  });
  slotsEl.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const items = $$('.slot.available', slotsEl);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
  });
  on(root, 'click', '[data-rate-id]', (_e, b) => {
    f.rate = b.dataset.rateId;
    paintControls();
    paintSummary();
  });
  on(root, 'click', '[data-pay]', (_e, b) => {
    f.payment = b.dataset.pay;
    paintControls();
    paintSummary();
  });
  bookBtn.addEventListener('click', async () => {
    if (!picked.size || !f.resourceId) return;
    setBusy(bookBtn, true, 'Booking…');
    try {
      const res = await api.post(`${API}/bookings`, {
        resourceId: f.resourceId, date: f.date, starts: sorted(), rate: f.rate, payment: f.payment,
      });
      toast('Booking confirmed', { sub: `${res.booking.resource.name} · ${res.booking.timeLabel} · ${res.booking.ref}` });
      navigate(`${BASE}/bookings/${res.booking.id}`, { replace: true });
    } catch (err) {
      setBusy(bookBtn, false);
      toast(err.message, { type: 'error' });
      if (err.code === 'SLOT_TAKEN' || err.code === 'TIME_STARTED' || err.code === 'CLOSED') load();
      else paintSummary();
    }
  });

  syncUrl();
  await load();
  return poll(() => load(true), 30_000);
}
