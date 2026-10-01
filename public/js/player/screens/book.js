import { api } from '../../core/api.js';
import { $, $$, html, on, render, setBusy } from '../../core/dom.js';
import { icon, courtArt, tableArt, resourceGlyph } from '../../core/icons.js';
import {
  activityLabel, activityNoun, dateLabel, dayMonth, hourLabel, longDate, minutesLabel, peso, rangeLabel, rangeLabelFull, shortDate,
} from './util.js';
import { errorState, memberTag, openModal, poll, skeletonRows, toast } from '../../core/ui.js';
import { navigate, show, state, wizardHeader } from '../shell.js';

const ACTIVITIES = ['pickleball', 'table_tennis'];
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

function badActivity(activity) {
  if (ACTIVITIES.includes(activity)) return false;
  navigate('/book', { replace: true });
  return true;
}

function rateFor(user) {
  return user.membership === 'member' ? 'member' : 'non_member';
}

function rateLabel(user) {
  return user.membership === 'member' ? 'Member rate' : 'Non-member rate';
}

// ── Step 1: activity (U04) ─────────────────────────────────────────────────

export function activityStep() {
  const f = state.facility;
  const member = state.user.membership === 'member';
  const root = show(html`<div class="screen screen-enter">
    ${wizardHeader({ step: 1, label: 'Activity', sub: 'New booking' })}
    <h1 class="h1">What would you like to play?</h1>
    <div class="stack stack-16">
      ${f.activities.map((a) => html`<a class="activity-card${a.id === 'table_tennis' ? ' tt' : ''}" href="/book/${a.id}">
        <div class="a-art">${a.id === 'table_tennis' ? tableArt() : courtArt()}<span class="pill volt sm" data-open="${a.id}">Checking…</span></div>
        <div class="a-body">
          <div class="grow stack stack-4">
            <span class="overline blue">${a.label}</span>
            <span class="a-title">Book a ${a.id === 'table_tennis' ? 'table tennis table' : 'pickleball court'}</span>
            <span class="small">${a.count} ${a.unit}${a.count === 1 ? '' : 's'} · ${member ? a.priceMemberLabel : a.priceNonMemberLabel} / hour · ${member ? 'member' : 'non-member'} rate</span>
          </div>
          <span class="a-arrow">${icon('arrow-right', 20, 2.4)}</span>
        </div>
      </a>`)}
    </div>
  </div>`);
  for (const a of f.activities) {
    api.get(`/api/availability/days?activity=${a.id}`).then((res) => {
      const el = root.querySelector(`[data-open="${a.id}"]`);
      if (!el) return;
      const today = res.days[0];
      el.textContent = today && today.available ? `${today.available} open today` : 'Book ahead';
    }).catch(() => {
      const el = root.querySelector(`[data-open="${a.id}"]`);
      if (el) el.hidden = true;
    });
  }
}

// ── Step 2: date (U05, U05B) ───────────────────────────────────────────────

const LOAD_TEXT = { open: 'Open', few: 'Few left', full: 'Full', closed: 'Closed' };

function resourcesOn(activity, date) {
  return state.facility.resources.filter((r) => r.activity === activity).map((r) => {
    const maint = r.maintenance && (!r.maintenance.until || date < r.maintenance.until);
    return { ...r, maint };
  });
}

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function dayCard(activity, day) {
  const wd = new Date(`${day.date}T00:00:00Z`).getUTCDay();
  const hours = state.facility.hours.find((h) => h.weekday === wd);
  const res = resourcesOn(activity, day.date);
  const open = res.filter((r) => !r.maint).map((r) => r.name);
  const maint = res.filter((r) => r.maint).map((r) => r.name);
  const detail = [open.length ? joinNames(open) : '', maint.length ? `${joinNames(maint)} in maintenance` : ''].filter(Boolean).join(' · ');
  let box;
  if (day.load === 'closed') {
    box = html`<div class="count-box closed"><span>${icon('circle-slash', 22)}</span><div><div class="strong">${day.closedReason || 'Closed'}</div><div class="small">No bookable times on this day</div></div></div>`;
  } else if (day.load === 'full') {
    box = html`<div class="count-box full"><span class="mono">0</span><div><div class="strong">Fully booked</div><div class="small">Every ${activityNoun(activity)} is booked or on hold this day</div></div></div>`;
  } else {
    box = html`<div class="count-box ${day.load === 'few' ? 'few' : ''}"><span class="mono">${day.available}</span><div><div class="strong">${day.load === 'few' ? 'open slots — going fast' : 'open slots'}</div><div class="small">${detail}</div></div></div>`;
  }
  return html`<section class="card day-card" aria-live="polite">
    <p class="h3">${dayMonth(day.date)}</p>
    <p class="row small" data-gap="8">${icon('clock', 18)}${hours && hours.isOpen ? `Open ${hours.label}` : 'Closed'}</p>
    ${box}
    <div class="legend"><span><i class="open"></i>Open</span><span><i class="few"></i>Few left</span><span><i class="full"></i>Full / closed</span><span><i class="today"></i>Today</span></div>
  </section>`;
}

