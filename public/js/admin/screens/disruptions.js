import { createViewTools } from '../../core/view.js';
import { api } from '../../core/api.js';
import { listen, $, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { addDays, dayClock, minutesLabel, relTime } from '../../core/format.js';
import { choiceKeys, errorState, showFieldErrors, clearFieldErrors, skeletonRows, statusPill, syncChoiceGroups, toast } from '../../core/ui.js';
import { frame, navigate, refreshBadges, state } from '../shell.js';
import { API, BASE } from '../console.js';
import { CATEGORY_OPTIONS, openDisruptionDialog } from '../disrupt.js';

const viewTools = createViewTools({ listen, api, on, render, setBusy, showFieldErrors, clearFieldErrors, toast, frame, navigate, refreshBadges });

/**
 * Disruptions (REBOOKING.md §11): every operator cancellation and every closure that cancelled
 * or credited bookings, with what happened to each booking. Recording a new one previews
 * everything before it is applied.
 */

const HALF_HOURS = Array.from({ length: 49 }, (_, i) => i * 30);
const timeText = (m) => (m === 1440 ? '12:00 AM (midnight)' : minutesLabel(m));
const ADMIN_RETRO_DAYS = 7;

function card(d) {
  return html`<a class="panel panel-body dz-card" href="${BASE}/disruptions/${d.id}">
    <div class="row row-between row-wrap" data-gap="8">
      <span class="row row-wrap" data-gap="8"><span class="pill sm amber">${d.categoryLabel}</span>${d.openCount ? html`<span class="pill sm red">${d.openCount} to finish</span>` : ''}</span>
      <span class="small">${relTime(d.createdAt)}</span></div>
    <p class="strong">${d.scopeLabel}${d.dateLabel ? ` · ${d.dateLabel}` : ''}${d.timeLabel ? ` · ${d.timeLabel}` : ''}</p>
    <p class="small">"${d.reason}" · ${d.itemCount} booking${d.itemCount === 1 ? '' : 's'} · ${d.creditedLabel} credited · by ${d.createdBy}</p>
  </a>`;
}

export function disruptionsView({ query }) {
  const { listen, frame, render, api, on } = viewTools();
  let filter = query.get('filter') === 'open' ? 'open' : 'all';
  const main = frame({
    key: 'disruptions',
    eyebrow: 'Operations',
    title: 'Disruptions',
    actions: html`<a class="btn btn-primary btn-sm" href="${BASE}/disruptions/new">${icon('plus', 18)}Record a disruption</a>`,
    template: html`<div class="page" data-page>
      <div class="row row-between" data-gap="8"><div class="chip-row" role="group" aria-label="Show" data-chips></div>
        <a class="btn btn-primary btn-sm only-mobile" href="${BASE}/disruptions/new">${icon('plus', 18)}Record</a></div>
      <div class="stack stack-12" data-list>${skeletonRows(3, 'sk-card')}</div>
      <p class="small">A disruption cancels or cuts short bookings Le Spinners can't honour (weather, repairs, an emergency) and gives each player booking credit for what they paid. To cancel one booking, open it and choose <b>Cancel &amp; credit</b>.</p>
    </div>`,
  });
  const root = $('[data-page]', main);
  const list = $('[data-list]', root);

  function chips() {
    render($('[data-chips]', root), [['all', 'All'], ['open', 'Needs follow-up']].map(([k, label]) => html`<button type="button" class="chip" data-filter="${k}" aria-pressed="${String(filter === k)}">${label}${k === 'open' && state.badges.disruptionsOpen ? ` · ${state.badges.disruptionsOpen}` : ''}</button>`));
  }

  async function load() {
    chips();
    try {
      const d = await api.get(`${API}/disruptions?filter=${filter}`);
      render(list, d.disruptions.length
        ? d.disruptions.map(card)
        : html`<div class="empty"><span class="tile green lg">${icon('check-circle', 26)}</span><p class="empty-title">${filter === 'open' ? 'Nothing to follow up' : 'No disruptions yet'}</p>
            <p class="empty-body">${filter === 'open' ? 'Every booking in every disruption is handled.' : 'When weather, repairs or an emergency stop play, record it here: affected players get booking credit.'}</p></div>`);
    } catch (err) {
      render(list, errorState(err));
      listen($('[data-act="retry"]', list), 'click', load);
    }
  }
  on(root, 'click', '[data-filter]', (_e, btn) => {
    filter = btn.dataset.filter;
    history.replaceState(history.state, '', filter === 'open' ? `${BASE}/disruptions?filter=open` : `${BASE}/disruptions`);
    load();
  });
  load();
}

function timeSelect(name, value, label, id) {
  return html`<select class="select" name="${name}" id="${id}" aria-label="${label}">${HALF_HOURS.map((m) => html`<option value="${m}" ${m === value ? 'selected' : ''}>${timeText(m)}</option>`)}</select>`;
}

/** Facility-local minutes now, rounded down to the half hour. */
function nowHalfHour() {
  const d = new Date(Date.now() + 8 * 3_600_000);
  return Math.floor((d.getUTCHours() * 60 + d.getUTCMinutes()) / 30) * 30;
}

export async function newDisruptionView() {
  const { listen, frame, api, render, on, clearFieldErrors, showFieldErrors, refreshBadges, navigate } = viewTools();
  const main = frame({
    key: 'disruptions',
    eyebrow: 'Disruptions',
    title: 'Record a disruption',
    tabs: false,
    template: html`<div class="page" data-page>${skeletonRows(4, 'sk-card')}</div>`,
  });
  const root = $('[data-page]', main);
  let avail;
  try {
    avail = await api.get(`${API}/availability`);
  } catch (err) {
    render(root, errorState(err));
    return;
  }
  const admin = state.user.role === 'admin';
  const today = avail.today;
  const hoursOn = (date) => avail.hours[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const first = hoursOn(today);
  let category = 'weather';
  const startDefault = first && first.isOpen ? Math.max(first.open, Math.min(nowHalfHour(), first.close - 30)) : 960;
  const endDefault = first && first.isOpen ? first.close : 1320;

  render(root, html`<form class="panel panel-body stack stack-16 dz-form" novalidate data-form>
      <p class="body">Bookings with any time inside the window are previewed first: nothing changes until you confirm.</p>
      <div class="grid-2 grid-2-stack">
        <div class="field"><label class="label" for="dz-date">Date</label>
          <input class="input" type="date" id="dz-date" name="date" min="${admin ? addDays(today, -ADMIN_RETRO_DAYS) : today}" value="${today}">
          <p class="help">${admin ? `Up to ${ADMIN_RETRO_DAYS} days back.` : 'Today or later. Ask an administrator to record an earlier day.'}</p></div>
        <div class="field"><label class="label" for="dz-scope">Where</label>
          <select class="select" id="dz-scope" name="scope">
            <option value="all">Whole facility</option>
            <option value="activity:pickleball">All pickleball courts</option>
            <option value="activity:table_tennis">All table-tennis tables</option>
            ${avail.resources.map((r) => html`<option value="resource:${r.id}">${r.name}</option>`)}
          </select></div>
      </div>
      <div class="stack stack-8">
        <div class="row row-wrap" data-gap="8"><span class="label">When</span>
          <button type="button" class="chip" data-quick="now">From now to closing</button><button type="button" class="chip" data-quick="day">All day</button></div>
        <div class="grid-2">
          <div class="field"><label class="label" for="dz-start">From</label>${timeSelect('start', startDefault, 'From', 'dz-start')}</div>
          <div class="field"><label class="label" for="dz-end">Until</label>${timeSelect('end', endDefault, 'Until', 'dz-end')}</div>
        </div>
        <p class="help">Time already played before "From" isn't credited.</p>
      </div>
      <div class="field"><span class="label" id="dz-cat-l">What happened</span>
        <div class="chip-row wrap" role="radiogroup" aria-labelledby="dz-cat-l" data-cats>${CATEGORY_OPTIONS.filter((c) => !c.admin).map((c) => html`<button type="button" class="chip" role="radio" data-cat="${c.id}" aria-checked="${String(c.id === category)}">${c.label}</button>`)}</div></div>
      <div class="field"><label class="label" for="dz-r">Reason players see</label><input class="input" id="dz-r" name="reason" maxlength="120" placeholder="e.g. Heavy rain — courts flooded" autocomplete="off"></div>
      <div class="field"><label class="label" for="dz-n">Internal note <span class="opt">(staff only)</span></label><textarea class="textarea" id="dz-n" name="staffNote" maxlength="500" rows="2"></textarea></div>
      <div class="row row-wrap" data-gap="8"><button type="submit" class="btn btn-primary btn-md">${icon('eye', 18)}Preview affected bookings</button><a class="btn btn-secondary btn-md" href="${BASE}/disruptions">Cancel</a></div>
    </form>`);
  const form = $('[data-form]', root);
  syncChoiceGroups(root);
  listen(form, 'keydown', choiceKeys);
  const f = (n) => form.elements.namedItem(n);

  on(form, 'click', '[data-cat]', (_e, btn) => {
    category = btn.dataset.cat;
    for (const b of form.querySelectorAll('[data-cat]')) b.setAttribute('aria-checked', String(b.dataset.cat === category));
    syncChoiceGroups(root);
  });
  on(form, 'click', '[data-quick]', (_e, btn) => {
    const date = f('date').value || today;
    const h = hoursOn(date);
    const open = h && h.isOpen ? h.open : 0;
    const close = h && h.isOpen ? h.close : 1440;
    f('start').value = String(btn.dataset.quick === 'now' && date === today ? Math.max(open, Math.min(nowHalfHour(), close - 30)) : open);
    f('end').value = String(close);
  });
  on(form, 'submit', '[data-form]', (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    const date = f('date').value;
    const start = Number(f('start').value);
    const end = Number(f('end').value);
    const reason = f('reason').value.trim();
    const errors = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = ['Pick a date.'];
    if (start >= end) errors.end = ['The end must be after the start.'];
    if (reason.length < 3) errors.reason = ['Give a short reason players will see.'];
    if (Object.keys(errors).length) return showFieldErrors(form, errors);
    const [kind, value] = f('scope').value.split(':');
    const scope = { kind: 'window', date, start, end, activity: kind === 'activity' ? value : null, resourceId: kind === 'resource' ? value : null };
    openDisruptionDialog({
      title: 'Record a disruption',
      form: false,
      scope,
      defaults: { category, reason, staffNote: f('staffNote').value.trim() },
      onDone: (r) => {
        refreshBadges();
        navigate(`${BASE}/disruptions/${r.disruption.id}`);
      },
    });
    return undefined;
  });
}

const OUTCOME_TONE = { cancelled: 'neutral', partial: 'blue', deferred: 'violet', skipped: 'amber', pending: 'neutral' };

function itemCard(i) {
  return html`<li class="dz-item">
    <div class="dz-main">
      <div class="row row-wrap" data-gap="8"><a class="mono" href="${BASE}/bookings/${i.bookingId}">${i.ref}</a><span class="strong">${i.userName}</span>
        <span class="pill sm ${OUTCOME_TONE[i.outcome] || 'neutral'}">${i.outcomeLabel}</span></div>
      <p class="small">${i.whereLabel}</p>
      <p class="small">Affected ${i.affectedLabel} · was ${i.statusBefore.toLowerCase().replace('_', ' ')}, now ${statusPill(i.bookingStatus, { small: true, noIcon: true })}</p>
      ${i.skipLabel ? html`<p class="small amber-text">${i.skipLabel}</p>` : ''}
      ${i.flags.length ? html`<div class="row row-wrap" data-gap="6">${i.flags.map((fl) => html`<span class="pill sm neutral">${fl.label}</span>`)}</div>` : ''}
    </div>
    <div class="dz-side">
      ${i.creditId ? html`<a class="mono strong blue-text" href="${BASE}/credits/${i.creditId}">${i.creditLabel}</a>` : html`<span class="mono small">${i.paidValue ? 'No credit' : 'Nothing paid'}</span>`}
      ${i.open ? html`<div class="row row-wrap" data-gap="6">
        ${i.outcome === 'deferred' ? html`<a class="btn btn-violet btn-xs" href="${BASE}/verify/${i.bookingId}">Verify payment</a>` : ''}
        <button type="button" class="btn btn-secondary btn-xs" data-apply="${i.bookingId}">${i.outcome === 'deferred' ? 'Apply now' : 'Review again'}</button></div>` : ''}
    </div>
  </li>`;
}

export async function disruptionDetailView({ params }) {
  const { listen, frame, api, render, on, setBusy, toast, refreshBadges } = viewTools();
  const id = params.id;
  const main = frame({
    key: 'disruptions',
    eyebrow: 'Disruptions',
    title: 'Disruption',
    tabs: false,
    template: html`<div class="page" data-page>${skeletonRows(4, 'sk-card')}</div>`,
  });
  const root = $('[data-page]', main);

  async function load() {
    let d;
    try {
      d = await api.get(`${API}/disruptions/${encodeURIComponent(id)}`);
    } catch (err) {
      render(root, errorState(err, { retry: err.status !== 404, title: err.status === 404 ? 'Disruption not found' : undefined }));
      listen($('[data-act="retry"]', root), 'click', load);
      return;
    }
    const x = d.disruption;
    render(root, html`<div class="row" data-gap="12"><a class="icon-btn" href="${BASE}/disruptions" data-back aria-label="Back to disruptions">${icon('chevron-left', 22, 2.2)}</a>
        <span class="pill amber">${x.categoryLabel}</span>${x.openCount ? html`<span class="pill red sm">${x.openCount} to finish</span>` : ''}</div>
      <section class="panel panel-body stack stack-12">
        <p class="h3">${x.scopeLabel}${x.dateLabel ? ` · ${x.dateLabel}` : ''}${x.timeLabel ? ` · ${x.timeLabel}` : ''}</p>
        <p class="body">"${x.reason}"</p>
        ${x.staffNote ? html`<p class="small">Internal note: ${x.staffNote}</p>` : ''}
        <div class="dz-totals">
          <div><span class="eyebrow">Bookings</span><span class="num">${x.itemCount}</span></div>
          <div><span class="eyebrow">Credited</span><span class="num mono">${x.creditedLabel}</span></div>
          <div><span class="eyebrow">Compensation</span><span class="num sm">${x.compensation === 'none' ? 'No credit' : 'Booking credit'}</span></div>
        </div>
        <p class="small">Recorded by ${x.createdBy} · ${dayClock(x.createdAt)}${x.effectiveFrom ? ` · unplayable from ${dayClock(x.effectiveFrom)}` : ''}</p>
        ${d.closures.length ? html`<p class="small row row-wrap" data-gap="6">${icon('lock', 16, 2.2)}<span>Closed for new bookings: ${d.closures.map((c) => `${c.dateLabel} ${c.timeLabel}`).filter((v, i, a) => a.indexOf(v) === i).join(', ')}${d.closures.length > 1 ? ` on ${d.closures.length} courts and tables` : ''} ·</span><a href="${BASE}/availability">See Availability</a></p>` : ''}
      </section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Bookings</h2></div>
        ${d.items.length ? html`<div class="panel-body"><ul class="dz-list">${d.items.map(itemCard)}</ul></div>` : html`<p class="panel-body small">No bookings were affected.</p>`}
      </section>`);
  }

  on(root, 'click', '[data-apply]', async (_e, btn) => {
    setBusy(btn, true, 'Applying…');
    try {
      const res = await api.post(`${API}/disruptions/${encodeURIComponent(id)}/items/${encodeURIComponent(btn.dataset.apply)}/apply`, {});
      const r = res.result;
      toast(r.outcome === 'skipped' ? 'Nothing to credit' : 'Done', {
        sub: r.outcome === 'skipped' ? 'The booking ended without a verified payment.' : r.credit ? 'The player got booking credit.' : 'The booking was handled.',
      });
      refreshBadges();
      load();
    } catch (err) {
      setBusy(btn, false);
      toast(err.message, { type: err.code === 'VERIFY_FIRST' ? 'info' : 'error' });
      if (err.code === 'ITEM_RESOLVED') load();
    }
  });
  load();
}
