import { createViewTools } from '../../core/view.js';
import { postBooking } from '../../core/booking-request.js';
import { api } from '../../core/api.js';
import { listen, $, $$, html, on, render, setBusy } from '../../core/dom.js';
import { icon, courtArt, tableArt, resourceGlyph } from '../../core/icons.js';
import {
  activityLabel, activityNoun, dateLabel, dayMonth, durationLabel, hourLabel, longDate, mergeStarts, minutesLabel, peso, rangeLabel, rangeLabelFull,
  shortDate,
} from './util.js';
import { errorState, memberTag, openModal, poll, skeletonRows, toast } from '../../core/ui.js';
import { navigate, show, state, wizardHeader } from '../shell.js';
import { endRebook, rebookBanner, rebookContext, wireRebookBanner } from '../rebook.js';

const viewTools = createViewTools({ listen, api, on, render, setBusy, openModal, poll, toast, navigate, show });

const ACTIVITIES = ['pickleball', 'table_tennis'];
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

function badActivity(activity) {
  const { navigate } = viewTools();
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
  const { show, api } = viewTools();
  const f = state.facility;
  const member = state.user.membership === 'member';
  const root = show(html`<div class="screen screen-enter">
    ${wizardHeader({ step: 1, label: 'Activity', sub: 'New booking' })}
    ${rebookBanner(rebookContext())}
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
  wireRebookBanner(root);
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
  const open = res.filter((r) => !r.maint && r.status !== 'open_play').map((r) => r.name);
  const maint = res.filter((r) => r.maint).map((r) => r.name);
  const openPlay = res.filter((r) => !r.maint && r.status === 'open_play').map((r) => r.name);
  const detail = [
    open.length ? joinNames(open) : '',
    openPlay.length ? `${joinNames(openPlay)} open play` : '',
    maint.length ? `${joinNames(maint)} in maintenance` : '',
  ].filter(Boolean).join(' · ');
  let box;
  if (openPlayOnly(day)) {
    box = html`<div class="count-box"><span>${icon('users', 22)}</span><div><div class="strong">Open play · free for all</div><div class="small">${joinNames(openPlay)} ${openPlay.length === 1 ? 'is' : 'are'} open to everyone. No booking needed.</div></div></div>`;
  } else if (day.load === 'closed') {
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

/** Nothing to book that day, but some courts or tables are open play: players can still look. */
function openPlayOnly(day) {
  return day.load === 'closed' && day.openPlay > 0;
}

function dayButton(d, selected) {
  const top = d.isToday ? 'Today' : d.weekday;
  const sub = openPlayOnly(d) ? 'Open play' : LOAD_TEXT[d.load];
  const label = `${dayMonth(d.date)}, ${sub}${d.isToday ? ', today' : ''}`;
  return html`<button type="button" class="day load-${d.load}${d.isToday ? ' today' : ''}" data-date="${d.date}" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${label}">
    <span class="d-top">${top}</span><span class="d-num">${d.day}</span><span class="d-sub">${sub}</span>
  </button>`;
}

export function dateStep({ params, query }) {
  const { listen, show, render, on, navigate, api, poll } = viewTools();
  const activity = params.activity;
  if (badActivity(activity)) return;
  let days = [];
  let selected = isDate(query.get('date')) ? query.get('date') : null;
  const root = show(html`<div class="screen has-sticky screen-enter">
    ${wizardHeader({ step: 2, label: 'Date', sub: activityLabel(activity), backHref: '/book' })}
    ${rebookBanner(rebookContext(activity))}
    <div class="page-title-row"><div><h1 class="h1">Pick a date</h1><p class="small" data-range></p></div>
      <button type="button" class="btn btn-secondary btn-sm" data-act="calendar">${icon('calendar', 18)}Calendar</button></div>
    <div class="date-strip" role="group" aria-label="Dates" data-strip>${skeletonRows(1)}</div>
    <div data-daycard></div>
    <p class="small">Bookings open ${state.facility.rules.bookingWindowDays} days ahead. Availability is live and needs an internet connection.</p>
  </div>
  <div class="sticky-bar"><div class="sticky-inner"><button type="button" class="btn btn-primary btn-lg btn-block glow" data-act="continue" disabled>Continue</button></div></div>`);

  wireRebookBanner(root);
  const strip = $('[data-strip]', root);
  const cardEl = $('[data-daycard]', root);
  const cta = $('[data-act="continue"]', root);

  function paint({ scroll = false } = {}) {
    render(strip, days.map((d) => dayButton(d, d.date === selected)));
    const day = days.find((d) => d.date === selected);
    render(cardEl, day ? dayCard(activity, day) : '');
    if (day && (day.load === 'open' || day.load === 'few' || openPlayOnly(day))) {
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
  listen(cta, 'click', () => navigate(`/book/${activity}/${selected}`));
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
      listen($('[data-act="retry"]', cardEl), 'click', load);
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
  const { openModal, on } = viewTools();
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
  if (r.status === 'open_play') {
    return html`<div class="res-card open-play">
      <div class="res-top"><span class="res-thumb">${icon('users', 24)}</span>
        <div class="grow"><div class="res-name">${r.name}</div><div class="res-status open-play">Open play</div></div></div>
      <p class="res-note">Open for all. Just come and play: this ${noun} can't be booked.</p>
    </div>`;
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
  const { openModal } = viewTools();
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
  const { listen, navigate, show, render, on, api, toast, poll } = viewTools();
  const { activity, date } = params;
  if (badActivity(activity)) return;
  if (!isDate(date)) return navigate(`/book/${activity}`, { replace: true });
  const noun = activityNoun(activity);
  const root = show(html`<div class="screen screen-enter">
    ${wizardHeader({ step: 3, label: noun === 'court' ? 'Court' : 'Table', sub: `${activityLabel(activity)} · ${dateLabel(date)}`, backHref: `/book/${activity}?date=${date}` })}
    ${rebookBanner(rebookContext(activity))}
    <div class="stack stack-8"><h1 class="h1">Choose a ${noun}</h1><p class="row small" data-gap="8"><span class="live-dot"></span><span data-live>Live</span></p></div>
    <div class="res-list" data-list>${skeletonRows(3, 'sk-card')}</div>
    <div class="legend"><span><i class="bar-open"></i>Open</span><span><i class="bar-held"></i>On hold</span><span><i class="bar-open-play"></i>Open play</span><span><i class="bar-taken"></i>Taken or unavailable</span></div>
  </div>`);
  wireRebookBanner(root);
  const list = $('[data-list]', root);
  let day = null;

  function paint() {
    const live = $('[data-live]', root);
    if (day.hours) live.textContent = `Live · open ${day.hours.label}`;
    else live.textContent = day.closedReason ? `Closed · ${day.closedReason}` : 'Closed this day';
    const bookable = day.resources.some((r) => r.status === 'active' && r.slots.some((s) => s.state === 'available'));
    const openPlay = day.resources.filter((r) => r.status === 'open_play').map((r) => r.name);
    const mine = day.resources.flatMap((r) => r.slots.filter((s) => s.state === 'mine').map((s) => ({ r, s })));
    render(list, html`${!bookable ? html`<section class="card card-pad-lg stack stack-12">
        <h2 class="h2">No ${noun}s are available on ${dateLabel(date)}</h2>
        <p class="body">${!day.open ? 'The facility is closed this day.'
          : openPlay.length && openPlay.length === day.resources.length ? `Every ${noun} is open play: free for all, no booking needed.`
            : `Every ${noun} is booked, on hold${openPlay.length ? ' or open play' : ''}${day.hours ? ` from ${minutesLabel(day.hours.open)} to ${minutesLabel(day.hours.close)}` : ''}. Holds that aren't paid reopen, so a slot may still free up.`}</p>
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
      listen($('[data-act="retry"]', list), 'click', load);
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
  open_play: { label: 'Open play', reason: 'Free for all, no booking needed', icon: 'users' },
};

/** "960,1080" → [960, 1080] (unique, sorted). Anything malformed → []. */
function parseStarts(raw) {
  if (!raw || !/^\d{1,4}(,\d{1,4})*$/.test(raw)) return [];
  return [...new Set(raw.split(',').map(Number))].filter((n) => n < 1440).sort((a, b) => a - b);
}

/** "4:00 – 6:00 PM, 7:00 – 8:00 PM" for slot starts (merged where back to back). */
function timesLabel(starts, slotMinutes, { full = false } = {}) {
  return mergeStarts(starts, slotMinutes).map((s) => (full ? rangeLabelFull(s.start, s.end) : rangeLabel(s.start, s.end))).join(', ');
}

function slotButton(s, picked) {
  const { on } = viewTools();
  const range = rangeLabel(s.start, s.end);
  if (s.state === 'available') {
    const on = picked.has(s.start);
    return html`<button type="button" class="slot available" role="checkbox" aria-checked="${on ? 'true' : 'false'}" data-start="${s.start}" aria-label="${range}, ${on ? 'selected' : 'available'}">
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
  return html`<div class="slot locked ${s.state}" role="checkbox" aria-checked="false" aria-disabled="true" aria-label="${range}, ${l.label.toLowerCase()}">
    <span><span class="s-time">${range}</span><span class="s-reason">${l.reason}</span></span>
    <span class="s-state">${icon(l.icon, 15, 2.4)}${l.label}</span>
  </div>`;
}

/**
 * Pick any number of open slots on this court or table, back to back or not. They all
 * go into one booking: one hold, one payment (rate × slots), one reference.
 */
export function timeStep({ params, query }) {
  const { listen, navigate, show, render, on, api, toast, poll } = viewTools();
  const { activity, date, resourceId } = params;
  if (badActivity(activity)) return;
  if (!isDate(date)) return navigate(`/book/${activity}`, { replace: true });
  const user = state.user;
  const picked = new Set(parseStarts(query.get('start')));
  let day = null;
  let resource = null;
  const root = show(html`<div class="screen has-sticky screen-enter">
    ${wizardHeader({ step: 4, label: 'Time', sub: `${dateLabel(date)}`, backHref: `/book/${activity}/${date}` })}
    ${rebookBanner(rebookContext(activity))}
    <div class="page-title-row"><div><h1 class="h1">Choose your times</h1><p class="small">Tap as many open times as you like. They don't have to be back to back.</p></div>
      <button type="button" class="btn btn-text btn-sm" data-act="clear" hidden>Clear</button></div>
    <div class="legend legend-pills"><span class="lp available">Available</span><span class="lp held">On hold</span><span class="lp booked">Booked</span><span class="lp unavailable">Unavailable</span></div>
    <div class="slots" role="group" data-slots>${skeletonRows(6)}</div>
    <p class="banner white compact">${icon('info', 18, 2.2)}<span>"On hold" means another player is paying right now. If they don't finish within ${state.facility.rules.holdMinutes} minutes, the slot opens again.</span></p>
  </div>
  <div class="sticky-bar"><div class="sticky-inner">
    <div class="sticky-summary" aria-live="polite" data-summary></div>
    <button type="button" class="btn btn-primary btn-lg btn-block glow" data-act="continue" disabled>Continue ${icon('arrow-right', 20, 2.4)}</button>
  </div></div>`);
  wireRebookBanner(root);
  const rebook = picked.size ? null : rebookContext(activity);
  const slotsEl = $('[data-slots]', root);
  const summary = $('[data-summary]', root);
  const cta = $('[data-act="continue"]', root);
  const clearBtn = $('[data-act="clear"]', root);
  const slotMin = () => (day ? day.slotMinutes : state.facility.rules.slotMinutes);
  const sorted = () => [...picked].sort((a, b) => a - b);

  function syncUrl() {
    const starts = sorted();
    history.replaceState(history.state, '', `/book/${activity}/${date}/${resourceId}${starts.length ? `?start=${starts.join(',')}` : ''}`);
  }

  function paintSummary() {
    const price = resource ? resource.price : null;
    const starts = sorted();
    const n = starts.length;
    const ranges = mergeStarts(starts, slotMin());
    const when = !n ? 'Pick one or more times'
      : ranges.length <= 2 ? `${timesLabel(starts, slotMin())} · ${durationLabel(n * slotMin())}`
        : `${n} times · ${durationLabel(n * slotMin())}`;
    render(summary, html`<div><div class="s1">${resource ? resource.name : '…'} · ${dateLabel(date)}</div><div class="s2">${when}</div></div>
      <div class="price"><div class="s1">${n > 1 && price != null ? `${peso(price)} × ${n}` : rateLabel(user)}</div><div class="mono">${price != null ? peso(price * Math.max(n, 1)) : ''}</div></div>`);
    cta.disabled = !n;
    clearBtn.hidden = !n;
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
      picked.clear();
      paintSummary();
      return;
    }
    if (resource.status === 'open_play') {
      render(slotsEl, html`<div class="slot locked open_play" aria-disabled="true"><span><span class="s-time">${resource.name} · all day</span><span class="s-reason">Open for all. Just come and play: no booking needed.</span></span><span class="s-state">${icon('users', 15, 2.4)}Open play</span></div>`);
      picked.clear();
      paintSummary();
      return;
    }
    if (!resource.slots.length) {
      render(slotsEl, html`<div class="empty"><p class="empty-title">Closed on ${dateLabel(date)}</p><a class="btn btn-primary btn-md" href="/book/${activity}?date=${date}">Pick another date</a></div>`);
    } else {
      render(slotsEl, resource.slots.map((s) => slotButton(s, picked)));
    }
    paintSummary();
  }

  on(slotsEl, 'click', '.slot.available', (_e, btn) => {
    const start = Number(btn.dataset.start);
    if (picked.has(start)) picked.delete(start);
    else picked.add(start);
    syncUrl();
    paint();
    slotsEl.querySelector(`[data-start="${start}"]`)?.focus();
  });
  listen(clearBtn, 'click', () => {
    picked.clear();
    syncUrl();
    paint();
  });
  // Arrow keys move between open times; Space or Enter picks one.
  listen(slotsEl, 'keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const items = $$('.slot.available', slotsEl);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
  });
  listen(cta, 'click', () => {
    if (picked.size) navigate(`/book/${activity}/${date}/${resourceId}/${sorted().join(',')}`);
  });

  async function load(initial = false) {
    try {
      day = await api.get(`/api/availability?activity=${activity}&date=${date}`);
      resource = day.resources.find((r) => r.id === resourceId) || null;
      if (initial && rebook && resource && !picked.size) {
        // Rebooking: start from the original booking's times where they're open here.
        for (const s of rebook.starts || []) if (resource.slots.find((x) => x.start === s)?.state === 'available') picked.add(s);
        if (picked.size) syncUrl();
      }
      if (resource && picked.size) {
        // Drop picked times someone else took meanwhile.
        const lost = sorted().filter((s) => resource.slots.find((x) => x.start === s)?.state !== 'available');
        if (lost.length) {
          for (const s of lost) picked.delete(s);
          syncUrl();
          if (!initial) {
            toast(lost.length === 1 ? `${minutesLabel(lost[0])} was just taken` : `${lost.length} of your times were just taken`, {
              type: 'warn',
              sub: picked.size ? 'They were removed from your selection.' : 'Pick another time.',
            });
          }
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
      listen($('[data-act="retry"]', slotsEl), 'click', () => load(true));
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
  TOO_MANY_HOLDS: { title: 'You have unpaid holds', row: null, cta: 'See my bookings', to: 'bookings' },
  MAINTENANCE: { title: 'This is under maintenance', row: 'resource', cta: 'Choose another', to: 'resource' },
  OPEN_PLAY: { title: 'This is open play: free for all', row: 'resource', cta: 'Choose another', to: 'resource' },
  CLOSED: { title: 'That time is closed', row: 'time', cta: 'Pick another time', to: 'time' },
  RESOURCE_UNAVAILABLE: { title: "That isn't available", row: 'resource', cta: 'Choose another', to: 'resource' },
  INVALID_SLOT: { title: "That time isn't bookable", row: 'time', cta: 'Pick a listed time', to: 'time' },
};

export function reviewStep({ params }) {
  const { listen, navigate, show, render, on, api, setBusy, toast } = viewTools();
  const { activity, date, resourceId } = params;
  const starts = parseStarts(params.start);
  if (badActivity(activity)) return;
  if (!isDate(date) || !starts.length) return navigate(`/book/${activity}`, { replace: true });
  const user = state.user;
  const res = state.facility.resources.find((r) => r.id === resourceId);
  if (!res) return navigate(`/book/${activity}/${date}`, { replace: true });
  const slotMin = state.facility.rules.slotMinutes;
  const n = starts.length;
  const ranges = mergeStarts(starts, slotMin);
  const rate = user.membership === 'member' ? res.priceMember : res.priceNonMember;
  const amount = rate * n;
  const holdMin = state.facility.rules.holdMinutes;
  const timeHref = `/book/${activity}/${date}/${resourceId}?start=${starts.join(',')}`;
  const rateNote = `${n > 1 ? `${n} × ${peso(rate)}` : `${durationLabel(slotMin)} ×`} ${user.membership === 'member' ? 'member' : 'non-member'} rate`;
  // The server's figures for the booking credit this booking would use (amounts never come from here).
  let quote = null;
  let useCredit = true;
  let quoteLoading = true;
  let quoteError = null;
  let submitting = false;
  const credit = () => (quote && useCredit ? quote.creditApplied : 0);
  const due = () => (quote ? (useCredit ? quote.amountDue : quote.price) : amount);
  const coveredByCredit = () => credit() > 0 && due() === 0;

  const moneyRows = () => {
    if (!quote || quote.creditApplied === 0) {
      return html`<div class="summary-foot"><div><div class="strong">Total to pay</div><div class="small">${rateNote}</div></div><span class="mono">${peso(due())}</span></div>`;
    }
    return html`<div class="summary-foot sub"><div><div class="strong">Price</div><div class="small">${rateNote}</div></div><span class="mono">${peso(quote.price)}</span></div>
      <div class="summary-foot sub credit-line"><div><div class="strong">Booking credit</div>
        <label class="check-row compact"><input type="checkbox" data-use-credit ${useCredit ? 'checked' : ''}><span class="check-box">${icon('check', 14, 3)}</span>Use my credit</label></div>
        <span class="mono${useCredit ? ' blue-text' : ' muted'}">−${peso(quote.creditApplied)}</span></div>
      <div class="summary-foot"><div><div class="strong">${coveredByCredit() ? 'Nothing to pay' : 'To pay'}</div>${useCredit && quote.creditApplied ? html`<div class="small">Not a cash refund: your credit pays first</div>` : ''}</div><span class="mono">${peso(due())}</span></div>`;
  };
  const nextSteps = () => coveredByCredit()
    ? html`<ol class="steps-list">
        <li><span class="n blue">1</span><span>Your booking credit pays the whole <b>${peso(quote.price)}</b>.</span></li>
        <li><span class="n green">2</span><span>The booking is <b>confirmed right away</b>. No payment or screenshot needed.</span></li>
      </ol>`
    : html`<ol class="steps-list">
        <li><span class="n amber">1</span><span>We hold ${res.name} for you for <b>${holdMin} minutes</b>${credit() ? ` and set aside ${peso(credit())} of your credit` : ''}.</span></li>
        <li><span class="n blue">2</span><span>Pay <b>${peso(due())}</b> using an enabled payment method and upload your screenshot.</span></li>
        <li><span class="n violet">3</span><span>Staff verify your payment. Then your booking is <b>confirmed</b>.</span></li>
      </ol>`;
  const hasOverlap = () => Boolean(quote?.personalOverlaps.length);
  const ctaLabel = () => hasOverlap()
    ? (coveredByCredit() ? 'Continue with Credit' : 'Continue to Payment')
    : (coveredByCredit() ? html`${icon('gift', 20)}Book with credit` : html`Reserve &amp; pay ${peso(due())}`);
  const overlapNotice = () => {
    if (quoteLoading) return html`<p class="small" role="status">Checking your booking details and existing reservations…</p>`;
    if (quoteError) return html`<div class="banner warn booking-overlap" role="alert">${icon('alert', 20, 2.2)}
      <div class="stack stack-8"><b>Couldn't check your existing bookings</b><p>Please retry before reserving so you can review any overlapping bookings.</p>
        <button type="button" class="btn btn-secondary btn-sm" data-act="retry-quote">Retry</button></div></div>`;
    if (!hasOverlap()) return '';
    return html`<section class="banner warn booking-overlap" role="alert" aria-label="Overlapping booking warning">${icon('alert', 20, 2.2)}
      <div class="stack stack-8"><b>You already have a booking during this time.</b>
        <ul class="booking-overlap-list">${quote.personalOverlaps.map((booking) => html`<li>You have reserved <b>${booking.resourceName}</b> from ${booking.segments.map((segment) => rangeLabelFull(segment.start, segment.end)).join(', ')}.</li>`)}</ul>
        <p>You're about to reserve <b>${res.name}</b> for ${timesLabel(starts, slotMin, { full: true })}.</p>
        <p>You may be booking for a friend. Please review your reservation before proceeding.</p></div></section>`;
  };

  const root = show(html`<div class="screen has-sticky screen-enter">
    ${wizardHeader({ step: 5, label: 'Review', sub: 'Almost there', backHref: timeHref, closeable: false })}
    ${rebookBanner(rebookContext(activity))}
    <h1 class="h1">Booking summary</h1>
    <div data-invalid></div>
    <div data-overlap>${overlapNotice()}</div>
    <section class="card summary-card">
      <dl class="kv">
        <div><dt>Activity</dt><dd>${activityLabel(activity)}</dd></div>
        <div data-row="resource"><dt>${activityNoun(activity) === 'court' ? 'Court' : 'Table'}</dt><dd>${res.name}</dd></div>
        <div data-row="date"><dt>Date</dt><dd>${longDate(date)}</dd></div>
        <div data-row="time"><dt>${ranges.length > 1 ? 'Times' : 'Time'}</dt><dd>${ranges.map((s, i) => html`${i ? html`<br>` : ''}${rangeLabelFull(s.start, s.end)}`)}</dd></div>
        <div><dt>Duration</dt><dd>${durationLabel(n * slotMin)}${ranges.length > 1 ? ` · ${n} slots` : ''}</dd></div>
        <div><dt>Customer</dt><dd>${user.name}</dd></div>
        <div><dt>Type</dt><dd>${memberTag(user.membership)}</dd></div>
      </dl>
      <div data-money>${moneyRows()}</div>
    </section>
    <section class="section">
      <h2 class="h3">What happens next</h2>
      <div data-next>${nextSteps()}</div>
    </section>
  </div>
  <div class="sticky-bar"><div class="sticky-inner" data-actions>
    <button type="button" class="btn btn-primary btn-lg btn-block glow" data-act="reserve" disabled>${ctaLabel()}</button>
    <a class="btn btn-text btn-block" href="${timeHref}" data-change-booking>Change booking</a>
  </div></div>`);
  wireRebookBanner(root);

  const reserve = $('[data-act="reserve"]', root);
  const repaint = () => {
    render($('[data-money]', root), moneyRows());
    render($('[data-next]', root), nextSteps());
    render($('[data-overlap]', root), overlapNotice());
    $('[data-change-booking]', root).textContent = hasOverlap() ? 'Review / Change Time' : 'Change booking';
    reserve.disabled = submitting || quoteLoading || Boolean(quoteError);
    if (!submitting) render(reserve, ctaLabel());
  };
  on(root, 'change', '[data-use-credit]', (_e, box) => {
    useCredit = box.checked;
    repaint();
  });
  const loadQuote = async () => {
    quoteLoading = true;
    quoteError = null;
    repaint();
    try {
      const q = await api.get(`/api/bookings/quote?resourceId=${encodeURIComponent(resourceId)}&starts=${starts.join(',')}&date=${date}`);
      const moneyValid = q && [q.price, q.creditApplied, q.amountDue].every((value) => Number.isSafeInteger(value) && value >= 0)
        && q.creditApplied <= q.price && q.amountDue === q.price - q.creditApplied;
      const overlapsValid = Array.isArray(q?.personalOverlaps) && q.personalOverlaps.every((booking) =>
        booking && typeof booking.id === 'string' && booking.id && typeof booking.resourceId === 'string' && booking.resourceId && booking.resourceId !== resourceId
        && typeof booking.resourceName === 'string' && booking.resourceName && booking.date === date
        && ['TEMPORARY', 'REJECTED', 'PAYMENT_SUBMITTED', 'CONFIRMED'].includes(booking.status)
        && Array.isArray(booking.segments) && booking.segments.length && booking.segments.every((segment) =>
          segment && Number.isInteger(segment.start) && Number.isInteger(segment.end) && segment.start >= 0 && segment.end <= 1440 && segment.start < segment.end));
      if (!moneyValid || !overlapsValid) throw new Error("Couldn't confirm the booking details. Please retry.");
      quote = q;
    } catch (err) {
      quoteError = err;
      throw err;
    } finally {
      quoteLoading = false;
      repaint();
    }
  };
  on(root, 'click', '[data-act="retry-quote"]', () => loadQuote().catch(() => {}));
  loadQuote().catch(() => {});

  listen(reserve, 'click', async () => {
    if (reserve.disabled) return;
    submitting = true;
    setBusy(reserve, true, coveredByCredit() ? 'Booking…' : 'Reserving…');
    const withCredit = Boolean(quote && quote.creditApplied > 0 && useCredit);
    try {
      const created = await postBooking('/api/bookings', { resourceId, date, starts, useCredit: withCredit, expectedCredit: withCredit ? quote.creditApplied : null }, user.id);
      endRebook();
      const b = created.booking;
      navigate(b.status === 'CONFIRMED' ? `/bookings/${b.id}/confirmed` : `/bookings/${b.id}/held`, { replace: true });
    } catch (err) {
      submitting = false;
      setBusy(reserve, false);
      repaint();
      if (err.code === 'CREDIT_CHANGED') {
        await loadQuote().catch(() => {});
        toast(err.message, { type: 'warn', sub: 'Check the new total, then book again.' });
        return;
      }
      if (err.code === 'SLOT_TAKEN') return openConflict(err, { activity, date, resourceId, starts, resName: res.name });
      const kind = INVALID[err.code];
      if (!kind) {
        toast(err.message, { type: 'error' });
        return;
      }
      showInvalid(root, err, kind, { activity, date, resourceId, starts });
    }
  });
}

function showInvalid(root, err, kind, { activity, date, resourceId, starts }) {
  const { render } = viewTools();
  const target = {
    time: `/book/${activity}/${date}/${resourceId}?start=${starts.join(',')}`,
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

function openConflict(err, { activity, date, resourceId, starts, resName }) {
  const { openModal, on, navigate } = viewTools();
  const slotMin = state.facility.rules.slotMinutes;
  const noun = activityNoun(activity);
  const multi = starts.length > 1;
  const when = (list) => (list.length === 1 ? minutesLabel(list[0]) : timesLabel(list, slotMin));
  const alts = ((err.details && err.details.alternatives) || []).map((a) => ({ ...a, starts: a.starts && a.starts.length ? a.starts : [a.start] }));
  let pick = alts[0] || null;
  const describe = (a) => {
    if (multi) {
      return a.resourceId === resourceId ? `Keep the ${a.starts.length} of your ${starts.length} times still open` : `Same times, another ${noun}`;
    }
    if (a.resourceId === resourceId) {
      const diff = a.start - starts[0];
      return `Same ${noun}, ${durationLabel(Math.abs(diff))} ${diff > 0 ? 'later' : 'earlier'}`;
    }
    if (a.start === starts[0]) return `Same time, another ${noun}`;
    return `Another ${noun}, ${minutesLabel(a.start)}`;
  };
  const title = multi ? 'Some of your times are already reserved' : 'This slot is already reserved';
  const m = openModal({
    sheet: true,
    role: 'alertdialog',
    label: title,
    content: () => html`<div class="row" data-gap="12"><span class="tile red">${icon('alert', 24)}</span><h2 class="h2">${title}</h2></div>
      <p class="body">${multi ? 'One or more selected times on ' : 'The selected time on '}<b>${resName} · ${dateLabel(date)} · ${when(starts)}</b> ${multi ? 'are' : 'is'} already reserved. Nothing was held or charged.</p>
      ${alts.length ? html`<p class="overline">${multi ? 'Other options' : 'Open times nearby'}</p>
        <div class="alt-list" role="radiogroup" aria-label="${multi ? 'Other options' : 'Open times nearby'}">${alts.map((a, i) => html`<button type="button" class="alt-option" role="radio" aria-checked="${pick === a ? 'true' : 'false'}" data-alt="${i}">
          <span class="radio"></span><span class="grow"><span class="row-title">${a.resourceName} · ${when(a.starts)}</span><br><span class="row-meta">${describe(a)}</span></span><span class="pill green sm">Available</span></button>`)}</div>
        <button type="button" class="btn btn-primary btn-lg btn-block" data-act="alt">Continue with ${pick ? `${pick.resourceName} · ${when(pick.starts)}` : ''}</button>`
      : html`<p class="banner neutral compact">${icon('info', 18, 2.2)}<span>No other open times this day. Try another date.</span></p>`}
      <a class="btn btn-text btn-block" href="/book/${activity}/${date}/${resourceId}?start=${starts.join(',')}" data-close>See all times</a>`,
    onOpen: (panel) => {
      on(panel, 'click', '[data-alt]', (_e, b) => {
        pick = alts[Number(b.dataset.alt)];
        m.rerender();
        panel.querySelector(`[data-alt="${b.dataset.alt}"]`)?.focus();
      });
      on(panel, 'click', '[data-act="alt"]', () => {
        if (!pick) return;
        m.close();
        navigate(`/book/${activity}/${date}/${pick.resourceId}/${pick.starts.join(',')}`, { replace: true });
      });
    },
  });
}