function dayButton(d, selected) {
  const top = d.isToday ? 'Today' : d.weekday;
  const label = `${dayMonth(d.date)}, ${LOAD_TEXT[d.load]}${d.isToday ? ', today' : ''}`;
  return html`<button type="button" class="day load-${d.load}${d.isToday ? ' today' : ''}" data-date="${d.date}" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${label}">
    <span class="d-top">${top}</span><span class="d-num">${d.day}</span><span class="d-sub">${LOAD_TEXT[d.load]}</span>
  </button>`;
}

export function dateStep({ params, query }) {
  const activity = params.activity;
  if (badActivity(activity)) return;
  let days = [];
  let selected = isDate(query.get('date')) ? query.get('date') : null;
  const root = show(html`<div class="screen has-sticky screen-enter">
    ${wizardHeader({ step: 2, label: 'Date', sub: activityLabel(activity), backHref: '/book' })}
    <div class="page-title-row"><div><h1 class="h1">Pick a date</h1><p class="small" data-range></p></div>
      <button type="button" class="btn btn-secondary btn-sm" data-act="calendar">${icon('calendar', 18)}Calendar</button></div>
    <div class="date-strip" role="group" aria-label="Dates" data-strip>${skeletonRows(1)}</div>
    <div data-daycard></div>
    <p class="small">Bookings open ${state.facility.rules.bookingWindowDays} days ahead. Availability is live and needs an internet connection.</p>
  </div>
  <div class="sticky-bar"><div class="sticky-inner"><button type="button" class="btn btn-primary btn-lg btn-block glow" data-act="continue" disabled>Continue</button></div></div>`);

  const strip = $('[data-strip]', root);
  const cardEl = $('[data-daycard]', root);
  const cta = $('[data-act="continue"]', root);

  function paint({ scroll = false } = {}) {
    render(strip, days.map((d) => dayButton(d, d.date === selected)));
    const day = days.find((d) => d.date === selected);
    render(cardEl, day ? dayCard(activity, day) : '');
    if (day && (day.load === 'open' || day.load === 'few')) {
      cta.disabled = false;
      cta.innerHTML = '';
      render(cta, html`Continue · ${dateLabel(day.date)} ${icon('arrow-right', 20, 2.4)}`);
    } else {
      cta.disabled = true;
      cta.textContent = day && day.load === 'full' ? 'Fully booked — pick another date' : 'Closed — pick another date';
    }
    if (days.length) {
      const m1 = shortDate(days[0].date).split(' ')[0];
      const m2 = shortDate(days[days.length - 1].date).split(' ')[0];
      $('[data-range]', root).textContent = `${m1 === m2 ? m1 : `${m1} – ${m2}`} ${days[days.length - 1].date.slice(0, 4)}`;
    }
    if (scroll) strip.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function select(date) {
    selected = date;
    history.replaceState(history.state, '', `/book/${activity}?date=${date}`);
    paint();
  }

  on(strip, 'click', '[data-date]', (_e, btn) => select(btn.dataset.date));
  cta.addEventListener('click', () => navigate(`/book/${activity}/${selected}`));
  on(root, 'click', '[data-act="calendar"]', () => openCalendar(days, selected, (d) => {
    select(d);
    paint({ scroll: true });
  }));

  async function load() {
    try {
      const res = await api.get(`/api/availability/days?activity=${activity}`);
      days = res.days;
      if (!selected || !days.some((d) => d.date === selected)) {
        selected = (days.find((d) => d.load === 'open' || d.load === 'few') || days[0]).date;
      }
      paint({ scroll: true });
    } catch (err) {
      render(strip, '');
      render(cardEl, errorState(err, { title: "Couldn't load live availability" }));
      $('[data-act="retry"]', cardEl)?.addEventListener('click', load);
    }
  }
  load();
  return poll(async () => {
    const res = await api.get(`/api/availability/days?activity=${activity}`);
    days = res.days;
    paint();
  }, 30_000);
}

function openCalendar(days, selected, onPick) {
  if (!days.length) return;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = days[0].date;
  let month = selected.slice(0, 7);
  let pick = selected;
  const monthTitle = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shiftMonth = (m, n) => {
    const d = new Date(`${m}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 7);
  };
  const minMonth = first.slice(0, 7);
  const maxMonth = days[days.length - 1].date.slice(0, 7);
  const grid = () => {
    const start = new Date(`${month}-01T00:00:00Z`);
    const lead = start.getUTCDay();
    const count = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(html`<span></span>`);
    for (let d = 1; d <= count; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const info = byDate.get(date);
      if (!info) {
        cells.push(html`<button type="button" class="cal-cell off" disabled aria-label="${dayMonth(date)}, not open for booking">${d}</button>`);
        continue;
      }
      const disabled = info.load === 'full' || info.load === 'closed';
      cells.push(html`<button type="button" class="cal-cell load-${info.load}" data-cal="${date}" aria-pressed="${date === pick ? 'true' : 'false'}" ${disabled ? 'disabled' : ''} aria-label="${dayMonth(date)}, ${info.load === 'few' ? 'few slots left' : info.load === 'full' ? 'fully booked' : info.load}"><span>${d}</span><i></i></button>`);
    }
    return cells;
  };
  const view = (close) => html`<div class="sheet-head"><h2 class="h3">Choose a date</h2><button type="button" class="icon-btn sm flat" data-close aria-label="Close calendar">${icon('x', 18, 2.2)}</button></div>
    <div class="row row-between">
      <button type="button" class="icon-btn sm" data-month="-1" ${month <= minMonth ? 'disabled' : ''} aria-label="${monthTitle(shiftMonth(month, -1))}">${icon('chevron-left', 20, 2.2)}</button>
      <span class="h3">${monthTitle(month)}</span>
      <button type="button" class="icon-btn sm" data-month="1" ${month >= maxMonth ? 'disabled' : ''} aria-label="${monthTitle(shiftMonth(month, 1))}${month >= maxMonth ? ', not open yet' : ''}">${icon('chevron-right', 20, 2.2)}</button>
    </div>
    <div class="cal-grid" role="group" aria-label="${monthTitle(month)}">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w) => html`<span class="cal-wd" aria-hidden="true">${w}</span>`)}${grid()}</div>
    <div class="legend"><span><i class="open"></i>Open</span><span><i class="few"></i>Few left</span><span><i class="full"></i>Full / closed</span><span>Grey dates aren't open yet</span></div>
    <button type="button" class="btn btn-primary btn-lg btn-block" data-act="pick">Select ${dateLabel(pick)}</button>`;
  const m = openModal({
    sheet: true,
    label: 'Choose a date',
    content: view,
    onOpen: (panel) => {
      on(panel, 'click', '[data-cal]', (_e, b) => {
        pick = b.dataset.cal;
        m.rerender();
      });
      on(panel, 'click', '[data-month]', (_e, b) => {
        month = shiftMonth(month, Number(b.dataset.month));
        m.rerender();
      });
      on(panel, 'click', '[data-act="pick"]', () => {
        m.close();
        onPick(pick);
      });
    },
  });
}

// ── Step 3: court or table (U06, U06B, S02, S04) ───────────────────────────

function slotCounts(r) {
  const c = { open: 0, held: 0, taken: 0, mine: 0, bookable: 0 };
  for (const s of r.slots) {
    if (s.state === 'available') c.open++;
    else if (s.state === 'held') c.held++;
    else if (s.state === 'mine') c.mine++;
    else if (s.state === 'booked' || s.state === 'unavailable') c.taken++;
    if (['available', 'held', 'booked', 'unavailable', 'mine'].includes(s.state)) c.bookable++;
  }
  return c;
}

function minibar(r) {
  return html`<div class="minibar" aria-hidden="true">${r.slots.map((s) => html`<i class="${s.state === 'available' ? 'open' : s.state === 'held' ? 'held' : s.state === 'mine' ? 'mine' : ''}"></i>`)}</div>`;
}

function resourceCard(day, r, activity) {
  const noun = activityNoun(activity);
  const tt = activity === 'table_tennis';
  if (r.status === 'maintenance') {
    return html`<button type="button" class="res-card maintenance" data-maint="${r.id}" aria-disabled="true">
      <div class="res-top"><span class="res-thumb">${icon('wrench', 24)}</span>
        <div class="grow"><div class="res-name">${r.name}</div><div class="res-status maint">Maintenance</div></div></div>
      <p class="res-note">${r.maintenance?.note || 'Maintenance'}${r.maintenance?.untilLabel ? ` — back on ${r.maintenance.untilLabel}` : ''}. Can't be booked until then.</p>
    </button>`;
  }
  const c = slotCounts(r);
  if (c.open === 0) {
    return html`<div class="res-card full" aria-disabled="true">
      <div class="res-top"><span class="res-thumb">${icon('lock', 22)}</span>
        <div class="grow"><div class="res-name">${r.name}</div><div class="res-status full">${c.bookable ? 'Booked · full for the day' : 'No times left today'}</div></div></div>
      ${minibar(r)}
      <a class="btn btn-text btn-sm" href="/book/${activity}?date=${day.date}">Change date</a>
    </div>`;
  }
  const few = c.open <= 2;
  return html`<a class="res-card${tt ? ' tt' : ''}" href="/book/${activity}/${day.date}/${r.id}" aria-label="${r.name}, ${c.open} open ${c.open === 1 ? 'time' : 'times'}">
    <div class="res-top"><span class="res-thumb">${resourceGlyph(activity, tt)}</span>
      <div class="grow"><div class="res-name">${r.name}</div><div class="res-status ${few ? 'few' : ''}"><span class="dot"></span>Available · ${c.open} ${few ? 'left' : 'open'}</div></div>
      ${icon('chevron-right', 20, 2.2, 'chev')}</div>
    ${minibar(r)}
    ${!tt && day.hours ? html`<div class="minibar-axis"><span>${hourLabel(day.hours.open)}</span><span>${hourLabel(Math.round((day.hours.open + day.hours.close) / 120) * 60)}</span><span>${hourLabel(day.hours.close)}</span></div>` : ''}
  </a>`;
}

function openMaintenance(r, activity, day) {
  const noun = activityNoun(activity);
  const others = state.facility.resources.filter((x) => x.activity === activity && x.id !== r.id).map((x) => x.name);
  openModal({
    sheet: true,
    label: `${r.name} maintenance`,
    content: () => html`<div class="row" data-gap="12"><span class="tile lg res-hatch">${icon('wrench', 24)}</span><span class="pill hatch">${icon('wrench', 12, 2.4)}Maintenance</span></div>
      <h2 class="h2">${r.name} is ${r.maintenance?.note ? `closed for ${r.maintenance.note.toLowerCase()}` : 'under maintenance'}</h2>
      <p class="body">It can't be booked until it's back in service.${others.length ? ` ${joinNames(others)} ${others.length === 1 ? 'is' : 'are'} open as usual.` : ''}</p>
      <dl class="kv card card-pad">
        <div><dt>Back in service</dt><dd>${r.maintenance?.untilLabel || 'To be announced'}</dd></div>
        <div><dt>Reason</dt><dd>${r.maintenance?.note || 'Maintenance'}</dd></div>
      </dl>
      <p class="small row" data-gap="8">${icon('chat', 18)}Had ${r.name} booked during this time? Staff will message you in that booking's chat to move it.</p>
      <button type="button" class="btn btn-primary btn-lg btn-block" data-close>Choose another ${noun}</button>
      ${r.maintenance?.until ? html`<a class="btn btn-secondary btn-block" href="/book/${activity}?date=${r.maintenance.until}" data-close>Book ${r.name} from ${shortDate(r.maintenance.until)}</a>` : ''}`,
  });
}

export function resourceStep({ params }) {
  const { activity, date } = params;
  if (badActivity(activity)) return;
  if (!isDate(date)) return navigate(`/book/${activity}`, { replace: true });
  const noun = activityNoun(activity);
  const root = show(html`<div class="screen screen-enter">
    ${wizardHeader({ step: 3, label: noun === 'court' ? 'Court' : 'Table', sub: `${activityLabel(activity)} · ${dateLabel(date)}`, backHref: `/book/${activity}?date=${date}` })}
    <div class="stack stack-8"><h1 class="h1">Choose a ${noun}</h1><p class="row small" data-gap="8"><span class="live-dot"></span><span data-live>Live</span></p></div>
    <div class="res-list" data-list>${skeletonRows(3, 'sk-card')}</div>
    <div class="legend"><span><i class="bar-open"></i>Open</span><span><i class="bar-held"></i>On hold</span><span><i class="bar-taken"></i>Taken or unavailable</span></div>
  </div>`);
  const list = $('[data-list]', root);
  let day = null;

  function paint() {
    const live = $('[data-live]', root);
    if (day.hours) live.textContent = `Live · open ${day.hours.label}`;
    else live.textContent = day.closedReason ? `Closed · ${day.closedReason}` : 'Closed this day';
    const bookable = day.resources.some((r) => r.status !== 'maintenance' && r.slots.some((s) => s.state === 'available'));
    const mine = day.resources.flatMap((r) => r.slots.filter((s) => s.state === 'mine').map((s) => ({ r, s })));
    render(list, html`${!bookable ? html`<section class="card card-pad-lg stack stack-12">
        <h2 class="h2">No ${noun}s are available on ${dateLabel(date)}</h2>
        <p class="body">${day.open ? `Every ${noun} is booked or on hold${day.hours ? ` from ${minutesLabel(day.hours.open)} to ${minutesLabel(day.hours.close)}` : ''}. Holds that aren't paid reopen, so a slot may still free up.` : 'The facility is closed this day.'}</p>
        ${mine.length ? html`<a class="banner warn compact" href="/bookings/${mine[0].s.booking.id}">${icon('hourglass', 18, 2.2)}<span><b>One of them is yours:</b> ${mine[0].r.name} · ${mine[0].s.label}</span></a>` : ''}
        <a class="btn btn-primary btn-lg btn-block" href="/book/${activity}?date=${date}">Choose another date</a>
      </section>` : ''}
      ${day.resources.map((r) => resourceCard(day, r, activity))}`);
  }

  on(list, 'click', '[data-maint]', (_e, btn) => {
    const r = day.resources.find((x) => x.id === btn.dataset.maint);
    if (r) openMaintenance(r, activity, day);
  });

  async function load() {
    try {
      day = await api.get(`/api/availability?activity=${activity}&date=${date}`);
      paint();
    } catch (err) {
      if (err.code === 'DATE_PAST' || err.code === 'OUTSIDE_WINDOW') {
        toast(err.message, { type: 'error' });
        navigate(`/book/${activity}`, { replace: true });
        return;
      }
      render(list, errorState(err, { title: "Couldn't load live availability" }));
      $('[data-act="retry"]', list)?.addEventListener('click', load);
    }
  }
  load();
  return poll(load, 20_000);
}

