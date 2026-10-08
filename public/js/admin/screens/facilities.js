import { createViewTools } from '../../core/view.js';
import { api } from '../../core/api.js';
import { listen, $, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { isoDate } from '../../core/format.js';
import { clearFieldErrors, errorState, openModal, showFieldErrors, skeletonRows, toast } from '../../core/ui.js';
import { frame } from '../shell.js';
import { API, BASE, isAdminConsole } from '../console.js';
import { disruptionAsPromise, followUpNote, withImpactCheck } from '../impact.js';
import { openDisruptionDialog } from '../disrupt.js';

const viewTools = createViewTools({ listen, api, on, render, setBusy, clearFieldErrors, openModal, showFieldErrors, toast, frame });

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'pickleball', label: 'Pickleball courts' },
  { key: 'table_tennis', label: 'Table tennis tables' },
];
const ACTIVITY = { pickleball: 'Pickleball', table_tennis: 'Table tennis' };
const ACTIVATE = { maintenance: 'End maintenance', open_play: 'End open play', disabled: 'Enable' };

function statusPill(r) {
  if (r.status === 'maintenance') return html`<span class="pill amber sm">${icon('wrench', 12, 2.4)}Maintenance</span>`;
  if (r.status === 'disabled') return html`<span class="pill neutral sm">${icon('minus-circle', 12, 2.4)}Disabled</span>`;
  if (r.status === 'open_play') return html`<span class="pill blue sm">${icon('users', 12, 2.4)}Open play</span>`;
  return html`<span class="pill green sm">${icon('check-circle', 12, 2.4)}Active</span>`;
}

