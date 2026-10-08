import { api } from '../core/api.js';
import { createViewTools } from '../core/view.js';
import { html, on, setBusy } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { openModal, skeletonRows, statusPill, toast } from '../core/ui.js';
import { API, BASE } from './console.js';
import { state } from './shell.js';

const viewTools = createViewTools({ api, on, setBusy, openModal, toast });

/**
 * "Cancel & credit" (REBOOKING.md §11): what happened → a preview of what the server will do to
 * each affected booking → confirm. One Idempotency-Key per preview, so a double click or a retry
 * after a dropped connection can never apply it twice. The server computes every amount; this
 * dialog only shows them.
 */

export const CATEGORY_OPTIONS = [
  { id: 'weather', label: 'Weather' },
  { id: 'unsafe_conditions', label: 'Unsafe conditions' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'equipment_failure', label: 'Equipment failure' },
  { id: 'emergency', label: 'Emergency' },
  { id: 'facility_error', label: 'Facility error' },
  { id: 'other', label: 'Other' },
  { id: 'customer_request', label: 'Customer request', admin: true },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORY_OPTIONS.map((c) => [c.id, c.label]));
/** Categories where the affected times should also stop new bookings, by default. */
const CLOSES_SLOTS = new Set(['weather', 'unsafe_conditions', 'maintenance', 'equipment_failure', 'emergency']);
const TZ_OFFSET = '+08:00'; // facility time (Asia/Manila, no daylight saving)

export function newIdempotencyKey() {
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `dz-${id}`;
}

/** "2026-10-03T17:20" in facility time, for a datetime-local input. */
function facilityInputValue(ms) {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 16);
}

const ACTION_TEXT = { cancel: 'Cancel', keep: 'Keep · credit the lost part', defer: 'Waits for payment check' };
const FLAG_TONE = { verify_first: 'violet', in_progress: 'amber', finished: 'amber', hold: 'neutral', free: 'neutral', staff_booking: 'neutral', no_compensation: 'red', credit_returned: 'blue' };

function itemRow(i) {
  const creditText = i.action === 'defer' ? (i.projectedCredit ? `${i.projectedCreditLabel} once verified` : '—') : i.credit ? i.creditLabel : 'No credit';
  return html`<li class="dz-item">
    <div class="dz-main">
      <div class="row row-wrap" data-gap="8"><a class="mono" href="${BASE}/bookings/${i.bookingId}" target="_blank" rel="noopener">${i.ref}</a><span class="strong">${i.userName}</span>${statusPill(i.status, { small: true })}</div>
      <p class="small">${i.resourceName} · ${i.dateLabel} · ${i.timeLabel}</p>
      ${i.affectedLabel !== i.timeLabel ? html`<p class="small">Affected: <b>${i.affectedLabel}</b></p>` : ''}
      <p class="small">${i.paidValue ? `Paid ${i.paidLabel}` : 'Nothing paid'}</p>
      ${i.flags.length ? html`<div class="row row-wrap" data-gap="6">${i.flags.map((f) => html`<span class="pill sm ${FLAG_TONE[f.key] || 'neutral'}">${f.label}</span>`)}</div>` : ''}
    </div>
    <div class="dz-side">
      ${i.canChoose
        ? html`<div class="seg sm" role="group" aria-label="What to do with ${i.ref}">
            <button type="button" data-choose="${i.bookingId}" data-action="cancel" aria-pressed="${String(i.action === 'cancel')}">Cancel all</button>
            <button type="button" data-choose="${i.bookingId}" data-action="keep" aria-pressed="${String(i.action === 'keep')}">Keep the rest</button></div>`
        : html`<span class="small strong">${ACTION_TEXT[i.action]}</span>`}
      <span class="mono strong ${i.credit ? 'blue-text' : ''}">${creditText}</span>
    </div>
  </li>`;
}