// ── Step 4: time (U07) ─────────────────────────────────────────────────────

const LOCKED = {
  held: { label: 'On hold', reason: 'May reopen in a few minutes', icon: 'hourglass' },
  booked: { label: 'Booked', reason: 'Taken by another player', icon: 'lock' },
  unavailable: { label: 'Unavailable', reason: 'Not bookable right now', icon: 'minus-circle' },
  closed: { label: 'Closed', reason: 'Not open for booking', icon: 'circle-slash' },
  past: { label: 'Started', reason: 'This time has already started', icon: 'clock' },
  maintenance: { label: 'Maintenance', reason: 'Closed for maintenance', icon: 'wrench' },
};

function slotButton(s, selected, resourceName) {
  const range = rangeLabel(s.start, s.end);
  if (s.state === 'available') {
    const on = selected === s.start;
    return html`<button type="button" class="slot available" role="radio" aria-checked="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}" data-start="${s.start}" aria-label="${range}, available">
      <span class="s-time">${range}</span>
      ${on ? html`<span class="s-state"><span class="s-check">${icon('check', 14, 3)}</span>Selected</span>` : html`<span class="s-state"><span class="s-dot"></span>Available</span>`}
    </button>`;
  }
  if (s.state === 'mine') {
    return html`<a class="slot mine" href="/bookings/${s.booking.id}" aria-label="${range}, your booking">
      <span><span class="s-time">${range}</span><span class="s-reason">Your booking · ${s.booking.status === 'CONFIRMED' ? 'confirmed' : s.booking.status === 'PAYMENT_SUBMITTED' ? 'payment verification' : 'waiting for payment'}</span></span>
      <span class="s-state">${icon('ticket', 15, 2.4)}Yours</span>
    </a>`;
  }
  const l = LOCKED[s.state] || LOCKED.unavailable;
  return html`<div class="slot locked ${s.state}" role="radio" aria-checked="false" aria-disabled="true" aria-label="${range}, ${l.label.toLowerCase()}">
    <span><span class="s-time">${range}</span><span class="s-reason">${l.reason}</span></span>
    <span class="s-state">${icon(l.icon, 15, 2.4)}${l.label}</span>
  </div>`;
}