function card(r) {
  const upcoming = r.upcomingBookings;
  return html`<article class="panel panel-body stack stack-12 res-card">
    <div class="row row-between" data-gap="8"><div><p class="eyebrow">${ACTIVITY[r.activity]}</p><h2 class="h3">${r.name}</h2></div>${statusPill(r)}</div>
    ${r.status === 'maintenance' ? html`<p class="small">${r.maintenanceNote || 'Under maintenance'}${r.maintenanceUntilLabel ? ` · back on ${r.maintenanceUntilLabel}` : ' · no back-on date'}</p>` : ''}
    ${r.status === 'disabled' ? html`<p class="small">Hidden from players. Past bookings are kept.</p>` : ''}
    ${r.status === 'open_play' ? html`<p class="small">Free for all. Players see it marked OPEN PLAY and can't book it.</p>` : ''}
    <p class="small">${upcoming ? `${upcoming} upcoming booking${upcoming === 1 ? '' : 's'}` : 'No upcoming bookings'} · ${r.priceMemberLabel} member · ${r.priceNonMemberLabel} non-member</p>
    <div class="row row-wrap" data-gap="8">
      <button type="button" class="btn btn-secondary btn-xs" data-edit="${r.id}">${icon('edit', 16)}Edit</button>
      ${r.status === 'active' ? html`<button type="button" class="btn btn-secondary btn-xs" data-open-play="${r.id}">${icon('users', 16)}Open play</button>
        <button type="button" class="btn btn-secondary btn-xs" data-maint="${r.id}">${icon('wrench', 16)}Maintenance</button>` : html`<button type="button" class="btn btn-secondary btn-xs" data-activate="${r.id}">${icon('check-circle', 16)}${ACTIVATE[r.status] || 'Enable'}</button>`}
      ${r.status !== 'disabled' ? html`<button type="button" class="btn btn-text btn-xs danger-text" data-disable="${r.id}">Disable</button>` : ''}
    </div>
  </article>`;
}

/**
 * PATCH with the affected-bookings check. Returns true when the change was applied. Staff may
 * first cancel the affected bookings with a booking credit (maintenance, disabling, open play).
 */
async function patch(r, body, done) {
  const { api, toast } = viewTools();
  const res = await withImpactCheck((confirmAffected) => api.patch(`${API}/facilities/${encodeURIComponent(r.id)}`, { ...body, confirmAffected }), {
    disrupt: (affected) => disruptionAsPromise((finish) => openDisruptionDialog({
      title: `Cancel & credit · ${r.name}`,
      intro: `After this, the change to ${r.name} is saved.`,
      scope: { kind: 'bookings', bookingIds: affected.map((b) => b.id) },
      defaults: { category: 'maintenance', reason: body.maintenanceNote ? `${r.name}: ${body.maintenanceNote}` : `${r.name} is out of service`, closeSlots: false },
      onFinish: finish,
    })).then((x) => (x ? { done: false } : null)),
  });
  if (!res) return false;
  toast(done, { sub: followUpNote(res) || 'Players see the change right away.' });
  return true;
}

const ADDED_NOTE = {
  active: 'Players can book it now.',
  open_play: "Players see it as open play. It can't be booked.",
  disabled: 'It stays hidden until you enable it.',
};

function editDialog(r, onSaved, { initialStatus } = {}) {
  const { listen, openModal, clearFieldErrors, showFieldErrors, setBusy, api, toast } = viewTools();
  let busy = false;
  const tomorrow = isoDate(Date.now() + 86_400_000);
  const m = openModal({
    label: r ? `Edit ${r.name}` : 'Add a court or table',
    locked: () => busy,
    content: () => html`<div class="sheet-head"><h2 class="h3">${r ? `Edit ${r.name}` : 'Add a court or table'}</h2><button type="button" class="icon-btn sm flat" data-close aria-label="Close">${icon('x', 18, 2.2)}</button></div>
      <form class="stack stack-16" novalidate data-form>
        ${r ? '' : html`<div class="field"><label class="label" for="r-activity">Type</label><select class="select" id="r-activity" name="activity"><option value="pickleball">Pickleball court</option><option value="table_tennis">Table tennis table</option></select></div>`}
        <div class="field"><label class="label" for="r-name">Name</label><input class="input" id="r-name" name="name" value="${r ? r.name : ''}" maxlength="40" placeholder="e.g. Court 4" autofocus></div>
        <div class="field"><label class="label" for="r-status">Status</label><select class="select" id="r-status" name="status">
          <option value="active">Active · players can book</option>
          <option value="open_play">Open play · free for all, shown but not bookable</option>
          ${r ? html`<option value="maintenance">Maintenance · not bookable until the back-on date</option>` : ''}
          <option value="disabled">Disabled · hidden from players</option></select></div>
        <div class="stack stack-16" data-maint-fields hidden>
          <div class="field"><label class="label" for="r-note">Reason players see</label><input class="input" id="r-note" name="maintenanceNote" value="${r?.maintenanceNote || ''}" maxlength="120" placeholder="e.g. Resurfacing"></div>
          <div class="field"><label class="label" for="r-until">Back on</label><input class="input" id="r-until" name="maintenanceUntil" type="date" min="${tomorrow}" value="${r?.maintenanceUntil || ''}"><p class="help">Leave empty to keep it in maintenance until you end it.</p></div>
        </div>
        ${!r && isAdminConsole ? html`<div class="grid-2"><div class="field"><label class="label" for="r-pm">Member price</label><div class="input-group"><span class="prefix">₱</span><input class="input mono" id="r-pm" name="priceMember" inputmode="decimal" placeholder="Same as others"></div></div>
          <div class="field"><label class="label" for="r-pn">Non-member price</label><div class="input-group"><span class="prefix">₱</span><input class="input mono" id="r-pn" name="priceNonMember" inputmode="decimal" placeholder="Same as others"></div></div></div>` : ''}
        ${!r && !isAdminConsole ? html`<p class="small">Prices copy from the other courts or tables of this type. An administrator can change them in Settings.</p>` : ''}
        ${r ? html`<p class="small">Taking it out of service or making it open play never cancels bookings. You'll see any that are affected before the change is saved.</p>` : ''}
        <button type="submit" class="btn btn-primary btn-lg btn-block">${r ? 'Save changes' : 'Add'}</button>
      </form>`,
    onOpen: (panel) => {
      const form = $('[data-form]', panel);
      const f = (n) => form.elements.namedItem(n);
      const maint = $('[data-maint-fields]', panel);
      f('status').value = initialStatus ?? (r ? r.status : 'active');
      const sync = () => (maint.hidden = f('status').value !== 'maintenance');
      listen(f('status'), 'change', sync);
      sync();
      listen(form, 'submit', async (e) => {
        e.preventDefault();
        clearFieldErrors(form);
        const name = f('name').value.trim();
        const status = f('status').value;
        const body = {};
        if (!r || name !== r.name) body.name = name;
        if (!r || status !== r.status) body.status = status;
        if (status === 'maintenance') {
          const note = f('maintenanceNote').value.trim() || null;
          const until = f('maintenanceUntil').value || null;
          // An explicit status transition includes its maintenance settings.
          // A rename or note-only edit must preserve another operator's fields.
          if (!r || body.status !== undefined || note !== r.maintenanceNote) body.maintenanceNote = note;
          if (!r || body.status !== undefined || until !== r.maintenanceUntil) body.maintenanceUntil = until;
        }
        if (name.length < 2) return showFieldErrors(form, { name: ['Use at least 2 characters.'] });
        if (r && !Object.keys(body).length) return toast('Nothing changed', { type: 'info' });
        if (!r) {
          body.activity = f('activity').value;
          for (const k of ['priceMember', 'priceNonMember']) {
            const raw = f(k)?.value.replace(/[₱,\s]/g, '');
            if (!raw) continue;
            if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) return showFieldErrors(form, { [k]: ['Enter a price like 500'] });
            body[k] = Math.round(Number(raw) * 100);
          }
          if ((body.priceMember === undefined) !== (body.priceNonMember === undefined)) {
            return showFieldErrors(form, { priceNonMember: ['Enter both prices, or neither to copy them.'] });
          }
        }
        const btn = form.querySelector('[type="submit"]');
        busy = true;
        setBusy(btn, true, 'Saving…');
        try {
          if (r) {
            if (!(await patch(r, body, `${name} saved`))) {
              busy = false;
              setBusy(btn, false);
              return;
            }
          } else {
            await api.post(`${API}/facilities`, body);
            toast(`${body.name} added`, { sub: ADDED_NOTE[body.status] });
          }
          busy = false;
          m.close();
          onSaved();
        } catch (err) {
          busy = false;
          setBusy(btn, false);
          if (!showFieldErrors(form, err.details)) toast(err.message, { type: 'error' });
        }
      });
    },
  });
}

export async function facilitiesView({ query }) {
  const { listen, frame, render, api, on, setBusy, toast } = viewTools();
  let tab = TABS.some((t) => t.key === query.get('type')) ? query.get('type') : 'all';
  let resources = [];
  const main = frame({
    key: 'facilities',
    eyebrow: 'Facility',
    title: 'Resources',
    actions: html`<button type="button" class="btn btn-primary btn-sm" data-act="add">${icon('plus', 18)}Add court or table</button>`,
    template: html`<div class="page" data-page>
      <div class="row row-between" data-gap="8"><div class="chip-row" role="group" aria-label="Show" data-tabs></div><button type="button" class="btn btn-primary btn-sm only-mobile" data-act="add">${icon('plus', 18)}Add</button></div>
      <div data-list>${skeletonRows(3, 'sk-card')}</div>
      <p class="small">${isAdminConsole ? html`Prices are edited in <a href="/admin/settings#pricing">Settings → Pricing</a>.` : 'Prices are set by an administrator.'} Weekly hours and closed dates are under <a href="${BASE}/availability">Availability</a>.</p>
    </div>`,
  });
  // Listeners go on this render's own page element (main and the top bar outlive the view).
  const root = $('[data-page]', main);
  const list = $('[data-list]', root);
  const byId = (id) => resources.find((r) => r.id === id);

  function paint() {
    render($('[data-tabs]', root), TABS.map((t) => html`<button type="button" class="chip" data-tab="${t.key}" aria-pressed="${String(tab === t.key)}">${t.label}</button>`));
    const items = resources.filter((r) => tab === 'all' || r.activity === tab);
    render(list, items.length
      ? html`<div class="res-grid">${items.map(card)}</div>`
      : html`<div class="empty"><span class="tile blue lg">${icon('layers', 26)}</span><p class="empty-title">No courts or tables yet</p><p class="empty-body">Add one so players can start booking.</p></div>`);
  }

  async function load() {
    try {
      resources = (await api.get(`${API}/facilities`)).resources;
      paint();
    } catch (err) {
      render(list, errorState(err));
      listen($('[data-act="retry"]', list), 'click', load);
    }
  }

  on(root, 'click', '[data-tab]', (_e, btn) => {
    tab = btn.dataset.tab;
    history.replaceState(history.state, '', tab === 'all' ? `${BASE}/facilities` : `${BASE}/facilities?type=${tab}`);
    paint();
  });
  const offTopbar = on(document.getElementById('topbar'), 'click', '[data-act="add"]', () => editDialog(null, load));
  on(root, 'click', '[data-act="add"]', () => editDialog(null, load));
  on(root, 'click', '[data-edit]', (_e, btn) => editDialog(byId(btn.dataset.edit), load));

  async function quick(btn, r, body, done) {
    setBusy(btn, true, 'Saving…');
    try {
      if (await patch(r, body, done)) await load();
      else setBusy(btn, false);
    } catch (err) {
      setBusy(btn, false);
      toast(err.message, { type: 'error' });
    }
  }
  on(root, 'click', '[data-maint]', (_e, btn) => editDialog(byId(btn.dataset.maint), load, { initialStatus: 'maintenance' }));
  on(root, 'click', '[data-activate]', (_e, btn) => {
    const r = byId(btn.dataset.activate);
    quick(btn, r, { status: 'active' }, `${r.name} is bookable again`);
  });
  on(root, 'click', '[data-open-play]', (_e, btn) => {
    const r = byId(btn.dataset.openPlay);
    quick(btn, r, { status: 'open_play' }, `${r.name} is open play`);
  });
  on(root, 'click', '[data-disable]', (_e, btn) => {
    const r = byId(btn.dataset.disable);
    quick(btn, r, { status: 'disabled' }, `${r.name} disabled`);
  });
  load();
  return offTopbar;
}
