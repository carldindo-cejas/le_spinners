import { api } from '../../core/api.js';
import { $, $$, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { dayClock, relTime } from '../../core/format.js';
import { clearFieldErrors, errorState, showFieldErrors, skeletonRows, toast } from '../../core/ui.js';
import { frame, state } from '../shell.js';

const SECTIONS = [
  { id: 'rules', label: 'Booking rules' },
  { id: 'gcash', label: 'GCash payments' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'alerts', label: 'Admin alerts' },
  { id: 'facility', label: 'Facility info' },
  { id: 'outbox', label: 'Sent & queued' },
];

const pesos = (c) => (c / 100).toFixed(c % 100 ? 2 : 0);

function toCentavos(v) {
  const clean = String(v).replace(/[₱,\s]/g, '');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(clean)) return NaN;
  const [w, f = ''] = clean.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

export async function settingsView() {
  const root = frame({
    key: 'settings',
    eyebrow: 'Admin',
    title: 'Settings',
    template: html`<div class="page" data-body>${skeletonRows(5, 'sk-card')}</div>`,
  });
  const body = $('[data-body]', root);
  let d;
  let outbox = [];
  try {
    [d, { items: outbox }] = await Promise.all([api.get('/api/admin/settings'), api.get('/api/admin/outbox')]);
  } catch (err) {
    render(body, errorState(err));
    $('[data-act="retry"]', body)?.addEventListener('click', settingsView);
    return undefined;
  }
  state.settings = d.settings;
  const s = d.settings;
  const ro = !d.canEdit;
  const dis = ro ? 'disabled' : '';

  function field(name, label, value, { help = '', type = 'text', unit = '', mono = false, min, max, inputmode } = {}) {
    return html`<div class="field"><label class="label" for="st-${name}">${label}</label>
      ${unit ? html`<div class="unit-input"><input class="input${mono ? ' mono' : ''}" id="st-${name}" name="${name}" type="${type}" value="${value}" ${min != null ? html`min="${min}"` : ''} ${max != null ? html`max="${max}"` : ''} ${inputmode ? html`inputmode="${inputmode}"` : ''} ${dis}><span class="small">${unit}</span></div>`
        : html`<input class="input${mono ? ' mono' : ''}" id="st-${name}" name="${name}" type="${type}" value="${value}" ${dis}>`}
      ${help ? html`<p class="help">${help}</p>` : ''}</div>`;
  }

  render(body, html`${ro ? html`<p class="banner info">${icon('lock', 20, 2.2)}<span><b>Only administrators can change settings.</b> You can see them here.</span></p>` : ''}
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections">${SECTIONS.map((x) => html`<a href="#${x.id}" data-native>${x.label}</a>`)}</nav>
    <form class="stack stack-20" novalidate data-form>
      <section class="panel panel-body stack stack-16 set-card" id="rules"><div><h2 class="h3">Booking rules</h2><p class="small">These drive the countdown, expiry and cancellation behavior players see.</p></div>
        <div class="grid-2 grid-2-stack">
          ${field('holdMinutes', 'Payment window', s.holdMinutes, { type: 'number', unit: 'minutes', min: 5, max: 30, help: 'Temporary hold before it expires' })}
          ${field('resubmitMinutes', 'Resubmit window after rejection', s.resubmitMinutes, { type: 'number', unit: 'minutes', min: 5, max: 60, help: 'Slot stays held for corrected proof' })}
          ${field('bookingWindowDays', 'Bookings open', s.bookingWindowDays, { type: 'number', unit: 'days ahead', min: 1, max: 60 })}
          ${field('cancelCutoffHours', 'Players can cancel until', s.cancelCutoffHours, { type: 'number', unit: 'hours before', min: 0, max: 168 })}
        </div>
        <p class="small">"Expiring soon" warning at ${s.warnMinutes} minutes left · slot length ${s.slotMinutes} minutes.</p>
      </section>

      <section class="panel panel-body stack stack-16 set-card" id="gcash"><div><h2 class="h3">GCash payments</h2><p class="small">Exactly what players see on the payment screen.</p></div>
        <div class="cols c-160-1">
          <div class="stack stack-16">
            ${field('gcashName', 'Account name', s.gcashName)}
            ${field('gcashNumber', 'GCash number', s.gcashNumber, { mono: true, inputmode: 'tel', help: 'Like 0917 123 4567' })}
          </div>
          <div class="stack stack-8"><span class="label">QR code image</span>
            <div data-qr>${s.hasQr ? html`<img class="qr-preview" src="${s.qrUrl}?v=${Date.now()}" alt="Current GCash QR code">` : html`<div class="qr-preview"><span class="small center">No QR yet</span></div>`}</div>
            ${ro ? '' : html`<div class="row row-wrap" data-gap="8"><label class="btn btn-secondary btn-xs" for="qr-file">${icon('upload', 16)}${s.hasQr ? 'Replace image' : 'Upload image'}</label>${s.hasQr ? html`<button type="button" class="btn btn-text btn-xs danger-text" data-act="qr-remove">Remove</button>` : ''}</div>
              <input class="sr-only" id="qr-file" type="file" accept="image/png,image/jpeg,image/webp" data-qr-file>`}
          </div>
        </div>
      </section>

      <section class="panel panel-body stack stack-16 set-card" id="pricing"><div><h2 class="h3">Pricing <span class="small">per hour</span></h2><p class="small">New prices apply to bookings made after you save.</p></div>
        <div class="table-wrap"><table class="grid price-table"><thead><tr><th>Court / table</th><th>Member</th><th>Non-member</th></tr></thead><tbody>
          ${d.resources.map((r) => html`<tr><td><span class="strong">${r.name}</span><span class="sub">${r.activity === 'table_tennis' ? 'Table tennis' : 'Pickleball'}${r.status === 'maintenance' ? ` · maintenance${r.maintenanceUntilLabel ? ` until ${r.maintenanceUntilLabel}` : ''}` : r.status === 'disabled' ? ' · disabled' : ''}</span></td>
            <td><div class="input-group"><span class="prefix">₱</span><input class="input mono" name="pm-${r.id}" value="${pesos(r.priceMember)}" inputmode="decimal" aria-label="${r.name} member price" data-price="${r.id}" data-kind="priceMember" data-orig="${r.priceMember}" ${dis}></div></td>
            <td><div class="input-group"><span class="prefix">₱</span><input class="input mono" name="pn-${r.id}" value="${pesos(r.priceNonMember)}" inputmode="decimal" aria-label="${r.name} non-member price" data-price="${r.id}" data-kind="priceNonMember" data-orig="${r.priceNonMember}" ${dis}></div></td></tr>`)}
        </tbody></table></div>
      </section>

      <section class="panel panel-body stack stack-16 set-card" id="alerts"><div><h2 class="h3">Admin alerts</h2><p class="small">Where "Payment proof submitted" and other events reach staff.</p></div>
        <div class="channel"><span class="tile sm blue">${icon('bell', 18)}</span><span><b>In-app</b><br><span class="small">Toasts, bell and sidebar badges for every event.</span></span><span class="pill green sm">Always on</span></div>
        <div class="field"><label class="label" for="st-emails">Email — send to</label><input class="input" id="st-emails" name="staffAlertEmails" value="${s.staffAlertEmails.join(', ')}" placeholder="ana@example.com, desk@example.com" ${dis}>
          <p class="help">Up to 5, separated by commas. ${d.delivery.email === 'resend' ? 'Email is sending through Resend.' : 'Emails are queued until RESEND_API_KEY and EMAIL_FROM are set (see README).'}</p></div>
        <div class="field"><label class="label" for="st-sms">SMS — admin mobile numbers <span class="pill amber sm">Not connected</span></label><input class="input" id="st-sms" name="staffAlertSms" value="${s.staffAlertSms.join(', ')}" placeholder="+63 917 555 0100" ${dis}>
          <p class="help">Texts are written to the outbox as "queued" and will send once an SMS provider is connected.</p></div>
      </section>

      <section class="panel panel-body stack stack-16 set-card" id="facility"><h2 class="h3">Facility info</h2>
        ${field('facilityName', 'Facility name', s.facilityName)}
        ${field('facilityAddress', 'Address', s.facilityAddress, { help: 'Shown on the player home screen with a Directions link.' })}
        <div class="field"><span class="label">Time zone</span><p class="body">Asia/Manila (UTC+8)</p></div>
      </section>

      <section class="panel panel-body stack stack-12 set-card" id="outbox"><div><h2 class="h3">Sent &amp; queued</h2><p class="small">The latest email and SMS alerts.</p></div>
        ${outbox.length ? html`<div class="table-wrap"><table class="grid"><thead><tr><th>Channel</th><th>To</th><th>Subject</th><th>Status</th><th>When</th></tr></thead><tbody>
          ${outbox.slice(0, 15).map((o) => html`<tr><td>${o.channel === 'sms' ? 'SMS' : 'Email'}</td><td class="ellipsis">${o.recipient}</td><td>${o.subject || '—'}</td><td><span class="pill sm ${o.status === 'sent' ? 'green' : o.status === 'failed' ? 'red' : 'amber'}">${o.status}</span></td><td><span title="${dayClock(o.createdAt)}">${relTime(o.createdAt)}</span></td></tr>`)}
        </tbody></table></div>` : html`<p class="small">Nothing yet.</p>`}
      </section>

      ${ro ? '' : html`<div class="save-bar"><p>Changes are logged with your name.</p><button type="button" class="btn btn-secondary btn-sm" data-act="discard">Discard</button><button type="submit" class="btn btn-primary btn-sm" data-act="save">Save settings</button></div>`}
    </form>
  </div>`);

  const form = $('[data-form]', body);
  if (ro) return undefined;
  const val = (n) => form.elements.namedItem(n).value.trim();

  on(body, 'click', '[data-act="discard"]', () => settingsView());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    const payload = {};
    const num = (n) => Number(val(n));
    for (const n of ['holdMinutes', 'resubmitMinutes', 'bookingWindowDays', 'cancelCutoffHours']) if (num(n) !== s[n]) payload[n] = num(n);
    for (const n of ['gcashName', 'gcashNumber', 'facilityName', 'facilityAddress']) if (val(n) !== s[n]) payload[n] = val(n);
    const list = (n) => val(n).split(',').map((x) => x.trim()).filter(Boolean);
    if (list('staffAlertEmails').join(',') !== s.staffAlertEmails.join(',')) payload.staffAlertEmails = list('staffAlertEmails');
    if (list('staffAlertSms').join(',') !== s.staffAlertSms.join(',')) payload.staffAlertSms = list('staffAlertSms');
    const priceChanges = new Map();
    const priceErrors = {};
    for (const input of $$('[data-price]', form)) {
      const c = toCentavos(input.value);
      if (Number.isNaN(c)) {
        priceErrors[input.name] = ['Enter a price like 500'];
        continue;
      }
      if (c !== Number(input.dataset.orig)) {
        const entry = priceChanges.get(input.dataset.price) || {};
        entry[input.dataset.kind] = c;
        priceChanges.set(input.dataset.price, entry);
      }
    }
    if (Object.keys(priceErrors).length) return showFieldErrors(form, priceErrors);
    if (!Object.keys(payload).length && !priceChanges.size) {
      toast('Nothing changed', { type: 'info' });
      return;
    }
    const btn = $('[data-act="save"]', form);
    setBusy(btn, true, 'Saving…');
    try {
      if (Object.keys(payload).length) await api.put('/api/admin/settings', payload);
      for (const [id, body2] of priceChanges) await api.patch(`/api/admin/resources/${encodeURIComponent(id)}`, body2);
      toast('Settings saved', { sub: 'Players see the changes right away.' });
      state.settings = null;
      settingsView();
    } catch (err) {
      setBusy(btn, false);
      const mapped = {};
      if (err.details) {
        for (const [k, v] of Object.entries(err.details)) mapped[k.split('.')[0]] = v;
      }
      if (!showFieldErrors(form, mapped)) toast(err.message, { type: 'error' });
    }
  });

  const qrInput = $('[data-qr-file]', body);
  qrInput?.addEventListener('change', async () => {
    const file = qrInput.files && qrInput.files[0];
    qrInput.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      await api.upload('/api/admin/settings/gcash-qr', fd, { method: 'PUT' });
      toast('GCash QR updated', { sub: 'Players see the new QR on the payment screen.' });
      settingsView();
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  });
  on(body, 'click', '[data-act="qr-remove"]', async () => {
    try {
      await api.delete('/api/admin/settings/gcash-qr');
      toast('QR removed', { sub: 'Players pay using the GCash number.' });
      settingsView();
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  });
  return undefined;
}

