import { createViewTools } from '../../core/view.js';
import { api } from '../../core/api.js';
import { listen, $, html, on, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { addDays, firstName, hourLabel, isoDate, longDate, mmss } from '../../core/format.js';
import { errorState, poll, skeletonRows } from '../../core/ui.js';
import { frame } from '../shell.js';
import { API, BASE } from '../console.js';

const viewTools = createViewTools({ listen, api, on, render, poll, frame });
const LABEL = { available: 'Available', booked: 'Booked', unavailable: 'Verifying', held: 'Held', closed: 'Closed', past: 'Past', maintenance: 'Maintenance', open_play: 'Open play' };
const DAY_LABEL = { open: 'Open', full: 'Full', closed: 'Closed', past: 'Past', open_play: 'Open play', empty: 'No resources' };
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const monthLabel = date => new Intl.DateTimeFormat('en-PH', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const weekdayLabel = date => new Intl.DateTimeFormat('en-PH', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const stripAnchor = date => date > '9999-12-18' ? '9999-12-18' : date;

function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  const last = parts.length > 1 ? `${parts[parts.length - 1][0]}.` : '';
  return `${firstName(name)} ${last}`.trim();
}

function cell(slot, resource, now) {
  const booking = slot.booking;
  if (booking) {
    const extra = slot.state === 'held' && booking.holdExpiresAt ? ` · ${mmss(booking.holdExpiresAt - now)}` : '';
    const href = slot.state === 'unavailable' ? `${BASE}/verify/${booking.id}` : `${BASE}/bookings/${booking.id}`;
    return html`<a class="cell ${slot.state}" href="${href}" aria-label="${resource.name} ${slot.label}: ${LABEL[slot.state]}, ${booking.userName}"><b>${LABEL[slot.state]}${extra}</b><span>${shortName(booking.userName)}</span></a>`;
  }
  if (slot.state === 'maintenance') return html`<span class="cell maintenance"><b>Maint.</b><span>${resource.maintenance?.note || ''}</span></span>`;
  if (slot.state === 'open_play') return html`<span class="cell open_play"><b>Open play</b><span>Free for all</span></span>`;
  return html`<span class="cell ${slot.state}"><b>${LABEL[slot.state] || slot.state}</b><span>${slot.state === 'available' ? 'Open' : ''}</span></span>`;
}

export function calendarView({ query }) {
  const { scope, listen, frame, api, render, on, poll, setTimeout } = viewTools();
  let today = isoDate(Date.now());
  let date = validDate(query.get('date')) ? query.get('date') : today;
  let activity = ['pickleball', 'table_tennis'].includes(query.get('activity')) ? query.get('activity') : '';
  let stripStart = stripAnchor(date < today || date > addDays(today, 13) ? date : today);
  let days = [];
  let generation = 0;
  let controller;
  scope?.own(() => controller?.abort());

  const root = frame({
    key: 'calendar', eyebrow: 'Facility', title: 'Availability calendar', mobileTitle: 'Calendar',
    template: html`<div class="page calendar-page">
      <div class="calendar-controls">
        <div class="calendar-date-nav" role="group" aria-label="Day navigation">
          <button type="button" class="icon-btn" data-step="-1" aria-label="Previous day">${icon('chevron-left', 20, 2.2)}</button>
          <input class="input" type="date" data-date value="${date}" aria-label="Calendar date">
          <button type="button" class="icon-btn" data-step="1" aria-label="Next day">${icon('chevron-right', 20, 2.2)}</button>
        </div>
        <button type="button" class="btn btn-text btn-sm" data-today>Today</button>
        <select class="select" data-activity aria-label="Activity"><option value="">All resources</option><option value="pickleball">Pickleball</option><option value="table_tennis">Table tennis</option></select>
      </div>
      <section class="calendar-dates" aria-labelledby="calendar-pick-date">
        <div class="calendar-date-heading"><div><h2 id="calendar-pick-date">Pick a date</h2><p class="small" data-month></p></div><button type="button" class="btn btn-secondary btn-sm" data-picker>${icon('calendar', 18)}Calendar</button></div>
        <div class="calendar-date-strip" role="group" aria-label="Available dates" data-date-strip></div>
        <div class="calendar-days-message" data-days-message hidden><span class="small" role="status" data-days-status></span><button type="button" class="btn btn-text btn-sm" data-retry-days>Retry dates</button></div>
      </section>
      <h2 class="h3" id="calendar-selected-date" data-title>${longDate(date)}</h2>
      <section class="panel calendar-schedule" aria-labelledby="calendar-selected-date">
        <div class="calendar-scroll-tools" data-scroll-tools hidden><span class="small" id="calendar-scroll-hint">Swipe or scroll to see all times</span><div class="row" data-gap="6"><button type="button" class="icon-btn sm" data-scroll="-1" aria-label="Earlier times">${icon('chevron-left', 18)}</button><button type="button" class="icon-btn sm" data-scroll="1" aria-label="Later times">${icon('chevron-right', 18)}</button></div></div>
        <div class="calendar-grid-scroll" tabindex="0" role="region" aria-label="Resource availability by time" data-scroll-area>
          <div data-grid aria-busy="true">${skeletonRows(6)}</div>
        </div>
      </section>
      <div class="legend"><span><i class="bar-open"></i>Available</span><span><i class="bar-held"></i>Held</span><span><i class="lg-violet"></i>Verifying</span><span><i class="bar-taken"></i>Booked</span><span><i class="lg-open-play"></i>Open play</span><span><i class="lg-hatch"></i>Maintenance / closed</span></div>
    </div>`,
  });
  const input = $('[data-date]', root), strip = $('[data-date-strip]', root);
  const grid = $('[data-grid]', root), scrollArea = $('[data-scroll-area]', root);
  $('[data-activity]', root).value = activity;

  function paintDates(scroll = false) {
    const focused = strip.contains(document.activeElement) ? document.activeElement.dataset.calendarDay : null;
    const end = addDays(stripStart, 13);
    $('[data-month]', root).textContent = monthLabel(stripStart) === monthLabel(end) ? monthLabel(stripStart) : `${monthLabel(stripStart)} – ${monthLabel(end)}`;
    render(strip, Array.from({ length: 14 }, (_, index) => {
      const value = addDays(stripStart, index), day = days.find(day => day.date === value);
      const status = day ? DAY_LABEL[day.state] : '…';
      return html`<button type="button" class="calendar-day ${day?.state || ''}" data-calendar-day="${value}" aria-pressed="${String(value === date)}" aria-label="${longDate(value)}, ${status}"><span class="calendar-day-top">${value === today ? 'Today' : weekdayLabel(value)}</span><span class="calendar-day-number">${Number(value.slice(-2))}</span><span class="calendar-day-status">${status}</span></button>`;
    }));
    if (focused) strip.querySelector(`[data-calendar-day="${focused}"]`)?.focus({ preventScroll: true });
    if (scroll) {
      const selected = strip.querySelector('[aria-pressed="true"]');
      const box = selected?.getBoundingClientRect(), area = strip.getBoundingClientRect();
      if (box?.left < area.left) strip.scrollLeft -= area.left - box.left;
      else if (box?.right > area.right) strip.scrollLeft += box.right - area.right;
    }
  }

  function syncScroll() {
    const max = scrollArea.scrollWidth - scrollArea.clientWidth;
    $('[data-scroll-tools]', root).hidden = max <= 1;
    $('[data-scroll="-1"]', root).disabled = scrollArea.scrollLeft <= 1;
    $('[data-scroll="1"]', root).disabled = scrollArea.scrollLeft >= max - 1;
    if (max > 1) scrollArea.setAttribute('aria-describedby', 'calendar-scroll-hint');
    else scrollArea.removeAttribute('aria-describedby');
  }

  function paintGrid(data) {
    const resources = data.resources || [];
    const starts = resources[0]?.slots?.map(slot => slot.start) || [];
    const focused = grid.contains(document.activeElement) ? document.activeElement.closest('[data-cell]')?.dataset.cell : null;
    if (!resources.length) render(grid, html`<div class="empty"><p class="empty-title">No resources to show</p><p class="empty-body">${activity ? 'Try All resources or configure resources for this activity.' : 'Add courts or tables in Resources to see their availability.'}</p><a class="btn btn-secondary btn-sm" href="${BASE}/facilities">Resources</a></div>`);
    else if (!starts.length) render(grid, html`<div class="empty"><p class="empty-title">${data.closedReason || 'Closed this day'}</p><p class="empty-body">No bookable hours on ${longDate(date)}.</p></div>`);
    else render(grid, html`<table class="calendar-matrix" data-css="--cols:${starts.length}">
      <caption class="sr-only">${longDate(date)}: ${activity === 'pickleball' ? 'pickleball' : activity === 'table_tennis' ? 'table tennis' : 'all resources'} availability</caption>
      <thead><tr><th scope="col" class="calendar-corner">Resource</th>${starts.map(start => html`<th scope="col">${hourLabel(start)}</th>`)}</tr></thead>
      <tbody>${resources.map(resource => html`<tr><th scope="row" class="calendar-resource">${resource.name}<small>${resource.activity === 'table_tennis' ? 'Table tennis' : 'Pickleball'}</small></th>${resource.slots.map(slot => html`<td data-cell="${resource.id}-${slot.start}">${cell(slot, resource, data.now)}</td>`)}</tr>`)}</tbody>
    </table>`);
    if (focused) grid.querySelector(`[data-cell="${CSS.escape(focused)}"] a`)?.focus({ preventScroll: true });
    syncScroll();
    setTimeout(syncScroll, 0);
  }

  async function load(loading = false) {
    const current = ++generation;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    const selected = date, filter = activity, from = stripStart;
    history.replaceState(history.state, '', `${BASE}/calendar?${new URLSearchParams({ date: selected, ...(filter ? { activity: filter } : {}) })}`);
    input.value = selected;
    $('[data-title]', root).textContent = longDate(selected);
    grid.setAttribute('aria-busy', 'true');
    if (loading) { scrollArea.scrollLeft = 0; scrollArea.scrollTop = 0; render(grid, skeletonRows(6)); syncScroll(); }
    paintDates(true);
    const active = () => current === generation && !signal.aborted && (!scope || scope.isCurrent());
    await Promise.all([
      api.get(`${API}/schedule?${new URLSearchParams({ date: selected, ...(filter ? { activity: filter } : {}) })}`, { signal }).then(data => {
        if (!active()) return;
        today = data.today || today; paintGrid(data); paintDates();
      }).catch(error => { if (active()) { render(grid, errorState(error)); syncScroll(); } }).finally(() => { if (active()) grid.setAttribute('aria-busy', 'false'); }),
      api.get(`${API}/schedule/days?${new URLSearchParams({ from, ...(filter ? { activity: filter } : {}) })}`, { signal }).then(data => {
        if (!active()) return;
        today = data.today || today; days = data.days || []; paintDates();
        $('[data-days-message]', root).hidden = true;
      }).catch(error => {
        if (!active()) return;
        days = []; paintDates();
        $('[data-days-message]', root).hidden = false;
        $('[data-days-status]', root).textContent = `Date availability could not load. ${error.message}`;
      }),
    ]);
  }

  function chooseDate(value, reset = false) {
    if (!validDate(value)) return;
    date = value;
    if (reset || date < stripStart || date > addDays(stripStart, 13)) { stripStart = stripAnchor(date); days = []; }
    load(true);
  }
  on(root, 'click', '[data-step]', (_event, button) => chooseDate(addDays(date, Number(button.dataset.step))));
  on(root, 'click', '[data-today]', () => chooseDate(today, true));
  on(root, 'click', '[data-calendar-day]', (_event, button) => chooseDate(button.dataset.calendarDay));
  listen(input, 'change', () => chooseDate(input.value));
  on(root, 'change', '[data-activity]', (_event, element) => { activity = element.value; days = []; load(true); });
  on(root, 'click', '[data-picker]', () => { try { input.showPicker(); } catch { input.focus(); } });
  on(root, 'click', '[data-act="retry"], [data-retry-days]', () => load(true));
  on(root, 'click', '[data-scroll]', (_event, button) => scrollArea.scrollBy({ left: Number(button.dataset.scroll) * Math.max(120, scrollArea.clientWidth - 110), behavior: 'smooth' }));
  listen(scrollArea, 'scroll', syncScroll, { passive: true });
  listen(window, 'resize', syncScroll);
  paintDates(); load();
  return poll(() => load(), 30_000);
}