export function timeStep({ params, query }) {
  const { activity, date, resourceId } = params;
  if (badActivity(activity)) return;
  if (!isDate(date)) return navigate(`/book/${activity}`, { replace: true });
  const user = state.user;
  let selected = Number(query.get('start')) || null;
  let day = null;
  let resource = null;
  const root = show(html`<div class="screen has-sticky screen-enter">
    ${wizardHeader({ step: 4, label: 'Time', sub: `${dateLabel(date)}`, backHref: `/book/${activity}/${date}` })}
    <div class="page-title-row"><h1 class="h1">Choose a time</h1><span class="small">1-hour slots</span></div>
    <div class="legend legend-pills"><span class="lp available">Available</span><span class="lp held">On hold</span><span class="lp booked">Booked</span><span class="lp unavailable">Unavailable</span></div>
    <div class="slots" role="radiogroup" data-slots>${skeletonRows(6)}</div>
    <p class="banner white compact">${icon('info', 18, 2.2)}<span>"On hold" means another player is paying right now. If they don't finish within ${state.facility.rules.holdMinutes} minutes, the slot opens again.</span></p>
  </div>
  <div class="sticky-bar"><div class="sticky-inner">
    <div class="sticky-summary" aria-live="polite" data-summary></div>
    <button type="button" class="btn btn-primary btn-lg btn-block glow" data-act="continue" disabled>Continue ${icon('arrow-right', 20, 2.4)}</button>
  </div></div>`);
  const slotsEl = $('[data-slots]', root);
  const summary = $('[data-summary]', root);
  const cta = $('[data-act="continue"]', root);

  function paintSummary() {
    const price = resource ? resource.price : null;
    render(summary, html`<div><div class="s1">${resource ? resource.name : '…'} · ${dateLabel(date)}</div><div class="s2">${selected != null && resource ? `${rangeLabel(selected, selected + day.slotMinutes)} · 1 hour` : 'Pick a time'}</div></div>
      <div class="price"><div class="s1">${rateLabel(user)}</div><div class="mono">${price != null ? peso(price) : ''}</div></div>`);
    cta.disabled = selected == null;
  }

  function paint() {
    const sub = root.querySelector('.wiz-sub');
    if (sub && resource) sub.textContent = `${resource.name} · ${dateLabel(date)}`;
    slotsEl.setAttribute('aria-label', `Time slots for ${resource ? resource.name : ''} on ${dayMonth(date)}`);
    if (!resource) {
      render(slotsEl, html`<div class="empty"><p class="empty-title">That ${activityNoun(activity)} isn't available</p><a class="btn btn-primary btn-md" href="/book/${activity}/${date}">Choose another</a></div>`);
      return;
    }
    if (resource.status === 'maintenance') {
      render(slotsEl, html`<div class="slot locked maintenance"><span><span class="s-time">${resource.name} · all day</span><span class="s-reason">${resource.maintenance?.note || 'Maintenance'}${resource.maintenance?.untilLabel ? ` · back ${resource.maintenance.untilLabel}` : ''}</span></span><span class="s-state">${icon('wrench', 15, 2.4)}Maintenance</span></div>`);
      selected = null;
      paintSummary();
      return;
    }
    if (!resource.slots.length) {
      render(slotsEl, html`<div class="empty"><p class="empty-title">Closed on ${dateLabel(date)}</p><a class="btn btn-primary btn-md" href="/book/${activity}?date=${date}">Pick another date</a></div>`);
    } else {
      render(slotsEl, resource.slots.map((s) => slotButton(s, selected, resource.name)));
      if (!slotsEl.querySelector('[tabindex="0"]')) slotsEl.querySelector('.slot.available')?.setAttribute('tabindex', '0');
    }
    paintSummary();
  }

  on(slotsEl, 'click', '.slot.available', (_e, btn) => {
    selected = Number(btn.dataset.start);
    history.replaceState(history.state, '', `/book/${activity}/${date}/${resourceId}?start=${selected}`);
    paint();
    slotsEl.querySelector(`[data-start="${selected}"]`)?.focus();
  });
  slotsEl.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const items = $$('.slot.available', slotsEl);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = items[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
    next.click();
  });
  cta.addEventListener('click', () => {
    if (selected != null) navigate(`/book/${activity}/${date}/${resourceId}/${selected}`);
  });

  async function load(initial = false) {
    try {
      day = await api.get(`/api/availability?activity=${activity}&date=${date}`);
      resource = day.resources.find((r) => r.id === resourceId) || null;
      if (selected != null && resource) {
        const s = resource.slots.find((x) => x.start === selected);
        if (!s || s.state !== 'available') {
          if (!initial && s) toast('That time was just taken', { type: 'warn', sub: 'Pick another time.' });
          selected = null;
        }
      }
      paint();
    } catch (err) {
      if (err.code === 'DATE_PAST' || err.code === 'OUTSIDE_WINDOW') {
        toast(err.message, { type: 'error' });
        navigate(`/book/${activity}`, { replace: true });
        return;
      }
      render(slotsEl, errorState(err, { title: "Couldn't load live availability" }));
      $('[data-act="retry"]', slotsEl)?.addEventListener('click', () => load(true));
    }
  }
  paintSummary();
  load(true);
  return poll(() => load(false), 15_000);
}

