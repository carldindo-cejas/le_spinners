import { historyPager } from '../../core/history.js';
import { createViewTools } from '../../core/view.js';
import { api } from '../../core/api.js';
import { listen, $, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { dayClock, relTime } from '../../core/format.js';
import { errorState, openModal, skeletonRows, toast } from '../../core/ui.js';
import { frame, state } from '../shell.js';
import { API, BASE, isAdminConsole } from '../console.js';
import { newIdempotencyKey } from '../disrupt.js';

const viewTools = createViewTools({ listen, api, on, render, setBusy, openModal, toast, frame });

/**
 * Booking credits (REBOOKING.md §11): what players can spend, where each credit came from and
 * every change to it. Staff look things up; admins can void a credit or record a cash refund
 * that staff paid outside the app (it spends the credit, so value is never paid out twice).
 */

const STATE_TONE = { available: 'volt', partly_used: 'blue', used: 'neutral', refunded: 'neutral', expired: 'neutral', voided: 'red' };

function row(c) {
  return html`<a class="list-row" href="${BASE}/credits/${c.id}">
    <span class="row-tile">${icon('gift', 20)}</span>
    <span class="grow"><span class="row-title">${c.user.name} · <span class="mono">${c.spendable ? c.remainingLabel : c.amountLabel}</span>${c.spendable && c.remaining < c.amount ? html` <span class="small">of ${c.amountLabel}</span>` : ''}</span><br>
      <span class="row-meta">${c.source && c.source.ref ? `${c.source.ref} · ` : c.origin === 'manual' ? 'Issued by hand · ' : ''}${c.reason} · ${relTime(c.issuedAt)}</span></span>
    <span class="pill sm ${STATE_TONE[c.state] || 'neutral'}">${c.stateLabel}</span>
  </a>`;
}

export function creditsView({ query }) {
  const { listen, frame, render, api, on } = viewTools();
  let q = query.get('q') || '';
  let only = query.get('state') === 'spendable' ? 'spendable' : 'all';
  const main = frame({
    key: 'credits',
    eyebrow: 'Operations',
    title: 'Booking credits',
    template: html`<div class="page" data-page>
      <form class="row row-wrap" data-gap="8" role="search" data-search>
        <input class="input grow" type="search" name="q" value="${q}" placeholder="Player, email or booking reference" aria-label="Search credits" maxlength="80">
        <button type="submit" class="btn btn-secondary btn-md">${icon('search', 18)}Search</button>
      </form>
      <div class="chip-row" role="group" aria-label="Show" data-chips></div>
      <div class="panel menu" data-list>${skeletonRows(4)}</div>
      <p class="small">Credits are issued when Le Spinners cancels or cuts short a paid booking (see <a href="${BASE}/disruptions">Disruptions</a>)${isAdminConsole ? ', or by an admin from a booking page' : ''}. Players spend them automatically when they book.</p>
    </div>`,
  });
  const root = $('[data-page]', main);
  const list = $('[data-list]', root);
  const pages = historyPager(api, list.parentElement, load);

  async function load() {
    render($('[data-chips]', root), [['all', 'All'], ['spendable', 'Can be spent']].map(([k, label]) => html`<button type="button" class="chip" data-state="${k}" aria-pressed="${String(only === k)}">${label}</button>`));
    try {
      const d = await pages.get(`${API}/credits?state=${only}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      render(list, d.credits.length ? d.credits.map(row) : html`<p class="panel-body small">${q ? `No credits match "${q}".` : 'No booking credits yet.'}</p>`);
    } catch (err) {
      render(list, errorState(err));
      listen($('[data-act="retry"]', list), 'click', load);
    }
  }
  const sync = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (only !== 'all') params.set('state', only);
    history.replaceState(history.state, '', `${BASE}/credits${params.size ? `?${params}` : ''}`);
  };
  on(root, 'submit', '[data-search]', (e, form) => {
    e.preventDefault();
    q = form.elements.namedItem('q').value.trim();
    sync();
    load();
  });
  on(root, 'click', '[data-state]', (_e, btn) => {
    only = btn.dataset.state;
    sync();
    load();
  });
  load();
}

function actionDialog({ title, intro, fields, submitLabel, danger = false, send, onDone }) {
  const { listen, openModal, setBusy, toast } = viewTools();
  let busy = false;
  const m = openModal({
    label: title,
    locked: () => busy,
    content: () => html`<h2 class="dialog-title">${title}</h2><p class="body">${intro}</p>${fields}
      <div class="dialog-actions"><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block" data-act="go">${submitLabel}</button><button type="button" class="btn btn-secondary btn-block" data-close>Go back</button></div>`,
    onOpen: (panel) => {
      listen(panel.querySelector('[data-act="go"]'), 'click', async (e) => {
        if (busy) return;
        const btn = e.currentTarget;
        busy = true;
        setBusy(btn, true, 'Saving…');
        try {
          await send(panel);
          busy = false;
          m.close();
          onDone();
        } catch (err) {
          busy = false;
          setBusy(btn, false);
          const detail = err.details && Object.values(err.details)[0];
          toast(Array.isArray(detail) ? detail[0] : err.message, { type: 'error' });
        }
      });
    },
  });
}

export async function creditDetailView({ params }) {
  const { listen, frame, api, render, on, toast } = viewTools();
  const id = params.id;
  const main = frame({
    key: 'credits',
    eyebrow: 'Booking credits',
    title: 'Booking credit',
    tabs: false,
    template: html`<div class="page" data-page>${skeletonRows(4, 'sk-card')}</div>`,
  });
  const root = $('[data-page]', main);
  const admin = isAdminConsole && state.user.role === 'admin';
  let d = null;

  async function load() {
    try {
      d = await api.get(`${API}/credits/${encodeURIComponent(id)}`);
    } catch (err) {
      render(root, errorState(err, { retry: err.status !== 404, title: err.status === 404 ? 'Credit not found' : undefined }));
      listen($('[data-act="retry"]', root), 'click', load);
      return;
    }
    const c = d.credit;
    render(root, html`<div class="row" data-gap="12"><a class="icon-btn" href="${BASE}/credits" data-back aria-label="Back to credits">${icon('chevron-left', 22, 2.2)}</a>
        <span class="pill ${STATE_TONE[c.state] || 'neutral'}">${c.stateLabel}</span></div>
      <div class="cols c-155">
        <section class="panel panel-body stack stack-12">
          <p class="eyebrow">${c.spendable ? 'Left to spend' : 'Booking credit'}</p>
          <p class="h1 mono">${c.spendable ? c.remainingLabel : c.amountLabel}</p>
          ${c.spendable && c.remaining < c.amount ? html`<p class="small">of ${c.amountLabel} issued</p>` : ''}
          ${c.reserved ? html`<p class="banner warn compact">${icon('hourglass', 18, 2.2)}<span>${c.reservedLabel} is held by a booking waiting for payment. It returns if that hold ends unpaid.</span></p>` : ''}
          <dl class="kv">
            <div><dt>Player</dt><dd>${c.user.name}<br><span class="small">${c.user.email}</span></dd></div>
            <div><dt>Why</dt><dd>${c.reason}</dd></div>
            ${c.source ? html`<div><dt>From</dt><dd><a class="mono" href="${BASE}/bookings/${c.source.bookingId}">${c.source.ref}</a>${c.source.label ? html`<br><span class="small">${c.source.label}</span>` : ''}</dd></div>` : ''}
            ${c.disruptionId ? html`<div><dt>Disruption</dt><dd><a href="${BASE}/disruptions/${c.disruptionId}">Open the record</a></dd></div>` : ''}
            <div><dt>Issued</dt><dd>${dayClock(c.issuedAt)}</dd></div>
          </dl>
          ${admin && c.state !== 'voided' && c.remaining > 0 ? html`<div class="row row-wrap" data-gap="8">
            <button type="button" class="btn btn-secondary btn-sm" data-act="refund">${icon('banknote', 18)}Record a cash refund</button>
            <button type="button" class="btn btn-danger-outline btn-sm" data-act="void">Void credit</button></div>` : ''}
        </section>
        <section class="panel"><div class="panel-head"><h2 class="panel-title">History</h2></div>
          <ol class="menu dz-history">${d.history.map((h) => html`<li class="list-row">
            <span class="grow"><span class="row-title">${h.label}</span><br><span class="row-meta">${dayClock(h.at)}${h.actor ? ` · ${h.actor}` : ''}${h.note ? ` · ${h.note}` : ''}</span></span>
            <span class="mono ${h.amount > 0 ? 'green-text' : ''}">${h.amountLabel}</span></li>`)}</ol>
        </section>
      </div>`);
  }

  on(root, 'click', '[data-act="void"]', () => {
    const c = d.credit;
    actionDialog({
      title: `Void ${c.remainingLabel} of ${c.user.name}'s credit?`,
      intro: 'The player can no longer spend it and is told why. Use this for a credit issued by mistake.',
      fields: html`<div class="field"><label class="label" for="cv-reason">Reason the player sees</label><input class="input" id="cv-reason" maxlength="120" placeholder="e.g. Issued twice by mistake"></div>`,
      submitLabel: 'Void credit',
      danger: true,
      send: (panel) => api.post(`/api/admin/credits/${encodeURIComponent(id)}/void`, { reason: panel.querySelector('#cv-reason').value.trim() }),
      onDone: () => {
        toast('Credit voided', { sub: `${c.user.name} was notified.` });
        load();
      },
    });
  });
  on(root, 'click', '[data-act="refund"]', () => {
    const c = d.credit;
    // One intended refund keeps its identity through network/server retries.
    const key = newIdempotencyKey();
    actionDialog({
      title: `Record a cash refund for ${c.user.name}`,
      intro: `Only after Le Spinners actually paid it (GCash or cash at the desk). It spends that much of the credit, so it can't also be used. Up to ${c.remainingLabel}.`,
      fields: html`<div class="grid-2 grid-2-stack">
          <div class="field"><label class="label" for="cr-amount">Amount (₱)</label><input class="input mono" id="cr-amount" inputmode="decimal" maxlength="9" value="${(c.remaining / 100).toFixed(2)}"></div>
          <div class="field"><label class="label" for="cr-method">Paid by</label><select class="select" id="cr-method"><option value="gcash">GCash</option><option value="cash">Cash at the front desk</option></select></div>
        </div>
        <div class="field"><label class="label" for="cr-ref">GCash reference number</label><input class="input mono" id="cr-ref" maxlength="40" placeholder="Required for GCash"></div>
        <div class="field"><label class="label" for="cr-note">Note <span class="opt">(optional)</span></label><input class="input" id="cr-note" maxlength="200"></div>`,
      submitLabel: 'Record refund',
      send: (panel) => {
        const pesos = Number(panel.querySelector('#cr-amount').value.replace(/[₱,\s]/g, ''));
        return api.post(`/api/admin/credits/${encodeURIComponent(id)}/refund`, {
          amount: Math.round(pesos * 100),
          method: panel.querySelector('#cr-method').value,
          reference: panel.querySelector('#cr-ref').value.trim() || null,
          note: panel.querySelector('#cr-note').value.trim() || null,
        }, { headers: { 'Idempotency-Key': key } });
      },
      onDone: () => {
        toast('Refund recorded', { sub: `${c.user.name} was notified.` });
        load();
      },
    });
  });
  load();
}
