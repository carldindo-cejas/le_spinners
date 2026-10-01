import { api } from '../../core/api.js';
import { $, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { isoDate, minutesLabel, relTime } from '../../core/format.js';
import { clearFieldErrors, errorState, showFieldErrors, skeletonRows, toast } from '../../core/ui.js';
import { frame } from '../shell.js';
import { API, BASE } from '../console.js';
import { followUpNote, withImpactCheck } from '../impact.js';

const HALF_HOURS = Array.from({ length: 49 }, (_, i) => i * 30);
const timeLabel = (m) => (m === 1440 ? '12:00 AM (midnight)' : minutesLabel(m));

function timeSelect(name, value, label, { from = 0, to = 1440, disabled = false, id = '' } = {}) {
  return html`<select class="select" name="${name}" ${id ? html`id="${id}"` : html`aria-label="${label}"`} ${disabled ? 'disabled' : ''}>${HALF_HOURS.filter((m) => m >= from && m <= to).map((m) => html`<option value="${m}" ${m === value ? 'selected' : ''}>${timeLabel(m)}</option>`)}</select>`;
}

function hoursRow(h) {
  return html`<li class="hours-row" data-day="${h.weekday}">
    <span class="hr-day"><span class="strong">${h.name}</span><br><span class="small">${h.label}</span></span>
    <label class="check-toggle hr-open"><input type="checkbox" name="isOpen" ${h.isOpen ? 'checked' : ''}><span>Open</span></label>
    <span class="hr-times">${timeSelect('open', h.open, `${h.name} opening time`, { to: 1410, disabled: !h.isOpen })}<span aria-hidden="true">–</span>${timeSelect('close', h.close, `${h.name} closing time`, { from: 30, disabled: !h.isOpen })}</span>
    <button type="button" class="btn btn-secondary btn-xs hr-save" data-save-day="${h.weekday}" disabled>Save</button>
  </li>`;
}

function closureRow(cl) {
  return html`<li class="list-row">
    <span class="row-tile">${icon('calendar', 20)}</span>
    <span class="grow"><span class="row-title">${cl.dateLabel} · ${cl.resourceName || 'Whole facility'} · ${cl.timeLabel}</span><br><span class="row-meta">${cl.reason || 'No reason given'}${cl.createdBy ? ` · added by ${cl.createdBy} ${relTime(cl.createdAt)}` : ''}</span></span>
    <button type="button" class="btn btn-text btn-xs danger-text" data-remove="${cl.id}" aria-label="Remove closure on ${cl.dateLabel}">Remove</button>
  </li>`;
}

export async function availabilityView() {
  const main = frame({
    key: 'availability',
    eyebrow: 'Facility',
    title: 'Availability',
    template: html`<div class="page" data-page>${skeletonRows(5, 'sk-card')}</div>`,
  });
  // Listeners go on this render's own page element (main outlives the view).
  const root = $('[data-page]', main);
  let d = null;

  async function load() {
    try {
      d = await api.get(`${API}/availability`);
    } catch (err) {
      render(root, errorState(err));
      $('[data-act="retry"]', root)?.addEventListener('click', load);
      return;
    }
    const today = d.today || isoDate(Date.now());
    render(root, html`<div class="stack stack-20">
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Weekly hours</h2><a class="link-sm" href="${BASE}/calendar">Calendar</a></div>
        <ul class="hours-list">${d.hours.map(hoursRow)}</ul>
        <p class="panel-body small">Every court and table follows these hours. Slots are ${d.slotMinutes} minutes, starting at the opening time. Bookings that fall outside new hours are kept; you'll see them before saving.</p>
      </section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Closed dates</h2></div>
        <div class="panel-body cols c-420">
          <form class="stack stack-12" novalidate data-closure>
            <div class="grid-2 grid-2-stack">
              <div class="field"><label class="label" for="cl-date">Date</label><input class="input" id="cl-date" name="date" type="date" min="${today}" value="${today}"></div>
              <div class="field"><label class="label" for="cl-res">Applies to</label><select class="select" id="cl-res" name="resourceId"><option value="">Whole facility</option>${d.resources.map((r) => html`<option value="${r.id}">${r.name}</option>`)}</select></div>
            </div>
            <label class="check-toggle"><input type="checkbox" name="allDay" checked><span>All day</span></label>
            <div class="grid-2" data-times hidden>
              <div class="field"><label class="label" for="cl-start">From</label>${timeSelect('start', 960, 'From', { to: 1410, id: 'cl-start' })}</div>
              <div class="field"><label class="label" for="cl-end">Until</label>${timeSelect('end', 1080, 'Until', { from: 30, id: 'cl-end' })}</div>
            </div>
            <div class="field"><label class="label" for="cl-reason">Reason players see</label><input class="input" id="cl-reason" name="reason" maxlength="120" placeholder="e.g. Private event, Holiday"></div>
            <button type="submit" class="btn btn-primary btn-md">${icon('plus', 18)}Add closed date</button>
          </form>
          ${d.closures.length
            ? html`<ul class="menu closures-list">${d.closures.map(closureRow)}</ul>`
            : html`<p class="small">No closed dates coming up.</p>`}
        </div>
      </section>
    </div>`);
  }

  // Weekly hours: enable Save when a row changes.
  on(root, 'change', '.hours-row input, .hours-row select', (_e, el) => {
    const row = el.closest('.hours-row');
    const open = row.querySelector('[name="isOpen"]').checked;
    for (const s of row.querySelectorAll('select')) s.disabled = !open;
    row.querySelector('[data-save-day]').disabled = false;
  });
  on(root, 'click', '[data-save-day]', async (_e, btn) => {
    const row = btn.closest('.hours-row');
    const weekday = Number(btn.dataset.saveDay);
    const body = {
      isOpen: row.querySelector('[name="isOpen"]').checked,
      open: Number(row.querySelector('[name="open"]').value),
      close: Number(row.querySelector('[name="close"]').value),
    };
    const name = d.hours[weekday].name;
    if (body.isOpen && body.open >= body.close) return toast(`${name}: closing time must be after opening time.`, { type: 'error' });
    setBusy(btn, true, 'Saving…');
    try {
      const res = await withImpactCheck((confirmAffected) => api.put(`${API}/availability/hours/${weekday}`, { ...body, confirmAffected }));
      if (!res) return setBusy(btn, false);
      toast(`${name} hours saved`, { sub: followUpNote(res) || 'Players see the new hours right away.' });
      load();
    } catch (err) {
      setBusy(btn, false);
      const detail = err.details && Object.values(err.details)[0];
      toast(detail ? `${name}: ${detail[0]}` : err.message, { type: 'error' });
    }
  });

  // Closed dates
  on(root, 'change', '[data-closure] [name="allDay"]', (_e, el) => ($('[data-times]', root).hidden = el.checked));
  on(root, 'submit', '[data-closure]', async (e, form) => {
    e.preventDefault();
    clearFieldErrors(form);
    const f = (n) => form.elements.namedItem(n);
    const allDay = f('allDay').checked;
    const body = {
      date: f('date').value,
      resourceId: f('resourceId').value || null,
      start: allDay ? null : Number(f('start').value),
      end: allDay ? null : Number(f('end').value),
      reason: f('reason').value.trim(),
    };
    const errors = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) errors.date = ['Pick a date.'];
    if (body.reason.length < 3) errors.reason = ['Give a short reason (players may see it).'];
    if (!allDay && body.start >= body.end) errors.end = ['The end must be after the start.'];
    if (Object.keys(errors).length) return showFieldErrors(form, errors);
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Adding…');
    try {
      const res = await withImpactCheck((confirmAffected) => api.post(`${API}/availability/closures`, { ...body, confirmAffected }));
      if (!res) return setBusy(btn, false);
      toast('Closed date added', { sub: followUpNote(res) || 'Those times are no longer bookable.' });
      load();
    } catch (err) {
      setBusy(btn, false);
      if (!showFieldErrors(form, err.details)) toast(err.message, { type: 'error' });
    }
  });
  on(root, 'click', '[data-remove]', async (_e, btn) => {
    setBusy(btn, true, 'Removing…');
    try {
      await api.delete(`${API}/availability/closures/${encodeURIComponent(btn.dataset.remove)}`);
      toast('Closed date removed', { sub: 'Those times are bookable again.' });
      load();
    } catch (err) {
      setBusy(btn, false);
      toast(err.message, { type: 'error' });
    }
  });

  load();
  return undefined;
}