/**
 * Opens the dialog.
 *   scope      { kind: 'bookings', bookingIds } or { kind: 'window', date, start, end, activity, resourceId }
 *   form       show the "what happened" step first (individual bookings); false when the page
 *              already asked (the Disruptions form)
 *   defaults   { category, reason, staffNote }
 *   showFrom   ask when the booking stopped being playable (it has started or finished)
 *   onDone(detail)  after a successful confirmation, when the dialog closes
 *   onFinish(detail|null)  whenever the dialog closes (null when nothing was applied)
 */
export function openDisruptionDialog({ title, intro = '', scope, form = true, defaults = {}, showFrom = false, onDone, onFinish }) {
  const { api, on, setBusy, openModal, toast, scope: routeScope } = viewTools();
  const admin = state.user && state.user.role === 'admin';
  const s = {
    step: form ? 'form' : 'preview',
    category: defaults.category || (scope.kind === 'window' ? 'weather' : 'equipment_failure'),
    reason: defaults.reason || '',
    staffNote: defaults.staffNote || '',
    from: showFrom ? facilityInputValue(Date.now()) : '',
    fromTouched: false,
    closeSlots: defaults.closeSlots ?? (scope.kind === 'bookings' && CLOSES_SLOTS.has(defaults.category || 'equipment_failure')),
    noCredit: false,
    overrides: [],
    preview: null,
    previewError: null,
    changed: false,
    key: newIdempotencyKey(),
    result: null,
    busy: false,
    errors: {},
  };

  const request = () => {
    const sc = scope.kind === 'bookings'
      ? { ...scope, effectiveFrom: s.fromTouched && s.from ? Date.parse(`${s.from}:00${TZ_OFFSET}`) : null, closeSlots: s.closeSlots }
      : scope;
    return {
      scope: sc,
      category: s.category,
      reason: s.reason.trim(),
      staffNote: s.staffNote.trim() || null,
      compensation: s.noCredit ? 'none' : 'credit',
      overrides: s.overrides,
    };
  };

  const formStep = () => html`<h2 class="dialog-title">${title}</h2>
    ${intro ? html`<p class="body">${intro}</p>` : ''}
    <div class="field"><span class="label" id="dz-cat">What happened <span class="req">*</span></span>
      <div class="chip-row wrap" role="radiogroup" aria-labelledby="dz-cat">${CATEGORY_OPTIONS.filter((c) => !c.admin || admin).map((c) => html`<button type="button" class="chip" role="radio" aria-checked="${String(s.category === c.id)}" data-category="${c.id}">${c.label}</button>`)}</div></div>
    <div class="field"><label class="label" for="dz-reason">Reason players see <span class="req">*</span></label>
      <input class="input" id="dz-reason" data-field="reason" maxlength="120" value="${s.reason}" placeholder="e.g. Heavy rain, Court 2 net broke" autocomplete="off" ${s.errors.reason ? html`aria-invalid="true" aria-describedby="dz-reason-error"` : ''}>
      ${s.errors.reason ? html`<p class="field-error" id="dz-reason-error">${icon('alert', 16, 2.2)}${s.errors.reason}</p>` : ''}</div>
    <div class="field"><label class="label" for="dz-note">Internal note <span class="opt">(staff only)</span></label>
      <textarea class="textarea" id="dz-note" data-field="staffNote" maxlength="500" rows="2">${s.staffNote}</textarea></div>
    ${showFrom ? html`<div class="field"><label class="label" for="dz-from">Couldn't be played from</label>
      <input class="input" type="datetime-local" id="dz-from" data-field="from" value="${s.from}">
      <p class="help">Time already played isn't credited. Facility time.</p></div>` : ''}
    ${scope.kind === 'bookings' ? html`<label class="check-row"><input type="checkbox" data-toggle="closeSlots" ${s.closeSlots ? 'checked' : ''}><span class="check-box">${icon('check', 16, 3)}</span><span>Also close these times for new bookings</span></label>` : ''}
    ${admin ? html`<label class="check-row"><input type="checkbox" data-toggle="noCredit" ${s.noCredit ? 'checked' : ''}><span class="check-box">${icon('check', 16, 3)}</span><span>No booking credit <span class="small">(admin decision, e.g. a customer request made too late)</span></span></label>` : ''}
    <div class="dialog-actions"><button type="button" class="btn btn-primary btn-block" data-act="preview">Preview ${icon('arrow-right', 18, 2.4)}</button><button type="button" class="btn btn-secondary btn-block" data-close>Go back</button></div>`;

  const confirmLabel = (t) => {
    if (!t.bookings) return 'Close these times';
    const parts = [];
    if (t.cancel) parts.push(`Cancel ${t.cancel}`);
    if (t.keep) parts.push(`credit ${t.keep} in part`);
    if (t.defer) parts.push(`${t.defer} after payment check`);
    return `${parts.join(' · ')}${t.credit ? ` · ${t.creditLabel} credit` : ''}`;
  };

  const previewStep = () => {
    const p = s.preview;
    const nothing = p && !p.items.length && !p.closures.length;
    return html`<h2 class="dialog-title">${title}</h2>
      ${s.changed ? html`<p class="banner warn compact" role="alert">${icon('alert', 18, 2.2)}<span>Bookings changed since your preview. Check the list again, then confirm.</span></p>` : ''}
      ${s.previewError ? html`<p class="banner error compact" role="alert">${icon('alert', 18, 2.2)}<span>${s.previewError}</span></p>` : ''}
      ${!p ? (s.previewError ? '' : skeletonRows(3)) : html`
        <p class="body"><b>${p.scopeLabel}</b> · ${CATEGORY_LABEL[p.input.category] || p.input.category} · "${p.input.reason}"</p>
        <div class="dz-totals">
          <div><span class="eyebrow">Bookings</span><span class="num">${p.totals.bookings}</span></div>
          <div><span class="eyebrow">Credit now</span><span class="num mono">${p.totals.creditLabel}</span></div>
          ${p.totals.pending ? html`<div><span class="eyebrow">After payment check</span><span class="num mono">${p.totals.pendingLabel}</span></div>` : ''}
        </div>
        ${p.items.length ? html`<ul class="dz-list">${p.items.map(itemRow)}</ul>` : html`<p class="banner neutral compact">${icon('info', 18, 2.2)}<span>No bookings are affected.</span></p>`}
        ${p.closures.length ? html`<p class="small row" data-gap="8">${icon('lock', 16, 2.2)}New bookings blocked: ${p.closures.map((c) => `${c.dateLabel} ${c.timeLabel}`).filter((v, i, a) => a.indexOf(v) === i).join(', ')}${p.closures.length > 1 ? ` (${p.closures.length} courts/tables)` : ''}</p>` : ''}
        ${p.notAffected.length ? html`<details class="dz-not"><summary>${p.notAffected.length} booking${p.notAffected.length === 1 ? '' : 's'} not affected</summary>
          <ul>${p.notAffected.map((n) => html`<li><span class="mono">${n.ref}</span> ${n.userName} · ${n.label} · <b>${n.reasonLabel}</b></li>`)}</ul></details>` : ''}
        <p class="small">Players are told in the app, in each booking's chat and by email. A booking credit isn't a cash refund.</p>`}
      <div class="dialog-actions">
        <button type="button" class="btn btn-danger btn-block" data-act="confirm" ${!p || nothing ? 'disabled' : ''}>${p ? (nothing ? 'Nothing to change' : confirmLabel(p.totals)) : 'Confirm'}</button>
        ${form ? html`<button type="button" class="btn btn-secondary btn-block" data-act="edit">Back</button>` : html`<button type="button" class="btn btn-secondary btn-block" data-close>Go back</button>`}
      </div>`;
  };

  const resultStep = () => {
    const r = s.result;
    const items = r.items || [];
    const count = (o) => items.filter((i) => i.outcome === o).length;
    const open = items.filter((i) => i.open);
    return html`<span class="tile green">${icon('check', 24, 3)}</span>
      <h2 class="dialog-title">${r.replay ? 'Already done' : 'Done'}</h2>
      <p class="body">${[
        count('cancelled') ? `${count('cancelled')} cancelled` : '',
        count('partial') ? `${count('partial')} partly credited` : '',
        `${r.disruption.creditedLabel} credited`,
      ].filter(Boolean).join(' · ')}.${r.closures.length ? ' New bookings are blocked for those times.' : ''}</p>
      ${open.length ? html`<p class="banner warn compact">${icon('alert', 18, 2.2)}<span>${open.length} booking${open.length === 1 ? ' needs' : 's need'} you: ${open.map((i) => `${i.ref} (${i.outcome === 'deferred' ? 'verify the payment' : 'changed — review again'})`).join(', ')}</span></p>` : ''}
      <div class="dialog-actions"><a class="btn btn-secondary btn-block" href="${BASE}/disruptions/${r.disruption.id}" data-close-link>Open the record</a><button type="button" class="btn btn-primary btn-block" data-close>Done</button></div>`;
  };

  const m = openModal({
    wide: true,
    label: title,
    locked: () => s.busy,
    onClose: () => {
      const result = !routeScope || routeScope.isCurrent() ? s.result : null;
      if (result && onDone) onDone(result);
      if (onFinish) onFinish(result);
    },
    content: () => (s.step === 'form' ? formStep() : s.step === 'preview' ? previewStep() : resultStep()),
    onOpen: (panel, modal) => {
      on(panel, 'click', '[data-category]', (_e, btn) => {
        s.category = btn.dataset.category;
        if (scope.kind === 'bookings') s.closeSlots = CLOSES_SLOTS.has(s.category);
        modal.rerender();
      });
      on(panel, 'input', '[data-field]', (_e, el) => {
        s[el.dataset.field] = el.value;
        if (el.dataset.field === 'from') s.fromTouched = true;
      });
      on(panel, 'change', '[data-toggle]', (_e, el) => {
        s[el.dataset.toggle] = el.checked;
      });
      on(panel, 'click', '[data-act="preview"]', () => {
        if (s.reason.trim().length < 3) {
          s.errors = { reason: 'Give a short reason players will see.' };
          modal.rerender();
          panel.querySelector('#dz-reason')?.focus();
          return;
        }
        s.errors = {};
        s.step = 'preview';
        runPreview();
      });
      on(panel, 'click', '[data-act="edit"]', () => {
        s.step = 'form';
        s.preview = null;
        s.previewError = null;
        s.changed = false;
        modal.rerender();
      });
      on(panel, 'click', '[data-choose]', (_e, btn) => {
        const id = btn.dataset.choose;
        s.overrides = [...s.overrides.filter((o) => o.bookingId !== id), { bookingId: id, action: btn.dataset.action }];
        runPreview();
      });
      on(panel, 'click', '[data-act="confirm"]', (_e, btn) => confirm(btn));
      on(panel, 'click', '[data-close-link]', () => modal.close());
    },
  });

  async function runPreview() {
    s.preview = null;
    s.previewError = null;
    m.rerender();
    try {
      const res = await api.post(`${API}/disruptions/preview`, request(), { signal: m.signal });
      s.preview = res.preview;
      s.key = newIdempotencyKey(); // a new preview is a new change to confirm
    } catch (err) {
      if (err.name === 'AbortError') return;
      s.previewError = err.message;
    }
    m.rerender();
  }

  async function confirm(btn) {
    if (!s.preview) return;
    s.busy = true;
    setBusy(btn, true, 'Applying…');
    try {
      const res = await api.post(`${API}/disruptions`, { ...s.preview.input, previewToken: s.preview.previewToken }, { headers: { 'Idempotency-Key': s.key }, signal: m.signal });
      s.busy = false;
      s.result = res;
      s.step = 'result';
      m.rerender();
    } catch (err) {
      s.busy = false;
      if (err.code === 'DISRUPTION_CHANGED' && err.details && err.details.preview) {
        s.preview = err.details.preview;
        s.changed = true;
        s.key = newIdempotencyKey();
        m.rerender();
        return;
      }
      setBusy(btn, false);
      // A dropped connection may have applied it: the same key makes a retry safe.
      toast(err.message, { type: 'error', sub: err.code === 'NETWORK' ? 'Try again: it is never applied twice.' : '' });
    }
  }

  if (!form) runPreview();
  return m;
}