// ── Step 5: review (U08, S07, S11) ─────────────────────────────────────────

const INVALID = {
  TIME_STARTED: { title: 'This time has already started', row: 'time', cta: 'Pick a later time', to: 'time' },
  OUTSIDE_WINDOW: { title: "That date isn't open yet", row: 'date', cta: 'Choose another date', to: 'date' },
  DATE_PAST: { title: 'That date has already passed', row: 'date', cta: 'Choose another date', to: 'date' },
  OVERLAP_OWN: { title: 'You already play at this time', row: 'time', cta: 'See my bookings', to: 'bookings' },
  TOO_MANY_HOLDS: { title: 'You have unpaid holds', row: null, cta: 'See my bookings', to: 'bookings' },
  MAINTENANCE: { title: 'This is under maintenance', row: 'resource', cta: 'Choose another', to: 'resource' },
  CLOSED: { title: 'That time is closed', row: 'time', cta: 'Pick another time', to: 'time' },
  RESOURCE_UNAVAILABLE: { title: "That isn't available", row: 'resource', cta: 'Choose another', to: 'resource' },
  INVALID_SLOT: { title: "That time isn't bookable", row: 'time', cta: 'Pick a listed time', to: 'time' },
};

export function reviewStep({ params }) {
  const { activity, date, resourceId } = params;
  const start = Number(params.start);
  if (badActivity(activity)) return;
  if (!isDate(date) || !Number.isInteger(start)) return navigate(`/book/${activity}`, { replace: true });
  const user = state.user;
  const res = state.facility.resources.find((r) => r.id === resourceId);
  if (!res) return navigate(`/book/${activity}/${date}`, { replace: true });
  const slotMin = state.facility.rules.slotMinutes;
  const amount = user.membership === 'member' ? res.priceMember : res.priceNonMember;
  const holdMin = state.facility.rules.holdMinutes;
  const timeHref = `/book/${activity}/${date}/${resourceId}?start=${start}`;

  const root = show(html`<div class="screen has-sticky screen-enter">
    ${wizardHeader({ step: 5, label: 'Review', sub: 'Almost there', backHref: timeHref, closeable: false })}
    <h1 class="h1">Booking summary</h1>
    <div data-invalid></div>
    <section class="card summary-card">
      <dl class="kv">
        <div><dt>Activity</dt><dd>${activityLabel(activity)}</dd></div>
        <div data-row="resource"><dt>${activityNoun(activity) === 'court' ? 'Court' : 'Table'}</dt><dd>${res.name}</dd></div>
        <div data-row="date"><dt>Date</dt><dd>${longDate(date)}</dd></div>
        <div data-row="time"><dt>Time</dt><dd>${rangeLabelFull(start, start + slotMin)}</dd></div>
        <div><dt>Customer</dt><dd>${user.name}</dd></div>
        <div><dt>Type</dt><dd>${memberTag(user.membership)}</dd></div>
      </dl>
      <div class="summary-foot"><div><div class="strong">Total to pay</div><div class="small">1 hour × ${user.membership === 'member' ? 'member' : 'non-member'} rate</div></div><span class="mono">${peso(amount)}</span></div>
    </section>
    <section class="section">
      <h2 class="h3">What happens next</h2>
      <ol class="steps-list">
        <li><span class="n amber">1</span><span>We hold ${res.name} for you for <b>${holdMin} minutes</b>.</span></li>
        <li><span class="n blue">2</span><span>Pay <b>${peso(amount)}</b> by GCash and upload your screenshot.</span></li>
        <li><span class="n violet">3</span><span>Staff verify your payment. Then your booking is <b>confirmed</b>.</span></li>
      </ol>
    </section>
  </div>
  <div class="sticky-bar"><div class="sticky-inner" data-actions>
    <button type="button" class="btn btn-primary btn-lg btn-block glow" data-act="reserve">Reserve &amp; pay ${peso(amount)}</button>
    <a class="btn btn-text btn-block" href="${timeHref}" data-back>Change booking</a>
  </div></div>`);

  const reserve = $('[data-act="reserve"]', root);
  reserve.addEventListener('click', async () => {
    setBusy(reserve, true, 'Reserving…');
    try {
      const created = await api.post('/api/bookings', { resourceId, date, start });
      navigate(`/bookings/${created.booking.id}/held`, { replace: true });
    } catch (err) {
      setBusy(reserve, false);
      if (err.code === 'SLOT_TAKEN') return openConflict(err, { activity, date, resourceId, start, resName: res.name });
      const kind = INVALID[err.code];
      if (!kind) {
        toast(err.message, { type: 'error' });
        return;
      }
      showInvalid(root, err, kind, { activity, date, resourceId, start });
    }
  });
}

