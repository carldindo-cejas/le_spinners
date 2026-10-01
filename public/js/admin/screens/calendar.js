import { api } from '../../core/api.js';
import { $, html, on, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { addDays, firstName, hourLabel, isoDate, longDate, mmss } from '../../core/format.js';
import { errorState, poll, skeletonRows } from '../../core/ui.js';
import { frame } from '../shell.js';

const LABEL = { available: 'Available', booked: 'Booked', unavailable: 'Verifying', held: 'Held', closed: 'Closed', past: 'Past', maintenance: 'Maintenance' };

function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  const last = parts.length > 1 ? `${parts[parts.length - 1][0]}.` : '';
  return `${firstName(name)} ${last}`.trim();
}

function cell(s, r, now) {
  const b = s.booking;
  if (b) {
    const extra = s.state === 'held' && b.holdExpiresAt ? ` · ${mmss(b.holdExpiresAt - now)}` : '';
    const href = s.state === 'unavailable' ? `/admin/verify/${b.id}` : `/admin/bookings/${b.id}`;
    return html`<a class="cell ${s.state}" href="${href}" aria-label="${r.name} ${s.label}: ${LABEL[s.state]}, ${b.userName}"><b>${LABEL[s.state]}${extra}</b><span>${shortName(b.userName)}</span></a>`;
  }
  if (s.state === 'maintenance') return html`<span class="cell maintenance"><b>Maint.</b><span>${r.maintenance?.note || ''}</span></span>`;
  return html`<span class="cell ${s.state}"><b>${LABEL[s.state] || s.state}</b><span>${s.state === 'available' ? 'Open' : ''}</span></span>`;
}

export function calendarView({ query }) {
  let date = /^\d{4}-\d{2}-\d{2}$/.test(query.get('date') || '') ? query.get('date') : isoDate(Date.now());
  let activity = query.get('activity') || '';
  const root = frame({
    key: 'calendar',
    eyebrow: 'Facility',
    title: 'Availability calendar',
    mobileTitle: 'Calendar',
    template: html`<div class="page">
      <div class="filters">
        <button type="button" class="icon-btn" data-step="-1" aria-label="Previous day">${icon('chevron-left', 20, 2.2)}</button>
        <input class="input" type="date" data-date value="${date}" aria-label="Date">
        <button type="button" class="icon-btn" data-step="1" aria-label="Next day">${icon('chevron-right', 20, 2.2)}</button>
        <button type="button" class="btn btn-text btn-sm" data-today>Today</button>
        <select class="select" data-activity aria-label="Activity"><option value="">All resources</option><option value="pickleball">Pickleball</option><option value="table_tennis">Table tennis</option></select>
      </div>
      <p class="h3" data-title>${longDate(date)}</p>
      <div data-grid>${skeletonRows(6)}</div>
      <div class="legend"><span><i class="bar-open"></i>Available</span><span><i class="bar-held"></i>Held</span><span><i class="lg-violet"></i>Verifying</span><span><i class="bar-taken"></i>Booked</span><span><i class="lg-hatch"></i>Maintenance / closed</span></div>
    </div>`,
  });
  $('[data-activity]', root).value = activity;
  const grid = $('[data-grid]', root);

  async function load() {
    history.replaceState(history.state, '', `/admin/calendar?date=${date}${activity ? `&activity=${activity}` : ''}`);
    $('[data-title]', root).textContent = longDate(date);
    try {
      const d = await api.get(`/api/admin/schedule?date=${date}${activity ? `&activity=${activity}` : ''}`);
      if (!d.resources.length || !d.resources[0].slots.length) {
        render(grid, html`<div class="empty"><p class="empty-title">${d.closedReason || 'Closed this day'}</p><p class="empty-body">No bookable hours on ${longDate(date)}.</p></div>`);
        return;
      }
      const hours = d.resources[0].slots.map((s) => s.start);
      render(grid, html`<div class="sched-wrap panel panel-body"><div class="sched" data-css="--cols:${hours.length}">
        <span></span>${hours.map((h) => html`<span class="sched-head">${hourLabel(h)}</span>`)}
        ${d.resources.map((r) => html`<span class="sched-res">${r.name}<small>${r.activity === 'table_tennis' ? 'Table tennis' : 'Pickleball'}</small></span>${r.slots.map((s) => cell(s, r, d.now))}`)}
      </div></div>`);
    } catch (err) {
      render(grid, errorState(err));
      $('[data-act="retry"]', grid)?.addEventListener('click', load);
    }
  }

  on(root, 'click', '[data-step]', (_e, btn) => {
    date = addDays(date, Number(btn.dataset.step));
    $('[data-date]', root).value = date;
    load();
  });
  on(root, 'click', '[data-today]', () => {
    date = isoDate(Date.now());
    $('[data-date]', root).value = date;
    load();
  });
  on(root, 'change', '[data-date]', (_e, el) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(el.value)) {
      date = el.value;
      load();
    }
  });
  on(root, 'change', '[data-activity]', (_e, el) => {
    activity = el.value;
    load();
  });
  load();
  return poll(load, 30_000);
}
