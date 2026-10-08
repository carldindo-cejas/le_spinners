import { createViewTools } from '../core/view.js';
import { api } from '../core/api.js';
import { html, listen, on, render } from '../core/dom.js';
import { addDays, hourLabel, longDate, minutesLabel, rangeLabel } from '../core/format.js';
import { icon } from '../core/icons.js';
import { errorState, poll, skeletonRows } from '../core/ui.js';

const viewTools = createViewTools({ api, listen, on, render, poll });
const LABEL = { available: 'Available', held: 'On hold', booked: 'Booked', unavailable: 'Verifying', mine: 'Your booking', past: 'Past', closed: 'Closed', maintenance: 'Maintenance', open_play: 'Open play' };
const DAY_LABEL = { open: 'Open', full: 'Full', closed: 'Closed', past: 'Past', open_play: 'Open play', empty: 'No resources' };
const datePart = (date, options) => new Intl.DateTimeFormat('en-PH', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const initialActivity = facility => facility.activities.find(activity => activity.id === 'pickleball')?.id || facility.activities[0]?.id;

export function availabilityCalendar(facility) {
  return html`<section class="section o-4 home-calendar" data-availability-calendar aria-labelledby="home-availability-title">
    <div class="section-head"><h2 class="h2" id="home-availability-title" data-availability-heading>Available today</h2><span class="row small" data-gap="6"><span class="live-dot"></span><span data-live role="status">Checking…</span></span></div>
    <div class="home-calendar-filters" role="group" aria-label="Filter availability by sport">${facility.activities.map(activity => html`<button type="button" class="btn btn-sm home-calendar-filter" data-calendar-activity="${activity.id}" aria-pressed="${String(activity.id === initialActivity(facility))}">${icon(activity.id === 'table_tennis' ? 'pingpong' : 'paddle', 18)}${activity.label}</button>`)}</div>
    <div class="home-calendar-heading"><div><h3>Pick a date</h3><p class="small" data-calendar-month></p></div>
      <label class="btn btn-secondary btn-sm home-calendar-picker">${icon('calendar', 18)}Calendar<input type="date" data-calendar-input aria-label="Calendar date" min="${facility.today}" max="${addDays(facility.today, facility.rules.bookingWindowDays)}" value="${facility.today}"></label>
    </div>
    <div class="home-calendar-dates" role="group" aria-label="Available dates" data-calendar-dates></div>
    <div class="home-calendar-message" data-calendar-message hidden><span class="small" role="status" data-calendar-message-text></span><button type="button" class="btn btn-text btn-sm" data-retry-dates>Retry dates</button></div>
    <h3 class="h3" id="home-calendar-date" data-calendar-title>${longDate(facility.today)}</h3>
    <div class="card home-calendar-schedule">
      <div class="home-calendar-scroll" tabindex="0" role="region" aria-labelledby="home-calendar-date" data-calendar-scroll-area><div data-calendar-grid aria-busy="true">${skeletonRows(3)}</div></div>
    </div>
    <div class="legend legend-pills"><span class="lp available">Available</span><span class="lp held">On hold</span><span class="lp booked">Booked</span><span class="lp unavailable">Verifying / closed</span></div>
    <a class="btn btn-text btn-block" href="/book">See all courts &amp; tables</a>
  </section>`;
}

function slotCell(resource, slot, date) {
  const label = LABEL[slot.state] || 'Unavailable';
  const contents = html`<b>${minutesLabel(slot.start).slice(0, -3)}–${minutesLabel(slot.end).slice(0, -3)}</b><span>${label}</span>`;
  const aria = `${resource.name}, ${longDate(date)}, ${rangeLabel(slot.start, slot.end)}: ${label}`;
  if (slot.state === 'available') return html`<a class="home-calendar-slot available" data-availability-slot="${resource.id}-${slot.start}" href="/book/${resource.activity}/${date}/${resource.id}?start=${slot.start}" aria-label="${aria}">${contents}</a>`;
  if (slot.state === 'mine' && slot.booking) return html`<a class="home-calendar-slot mine" href="/bookings/${slot.booking.id}" aria-label="${aria}">${contents}</a>`;
  return html`<span class="home-calendar-slot ${slot.state}" aria-label="${aria}" aria-disabled="true">${contents}</span>`;
}

export function startAvailabilityCalendar(root, facility, ctx) {
  const { scope, api, listen, on, render, poll } = viewTools(ctx);
  const find = selector => root.querySelector(selector);
  const strip = find('[data-calendar-dates]'), grid = find('[data-calendar-grid]');
  const input = find('[data-calendar-input]'), scrollArea = find('[data-calendar-scroll-area]');
  const activities = facility.activities.map(activity => activity.id);
  let activity = initialActivity(facility);
  let today = facility.today, date = today;
  let summaries = [], selectedDays = [];
  let gridController, datesController;
  let gridMarkup = '', datesMarkup = '';
  let disposed = false;
  const active = controller => !disposed && !controller.signal.aborted && (!scope || scope.isCurrent());

  function updateToday(value) {
    if (!value || value === today) return false;
    today = value; facility.today = value;
    if (date < today || date > addDays(today, facility.rules.bookingWindowDays)) {
      date = today; selectedDays = []; loadGrid(true);
      return true;
    }
    return false;
  }

  function dayState(value) {
    if (!activity) return 'empty';
    if (value === date && selectedDays.length) {
      const resources = selectedDays.filter(day => day.activity === activity).flatMap(day => day.resources);
      const slots = resources.flatMap(resource => resource.slots);
      if (!resources.length) return 'empty';
      if (slots.some(slot => slot.state === 'available')) return 'open';
      if (slots.some(slot => slot.state === 'open_play')) return 'open_play';
      if (slots.some(slot => ['held', 'booked', 'unavailable', 'mine'].includes(slot.state))) return 'full';
      if (slots.length && slots.every(slot => slot.state === 'past')) return 'past';
      return 'closed';
    }
    const day = summaries[activities.indexOf(activity)]?.days.find(day => day.date === value);
    if (!day) return '';
    if (day.available > 0) return 'open';
    if (day.openPlay > 0) return 'open_play';
    if (day.load === 'full') return 'full';
    return 'closed';
  }

  function paintDates(scroll = false) {
    const last = addDays(today, facility.rules.bookingWindowDays);
    input.min = today; input.max = last; input.value = date;
    find('[data-calendar-title]').textContent = longDate(date);
    find('[data-availability-heading]').textContent = date === today ? 'Available today' : 'Availability calendar';
    const firstMonth = datePart(today, { month: 'short', year: 'numeric' }), lastMonth = datePart(last, { month: 'short', year: 'numeric' });
    find('[data-calendar-month]').textContent = firstMonth === lastMonth ? firstMonth : `${firstMonth} – ${lastMonth}`;
    const markup = html`${Array.from({ length: facility.rules.bookingWindowDays + 1 }, (_, index) => {
      const value = addDays(today, index), status = dayState(value), label = DAY_LABEL[status] || '…';
      return html`<button type="button" class="home-calendar-day ${status}" data-availability-date="${value}" aria-pressed="${String(value === date)}" aria-label="${longDate(value)}, ${label}"><span class="home-calendar-day-top">${value === today ? 'Today' : datePart(value, { weekday: 'short' })}</span><span class="home-calendar-day-number">${Number(value.slice(-2))}</span><span class="home-calendar-day-status">${label}</span></button>`;
    })}`;
    if (String(markup) !== datesMarkup) {
      const focused = strip.contains(document.activeElement) ? document.activeElement.dataset.availabilityDate : null;
      render(strip, markup); datesMarkup = String(markup);
      if (focused) strip.querySelector(`[data-availability-date="${focused}"]`)?.focus({ preventScroll: true });
    }
    if (scroll) {
      const selected = strip.querySelector('[aria-pressed="true"]');
      const box = selected?.getBoundingClientRect(), area = strip.getBoundingClientRect();
      if (box?.left < area.left) strip.scrollLeft -= area.left - box.left;
      else if (box?.right > area.right) strip.scrollLeft += box.right - area.right;
    }
  }

  function paintGrid() {
    const days = selectedDays.filter(day => day.activity === activity);
    const resources = days.flatMap(day => day.resources);
    const starts = [...new Set(resources.flatMap(resource => resource.slots.map(slot => slot.start)))].sort((a, b) => a - b);
    const markup = !resources.length
      ? html`<div class="empty"><p class="empty-title">No courts or tables to show yet</p><p class="empty-body">Check back for available resources.</p></div>`
      : !starts.length
        ? html`<div class="empty"><p class="empty-title">${days.find(day => day.closedReason)?.closedReason || 'Closed this day'}</p><p class="empty-body">Choose another date to see available times.</p></div>`
        : html`<table class="home-calendar-matrix" data-css="--cols:${starts.length}"><caption class="sr-only">${longDate(date)}: court and table availability</caption>
          <thead><tr><th scope="col" class="home-calendar-corner">Resource</th>${starts.map(start => html`<th scope="col">${hourLabel(start)}</th>`)}</tr></thead>
          <tbody>${resources.map(resource => {
            const byStart = new Map(resource.slots.map(slot => [slot.start, slot]));
            return html`<tr><th scope="row" class="home-calendar-resource">${resource.name}<small>${resource.activity === 'table_tennis' ? 'Table tennis' : 'Pickleball'}</small></th>${starts.map(start => html`<td>${slotCell(resource, byStart.get(start) || { start, end: start + facility.rules.slotMinutes, state: 'closed' }, date)}</td>`)}</tr>`;
          })}</tbody></table>`;
    if (String(markup) !== gridMarkup) {
      const focused = grid.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
      render(grid, markup); gridMarkup = String(markup);
      if (focused) [...grid.querySelectorAll('a')].find(link => link.getAttribute('href') === focused)?.focus({ preventScroll: true });
    }
  }

  async function loadGrid(loading = false) {
    gridController?.abort();
    const controller = gridController = new AbortController(), selected = date;
    grid.setAttribute('aria-busy', 'true');
    find('[data-live]').textContent = 'Checking…';
    if (loading) {
      selectedDays = []; gridMarkup = '';
      scrollArea.scrollLeft = 0; scrollArea.scrollTop = 0;
      render(grid, skeletonRows(3));
    }
    paintDates(true);
    try {
      const days = await Promise.all(activities.map(activity => api.get(`/api/availability?${new URLSearchParams({ activity, date: selected })}`, { signal: controller.signal })));
      if (!active(controller)) return;
      if (updateToday(days[0]?.today) || selected !== date) return;
      selectedDays = days; paintGrid(); paintDates();
      find('[data-live]').textContent = 'Live · just now';
    } catch (error) {
      if (!active(controller)) return;
      selectedDays = []; gridMarkup = '';
      render(grid, errorState(error, { title: "Couldn't load live availability" }));
      find('[data-live]').textContent = 'Unavailable';
      paintDates();
    } finally {
      if (active(controller)) grid.setAttribute('aria-busy', 'false');
    }
  }

  async function loadDates() {
    datesController?.abort();
    const controller = datesController = new AbortController();
    try {
      const data = await Promise.all(activities.map(activity => api.get(`/api/availability/days?activity=${activity}`, { signal: controller.signal })));
      if (!active(controller)) return;
      summaries = data; updateToday(data[0]?.today); paintDates();
      find('[data-calendar-message]').hidden = true;
      data.forEach((summary, index) => {
        const element = root.querySelector(`[data-open-count="${activities[index]}"]`);
        if (!element) return;
        const count = summary.days.find(day => day.date === today)?.available || 0;
        element.textContent = count ? `${count} open today` : 'No open times today · book ahead';
        element.classList.toggle('none', !count);
      });
    } catch (error) {
      if (!active(controller)) return;
      summaries = []; paintDates();
      find('[data-calendar-message]').hidden = false;
      find('[data-calendar-message-text]').textContent = `Date availability could not load. ${error.message}`;
      root.querySelectorAll('[data-open-count]').forEach(element => { element.textContent = 'Tap to see times'; element.classList.add('none'); });
    }
  }

  function chooseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < today || value > addDays(today, facility.rules.bookingWindowDays)) { input.value = date; return; }
    if (value === date) return;
    date = value; loadGrid(true);
  }
  on(strip, 'click', '[data-availability-date]', (_event, button) => chooseDate(button.dataset.availabilityDate));
  on(root, 'click', '[data-calendar-activity]', (_event, button) => {
    const selected = button.dataset.calendarActivity;
    if (!activities.includes(selected) || selected === activity) return;
    activity = selected;
    root.querySelectorAll('[data-calendar-activity]').forEach(filter => filter.setAttribute('aria-pressed', String(filter.dataset.calendarActivity === activity)));
    scrollArea.scrollLeft = 0; scrollArea.scrollTop = 0;
    if (selectedDays.length) paintGrid();
    paintDates();
  });
  const openPicker = () => { try { input.showPicker?.(); } catch { input.focus(); } };
  listen(input, 'click', openPicker);
  listen(input, 'keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPicker(); } });
  listen(input, 'change', () => chooseDate(input.value));
  on(root, 'click', '[data-calendar-grid] [data-act="retry"]', () => loadGrid(true));
  on(root, 'click', '[data-retry-dates]', loadDates);
  paintDates(); loadGrid(); loadDates();
  const stopPoll = poll(() => Promise.all([loadGrid(), loadDates()]), 30_000);
  const stop = () => { disposed = true; gridController?.abort(); datesController?.abort(); stopPoll(); };
  scope?.own(stop);
  return stop;
}