function showInvalid(root, err, kind, { activity, date, resourceId, start }) {
  const target = {
    time: `/book/${activity}/${date}/${resourceId}`,
    date: `/book/${activity}`,
    resource: `/book/${activity}/${date}`,
    bookings: err.details && err.details.bookingId ? `/bookings/${err.details.bookingId}` : '/bookings',
  }[kind.to];
  render($('[data-invalid]', root), html`<div class="banner error" role="alert">${icon('alert', 20, 2.2)}<div><b>${kind.title}</b><br>${err.message}</div></div>`);
  for (const row of root.querySelectorAll('[data-row]')) row.classList.toggle('bad-row', row.dataset.row === kind.row);
  render($('[data-actions]', root), html`<a class="btn btn-primary btn-lg btn-block" href="${target}">${kind.cta}</a>
    <p class="small center">Nothing was held or charged. Reserve &amp; pay is off until this is fixed.</p>`);
  root.querySelector('[role="alert"]').scrollIntoView({ block: 'center' });
}

function openConflict(err, { activity, date, resourceId, start, resName }) {
  const alts = (err.details && err.details.alternatives) || [];
  let pick = alts[0] || null;
  const describe = (a) => {
    if (a.resourceId === resourceId) {
      const diff = (a.start - start) / 60;
      return `Same ${activityNoun(activity)}, ${Math.abs(diff)} hour${Math.abs(diff) === 1 ? '' : 's'} ${diff > 0 ? 'later' : 'earlier'}`;
    }
    if (a.start === start) return `Same time, another ${activityNoun(activity)}`;
    return `Another ${activityNoun(activity)}, ${minutesLabel(a.start)}`;
  };
  const m = openModal({
    sheet: true,
    role: 'alertdialog',
    label: 'This slot was just taken',
    content: () => html`<div class="row" data-gap="12"><span class="tile red">${icon('alert', 24)}</span><h2 class="h2">This slot was just taken</h2></div>
      <p class="body">Another player reserved <b>${resName} · ${dateLabel(date)} · ${minutesLabel(start)}</b> a moment before you. Nothing was held or charged.</p>
      ${alts.length ? html`<p class="overline">Open times nearby</p>
        <div class="alt-list" role="radiogroup" aria-label="Open times nearby">${alts.map((a, i) => html`<button type="button" class="alt-option" role="radio" aria-checked="${pick === a ? 'true' : 'false'}" data-alt="${i}">
          <span class="radio"></span><span class="grow"><span class="row-title">${a.resourceName} · ${minutesLabel(a.start)}</span><br><span class="row-meta">${describe(a)}</span></span><span class="pill green sm">Available</span></button>`)}</div>
        <button type="button" class="btn btn-primary btn-lg btn-block" data-act="alt">Continue with ${pick ? `${pick.resourceName} · ${minutesLabel(pick.start)}` : ''}</button>`
      : html`<p class="banner neutral compact">${icon('info', 18, 2.2)}<span>No other open times this day. Try another date.</span></p>`}
      <a class="btn btn-text btn-block" href="/book/${activity}/${date}/${resourceId}" data-close>See all times</a>`,
    onOpen: (panel) => {
      on(panel, 'click', '[data-alt]', (_e, b) => {
        pick = alts[Number(b.dataset.alt)];
        m.rerender();
        panel.querySelector(`[data-alt="${b.dataset.alt}"]`)?.focus();
      });
      on(panel, 'click', '[data-act="alt"]', () => {
        if (!pick) return;
        m.close();
        navigate(`/book/${activity}/${date}/${pick.resourceId}/${pick.start}`, { replace: true });
      });
    },
  });
}

