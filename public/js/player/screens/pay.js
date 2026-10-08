import { createViewTools } from '../../core/view.js';
import { api } from '../../core/api.js';
import { listen, $, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { bookingTime, bytes, clock, dateLabel, monthDayYear, peso, shortDate } from './util.js';
import {
  announce, countdownPanel, copyText, errorState, openModal, ringSvg, skeletonRows, startCountdown, statusPill, syncWarnLine, toast,
} from '../../core/ui.js';
import { navigate, show, state, subHeader } from '../shell.js';
import { lockLine } from '../components.js';

const viewTools = createViewTools({ listen, api, on, render, setBusy, announce, copyText, openModal, startCountdown, toast, navigate, show });

const MAX_MB = 10;
const OK_TYPES = { 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WEBP' };

async function loadDetail(id) {
  const { api } = viewTools();
  return api.get(`/api/bookings/${encodeURIComponent(id)}`);
}

function loadingScreen() {
  const { show } = viewTools();
  show(html`<div class="screen">${skeletonRows(1, 'sk-card')}${skeletonRows(4)}</div>`);
}

function failScreen(err, retry) {
  const { listen, show } = viewTools();
  const root = show(html`<div class="screen">${err.status === 404 ? html`<div class="empty"><p class="empty-title">Booking not found</p><p class="empty-body">It may belong to another account, or the link is old.</p><a class="btn btn-primary btn-md" href="/bookings">My bookings</a></div>` : errorState(err)}</div>`);
  listen($('[data-act="retry"]', root), 'click', retry);
}

const holding = (b) => (b.status === 'TEMPORARY' || b.status === 'REJECTED') && b.canSubmitProof;

// ── S05: slot held right after "Reserve & pay" ─────────────────────────────

export async function heldView({ params }) {
  const { navigate, show, startCountdown, announce, on } = viewTools();
  loadingScreen();
  let d;
  try {
    d = await loadDetail(params.id);
  } catch (err) {
    return failScreen(err, () => heldView({ params }));
  }
  const b = d.booking;
  if (b.status !== 'TEMPORARY') return navigate(`/bookings/${b.id}`, { replace: true });
  const root = show(html`<div class="screen has-sticky screen-enter held">
    <div class="row row-between"><span></span><a class="icon-btn" href="/" aria-label="Close. Your hold stays active.">${icon('x', 20, 2.2)}</a></div>
    <div class="ring-lg" data-countdown role="timer" aria-live="off" aria-label="Time left to pay">
      ${ringSvg(132)}
      <div class="rl-text"><span class="rl-time" data-cd-time>--:--</span><span class="rl-label"><span class="when-calm">left to pay</span><span class="when-warn">left to pay</span><span class="when-ended">hold ended</span></span></div>
    </div>
    <div class="stack stack-8 center">
      <p class="overline amber">Booking created</p>
      <h1 class="h1">${b.resource.name} is held for you</h1>
      <p class="body">Pay ${b.amountLabel} using a configured payment method${b.creditApplied ? ` (your ${b.creditAppliedLabel} booking credit covers the rest)` : ''} and upload your screenshot before the timer runs out. Until then, other players see this slot as "On hold".</p>
    </div>
    <p class="banner warn" role="alert" data-warn-line hidden>${icon('hourglass', 20, 2.2)}<span><b>Your temporary reservation will expire soon.</b> Upload your proof now to keep ${b.resource.name}.</span></p>
    <a class="banner neutral" href="/bookings/${b.id}" data-ended-line hidden>${icon('clock-x', 20, 2.2)}<span>The hold ended and ${b.resource.name} was released. See what you can do next.</span></a>
    <section class="card">
      <div class="card-head card-pad"><span class="mono">${b.ref}</span>${statusPill(b.status, { small: true })}</div>
      <dl class="kv summary-card">
        <div><dt>${b.activity === 'table_tennis' ? 'Table' : 'Court'}</dt><dd>${b.activityLabel} · ${b.resource.name}</dd></div>
        <div><dt>When</dt><dd>${dateLabel(b.date)} · ${bookingTime(b)}</dd></div>
        ${b.creditApplied ? html`<div><dt>Booking credit</dt><dd class="mono">−${b.creditAppliedLabel}</dd></div>` : ''}
        <div><dt>To pay</dt><dd class="mono">${b.amountLabel}</dd></div>
        <div><dt>Hold ends</dt><dd class="amber-strong">${clock(b.holdExpiresAt)}</dd></div>
      </dl>
    </section>
    <div>
      <div class="progress after" aria-hidden="true"><span class="current"></span><span></span><span></span><span></span></div>
      <div class="progress-labels" aria-label="Next steps"><span class="current">Held</span><span>Pay &amp; upload</span><span>Staff verify</span><span>Confirmed</span></div>
    </div>
  </div>
  <div class="sticky-bar"><div class="sticky-inner">
    <a class="btn btn-primary btn-lg btn-block glow" href="/bookings/${b.id}/pay" data-pay>Continue to payment ${icon('arrow-right', 20, 2.4)}</a>
    <button type="button" class="btn btn-text btn-block" data-act="release">Release this slot</button>
  </div></div>`);

  const stop = startCountdown(root, {
    expiresAt: b.holdExpiresAt,
    serverNow: d.now,
    totalMs: state.facility.rules.holdMinutes * 60_000,
    announce,
    onTick: (left) => {
      syncWarnLine(root, left);
      $('[data-ended-line]', root).hidden = left > 0;
    },
    onEnd: () => {
      const pay = $('[data-pay]', root);
      pay.classList.add('btn-secondary');
      pay.classList.remove('btn-primary', 'glow');
      pay.textContent = 'See what happened';
      pay.setAttribute('href', `/bookings/${b.id}`);
    },
  });
  on(root, 'click', '[data-act="release"]', (_e, btn) => confirmRelease(b, btn));
  return stop;
}

function confirmRelease(b, trigger) {
  const { openModal, on, setBusy, api, toast, navigate } = viewTools();
  openModal({
    label: 'Release this slot?',
    content: (close) => html`<span class="tile neutral">${icon('circle-slash', 24)}</span>
      <h2 class="dialog-title">Release this slot?</h2>
      <p class="body"><b>${b.resource.name} · ${dateLabel(b.date)} · ${bookingTime(b)}</b> opens for other players right away. Nothing was paid, so nothing is refunded.</p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-danger btn-block" data-act="confirm">Release slot</button>
        <button type="button" class="btn btn-secondary btn-block" data-close>Keep my hold</button>
      </div>`,
    onOpen: (panel, m) => {
      on(panel, 'click', '[data-act="confirm"]', async (_e, btn) => {
        setBusy(btn, true, 'Releasing…');
        try {
          await api.post(`/api/bookings/${b.id}/release`);
          m.close();
          toast('Slot released', { sub: `${b.resource.name} is open for other players.` });
          navigate(`/book/${b.activity}/${b.date}/${b.resource.id}`, { replace: true });
        } catch (err) {
          setBusy(btn, false);
          m.close();
          toast(err.message, { type: 'error' });
          navigate(`/bookings/${b.id}`, { replace: true });
        }
      });
    },
  });
  return trigger;
}

// ── U25 + U28 + S13: payment instructions and proof upload ─────────────────

function fileProblem(file) {
  if (!OK_TYPES[file.type] && !/\.(jpe?g|png|webp)$/i.test(file.name)) {
    return { title: "That file type isn't supported", body: 'Upload a JPG, PNG or WEBP. Tip: take a screenshot of the payment receipt instead of sharing the photo.' };
  }
  if (file.size > MAX_MB * 1024 * 1024) {
    return { title: 'This image is too large', body: `The limit is ${MAX_MB} MB. A screenshot of the receipt is usually well under that.` };
  }
  if (file.size === 0) return { title: 'That file is empty', body: 'Choose your payment screenshot again.' };
  return null;
}

function typeLabel(file) {
  return OK_TYPES[file.type] || (file.name.split('.').pop() || '').toUpperCase();
}

function parsePesos(v) {
  const clean = String(v || '').replace(/[₱,\s]/g, '');
  if (!clean) return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(clean)) return NaN;
  const [w, f = ''] = clean.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

function paymentCard(method, b) {
  if (!method || (!method.accountName && !method.accountNumber && !method.qrUrl)) return '';
  return html`<section class="card gcash-card">
    <div class="gc-head"><span class="overline">Payment information</span><span class="pill volt sm">${method.name}</span></div>
    <div class="gc-body">
      ${method.accountName ? html`<div class="kv-stack"><span class="small">Account name</span><span class="strong">${method.accountName}</span></div>` : ''}
      ${method.accountNumber ? html`<div class="row row-between payment-account"><div class="kv-stack"><span class="small">Account number</span><span class="mono gc-number">${method.accountNumber}</span></div><button type="button" class="btn btn-tonal btn-sm" data-copy="${method.accountNumber}" data-copy-label="Account number copied">${icon('copy', 18)}<span>Copy number</span></button></div>` : ''}
      ${method.qrUrl ? html`<div class="qr-panel"><img class="qr-img" src="${method.qrUrl}" alt="${method.name} QR code" width="216" height="216"><p class="small strong ink">Scan with ${method.name}</p><div class="row row-wrap" data-gap="8"><a class="btn btn-secondary btn-sm" href="${method.qrUrl}" download="le-spinners-qr" data-native>${icon('download', 18)}Save QR</a><a class="btn btn-secondary btn-sm" href="/bookings/${b.id}/gcash?method=${encodeURIComponent(method.id)}">${icon('fullscreen', 18)}Full screen</a></div></div>` : ''}
    </div>
  </section>`;
}

export async function payView({ params, query }) {
  const { scope, listen, navigate, show, render, on, copyText, toast, setTimeout, setBusy, api, startCountdown, announce } = viewTools();
  loadingScreen();
  let d;
  try {
    d = await loadDetail(params.id);
  } catch (err) {
    return failScreen(err, () => payView({ params, query }));
  }
  const b = d.booking;
  if (!holding(b)) return navigate(`/bookings/${b.id}`, { replace: true });
  const rejected = b.status === 'REJECTED';
  let methods = (d.payment?.methods || []).filter(method => method.enabled);
  let selectedId = methods.find(method => method.id === query.get('method'))?.id
    || methods.find(method => method.id === b.paymentMethodId)?.id || methods[0]?.id || '';
  const totalMs = (rejected ? state.facility.rules.resubmitMinutes : state.facility.rules.holdMinutes) * 60_000;

  const root = show(html`${subHeader({
    backHref: `/bookings/${b.id}`,
    backLabel: 'Back to booking',
    sub: `${rejected ? 'Resubmit proof' : 'Temporary booking'} · ${b.ref}`,
    title: 'Payment',
    right: html`<a class="btn btn-tonal btn-xs" href="/bookings/${b.id}/chat" aria-label="Ask Le Spinners about this booking">${icon('chat', 16)}Help</a>`,
    below: countdownPanel({
      expiresAt: b.holdExpiresAt,
      caption: rejected ? 'Resubmit window' : 'Payment window',
      line: rejected ? `Send corrected proof to keep ${b.resource.name}` : undefined,
      resourceName: b.resource.name,
      alwaysAmber: rejected,
    }),
  })}
  <div class="screen tight screen-enter pay">
    <a class="banner neutral" href="/bookings/${b.id}" data-ended-line hidden>${icon('clock-x', 20, 2.2)}<span>Payment window closed — see what happened</span></a>
    ${rejected ? html`<section class="banner error" role="alert">${icon('x-circle', 20, 2.2)}<div><b>Payment proof rejected.</b> Reason: "${b.rejectReason}"<br>Send a new screenshot before the timer ends to keep ${b.resource.name}.</div></section>` : ''}
    <section class="card amount-card">
      <div class="card-head"><span class="overline">Payment required</span>${statusPill(b.status, { small: true })}</div>
      <p class="amount mono">${b.amountLabel}</p>
      ${b.creditApplied ? html`<p class="small">${b.totalLabel} total · ${b.creditAppliedLabel} paid with booking credit</p>` : ''}
      <p class="small">${b.rate === 'member' ? 'Member rate' : 'Non-member rate'} · ${b.durationLabel}</p>
      <p class="strong">${b.activityLabel} · ${b.resource.name}</p>
      <p class="small">${monthDayYear(b.date)} · ${bookingTime(b, { full: true })}</p>
    </section>
    <section class="section">
      <h2 class="h3">How to pay</h2>
      <ol class="howto">
        <li><span class="n">1</span>Send ${b.amountLabel} using your selected method</li>
        <li><span class="n">2</span>Screenshot the receipt</li>
        <li><span class="n">3</span>Upload it below</li>
      </ol>
    </section>
    <section class="card card-pad stack stack-12">
      <label class="label" for="payment-method">Payment Method</label>
      <select class="input" id="payment-method" data-payment-method aria-describedby="payment-method-state"></select>
      <p class="small" id="payment-method-state" role="status" data-method-state hidden></p>
      <button type="button" class="btn btn-secondary btn-sm" data-refresh-methods hidden>Refresh payment methods</button>
    </section>
    <div data-payment-info aria-live="polite"></div>
    <p class="banner warn compact">${icon('alert', 18, 2.2)}<span>Pay exactly <b>${b.amountLabel}</b> before uploading proof.</span></p>
    <section class="card card-pad-lg stack stack-16 upload-card" id="upload">
      <div class="stack stack-4"><h2 class="h3">Already paid?</h2><p class="small">Send us proof so staff can verify it.</p></div>
      <form class="stack stack-16" novalidate data-form="proof">
        <div data-file-slot></div>
        <input class="sr-only" type="file" id="proof-file" name="file" accept="image/jpeg,image/png,image/webp" data-file-input>
        <div class="grid-2 grid-2-stack">
          <div class="field">
            <label class="label" for="f-ref">Payment reference number <span class="opt">(optional)</span></label>
            <input class="input mono" id="f-ref" name="gcashRef" autocomplete="off" maxlength="40" placeholder="e.g. 123456789">
          </div>
          <div class="field">
            <label class="label" for="f-amount">Amount paid <span class="opt">(optional)</span></label>
            <div class="input-group"><span class="prefix">₱</span><input class="input mono" id="f-amount" name="amountPesos" inputmode="decimal" autocomplete="off" maxlength="12" placeholder="${(b.amountDue / 100).toFixed(2)}"></div>
          </div>
        </div>
        <p data-match aria-live="polite"></p>
        <p class="banner info compact">${icon('info', 18, 2.2)}<span><b>Your booking is not confirmed until the admin verifies your payment.</b></span></p>
        <button type="submit" class="btn btn-primary btn-lg btn-block" data-submit disabled>Add a screenshot to submit</button>
        ${lockLine()}
      </form>
    </section>
    <a class="card card-link list-row link-card" href="/bookings/${b.id}/chat">
      <span class="tile blue sm">${icon('chat', 20)}</span>
      <span class="grow"><span class="row-title">Questions about paying?</span><br><span class="row-meta">Chat with Le Spinners about this booking</span></span>
      ${icon('chevron-right', 20, 2.2, 'chev')}
    </a>
  </div>`);

  const form = $('[data-form="proof"]', root);
  const slot = $('[data-file-slot]', root);
  const input = $('[data-file-input]', root);
  const submit = $('[data-submit]', root);
  const matchEl = $('[data-match]', root);
  let file = null;
  let preview = null;
  scope?.own(() => { if (preview) URL.revokeObjectURL(preview); preview = null; });
  let problem = null;
  let uploading = false;
  let ended = false;
  let lastError = null;
  const methodSelect = $('[data-payment-method]', root);
  function paintMethod() {
    render(methodSelect, methods.length ? html`${!selectedId ? html`<option value="" disabled>Choose payment method</option>` : ''}${methods.map(method => html`<option value="${method.id}">${method.name}</option>`)}` : html`<option value="">Unavailable</option>`);
    methodSelect.value = selectedId;
    methodSelect.disabled = !methods.length || uploading;
    const selected = methods.find(method => method.id === selectedId);
    render($('[data-payment-info]', root), paymentCard(selected, b));
    const qr = $('[data-payment-info] .qr-img', root);
    if (qr) listen(qr, 'error', () => {
      const card = qr.closest('.gcash-card');
      qr.closest('.qr-panel')?.remove();
      if (!selected.accountName && !selected.accountNumber) card?.remove();
    }, { once: true });
    $('[data-method-state]', root).hidden = Boolean(methods.length && selectedId);
    $('[data-method-state]', root).textContent = methods.length ? (selectedId ? '' : 'Choose the payment method used for this proof before resubmitting.') : 'Payment methods are currently unavailable. Contact Le Spinners through Help or try refreshing.';
    $('[data-refresh-methods]', root).hidden = Boolean(methods.length);
    paintSubmit();
  }
  async function refreshMethods() {
    const button = $('[data-refresh-methods]', root);
    setBusy(button, true, 'Refreshing…');
    try {
      const detail = await api.get(`/api/bookings/${b.id}`);
      methods = (detail.payment?.methods || []).filter(method => method.enabled);
      selectedId = methods.find(method => method.id === selectedId)?.id || '';
      paintMethod();
    } catch (err) { toast(err.message, { type: 'error' }); }
    finally { setBusy(button, false); }
  }
  listen(methodSelect, 'change', () => {
    selectedId = methodSelect.value;
    const url = new URL(location.href); url.searchParams.set('method', selectedId);
    history.replaceState(history.state, '', url.pathname + url.search);
    paintMethod();
  });
  listen($('[data-refresh-methods]', root), 'click', refreshMethods);

  function paintFile() {
    if (preview) {
      URL.revokeObjectURL(preview);
      preview = null;
    }
    if (uploading) return;
    if (lastError) {
      render(slot, html`<div class="file-card error" role="alert">
        <span class="file-thumb bad">${icon('alert', 22)}</span>
        <div class="grow stack stack-4">
          <span class="mono ellipsis small ink">${file ? file.name : 'Screenshot'}</span>
          ${file ? html`<span class="meta">${bytes(file.size)} · ${typeLabel(file)}</span>` : ''}
          <b class="err-title">${lastError.title}</b><span class="err-body">${lastError.body}</span>
          <div class="row row-wrap" data-gap="8">
            ${lastError.retry ? html`<button type="button" class="btn btn-dark btn-xs" data-act="retry-upload">${icon('refresh', 16)}Try again</button>` : ''}
            <label class="btn btn-danger-outline btn-xs" for="proof-file">Choose another file</label>
          </div>
        </div>
      </div>`);
    } else if (!file) {
      render(slot, html`<label class="dropzone" for="proof-file" data-dropzone>
        <span class="tile blue">${icon('upload', 22)}</span>
        <span class="dz-title">Upload payment screenshot</span>
        <span class="dz-hint">JPG, PNG or WEBP · up to ${MAX_MB} MB</span>
      </label>`);
    } else {
      preview = URL.createObjectURL(file);
      render(slot, html`<div class="file-card">
        <img class="file-thumb" src="${preview}" alt="Preview of your screenshot">
        <div class="grow stack stack-4">
          <span class="row small strong ink" data-gap="6">${icon('check-circle', 18, 2.2)}<span class="ellipsis">${file.name}</span></span>
          <span class="meta">${bytes(file.size)} · ${typeLabel(file)} · looks good</span>
          <div class="row" data-gap="8"><label class="btn btn-secondary btn-xs" for="proof-file">Replace</label><button type="button" class="btn btn-text btn-xs danger-text" data-act="remove">Remove</button></div>
        </div>
      </div>`);
    }
    paintSubmit();
  }

  function paintSubmit() {
    if (uploading) return;
    const ready = file && !problem && !ended && selectedId && methods.some(method => method.id === selectedId);
    submit.disabled = !ready;
    submit.textContent = ended ? 'Payment window closed' : !methods.length ? 'Payment method unavailable' : !selectedId ? 'Choose a payment method' : ready ? 'Submit payment proof' : 'Add a screenshot to submit';
  }

  function paintMatch() {
    const v = parsePesos(form.elements.namedItem('amountPesos').value);
    if (v == null) return render(matchEl, '');
    if (Number.isNaN(v)) return render(matchEl, html`<span class="field-error">${icon('alert', 16, 2.2)}Enter the amount like ${(b.amountDue / 100).toFixed(2)}</span>`);
    if (v === b.amountDue) return render(matchEl, html`<span class="match-ok">${icon('check-circle', 18, 2.2)}Matches the booking amount</span>`);
    render(matchEl, html`<span class="row row-wrap" data-gap="8"><span class="pill red sm">${icon('alert', 12, 2.4)}Amount differs</span><span class="small">The booking total is ${b.amountLabel}. Staff will check the screenshot.</span></span>`);
  }

  listen(input, 'change', () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    file = f;
    problem = fileProblem(f);
    lastError = problem;
    paintFile();
  });
  on(slot, 'click', '[data-act="remove"]', () => {
    file = null;
    problem = null;
    lastError = null;
    paintFile();
    input.focus();
  });
  on(slot, 'click', '[data-act="retry-upload"]', () => doUpload());
  listen(form.elements.namedItem('amountPesos'), 'input', paintMatch);
  listen(form, 'submit', (e) => {
    e.preventDefault();
    doUpload();
  });
  on(root, 'click', '[data-copy]', async (_e, btn) => {
    if (await copyText(btn.dataset.copy)) {
      toast(btn.dataset.copyLabel || 'Copied');
      btn.classList.add('copied');
      render(btn, html`${icon('check', 18, 2.6)}<span>Copied</span>`);
      setTimeout(() => {
        btn.classList.remove('copied');
        render(btn, html`${icon('copy', 18)}<span>Copy number</span>`);
      }, 2500);
    }
  });

  async function doUpload() {
    if (!file || problem || uploading || ended || !methods.some(method => method.id === selectedId)) return;
    const amount = parsePesos(form.elements.namedItem('amountPesos').value);
    if (Number.isNaN(amount)) {
      form.elements.namedItem('amountPesos').focus();
      return;
    }
    uploading = true;
    lastError = null;
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('paymentMethodId', selectedId);
    methodSelect.disabled = true;
    const ref = form.elements.namedItem('gcashRef').value.trim();
    if (ref) fd.append('gcashRef', ref);
    if (amount != null) fd.append('amountPesos', (amount / 100).toFixed(2));
    render(slot, html`<div class="file-card uploading" aria-live="polite">
      <img class="file-thumb dim" src="${preview || ''}" alt="">
      <div class="grow stack stack-8">
        <span class="row row-between small strong ink"><span>Uploading…</span><span class="mono" data-pct>0%</span></span>
        <span class="upbar"><span data-bar></span></span>
        <span class="meta">Keep this screen open</span>
      </div>
    </div>`);
    setBusy(submit, true, 'Submitting…');
    const bar = $('[data-bar]', slot);
    const pct = $('[data-pct]', slot);
    try {
      await api.upload(`/api/bookings/${b.id}/proof`, fd, {
        onProgress: (p) => {
          if (pct) pct.textContent = `${p}%`;
          if (bar) bar.style.setProperty('width', `${p}%`);
        },
      });
      uploading = false;
      navigate(`/bookings/${b.id}/submitted`, { replace: true });
    } catch (err) {
      uploading = false;
      setBusy(submit, false);
      methodSelect.disabled = !methods.length;
      if (err.code === 'HOLD_EXPIRED' || err.code === 'ALREADY_SUBMITTED' || err.code === 'INVALID_STATUS' || err.code === 'BOOKING_CHANGED') {
        toast(err.message, { type: err.code === 'ALREADY_SUBMITTED' ? 'info' : 'error' });
        navigate(`/bookings/${b.id}`, { replace: true });
        return;
      }
      if (err.code === 'PAYMENT_METHOD_UNAVAILABLE') {
        lastError = { title: 'Payment method changed', body: err.message, retry: true };
        await refreshMethods();
      } else if (err.code === 'NETWORK') lastError = { title: "Upload didn't finish", body: 'Your connection dropped. Your hold timer keeps running, so try again now.', retry: true };
      else if (err.code === 'FILE_TOO_LARGE') lastError = { title: 'This image is too large', body: err.message };
      else if (err.code === 'UNSUPPORTED_FILE_TYPE' || err.code === 'EMPTY_FILE') lastError = { title: "That file type isn't supported", body: err.message };
      else if (err.details && err.details.amountPesos) {
        lastError = null;
        render(matchEl, html`<span class="field-error">${icon('alert', 16, 2.2)}${err.details.amountPesos[0]}</span>`);
      } else lastError = { title: "Upload didn't finish", body: err.message, retry: true };
      problem = lastError && !lastError.retry ? lastError : null;
      paintFile();
    }
  }

  paintMethod();
  paintFile();
  if (query.get('upload') === '1') setTimeout(() => $('#upload', root)?.scrollIntoView({ block: 'start' }), 50);

  return startCountdown(root, {
    expiresAt: b.holdExpiresAt,
    serverNow: d.now,
    totalMs,
    announce,
    onTick: (left) => {
      if (!rejected) syncWarnLine(root, left);
      $('[data-ended-line]', root).hidden = left > 0;
    },
    onEnd: () => {
      ended = true;
      if (!uploading) paintSubmit();
    },
  });
}

// ── U26: payment QR full screen ────────────────────────────────────────────

export async function gcashView({ params, query }) {
  const { navigate, show, listen, startCountdown } = viewTools();
  loadingScreen();
  let d;
  try { d = await loadDetail(params.id); } catch (err) { return failScreen(err, () => gcashView({ params, query })); }
  const b = d.booking;
  const methods = (d.payment?.methods || []).filter(method => method.enabled);
  const method = methods.find(row => row.id === query.get('method')) || methods.find(row => row.id === b.paymentMethodId) || methods[0];
  const payUrl = '/bookings/' + b.id + '/pay' + (method ? '?method=' + encodeURIComponent(method.id) : '');
  if (!holding(b) || !method?.qrUrl) return navigate(payUrl, { replace: true });
  const root = show(html`<div class="screen gcash-full screen-enter">
    <div class="row row-between"><a class="icon-btn" href="${payUrl}" aria-label="Close">${icon('x', 20, 2.2)}</a><h1 class="h3">Pay with ${method.name}</h1><span class="timer-pill" data-countdown role="timer" aria-label="Time left">${icon('clock', 16, 2.2)}<span data-cd-time>--:--</span></span></div>
    <div class="qr-panel big"><img class="qr-img" src="${method.qrUrl}" alt="${method.name} QR code" width="240" height="240"><p class="small">Scan with ${method.name} - pay <span class="mono ink">${peso(b.amountDue, { decimals: true })}</span></p></div>
    ${method.accountName ? html`<p class="strong">${method.accountName}</p>` : ''}
    ${method.accountNumber ? html`<p class="mono">${method.accountNumber}</p>` : ''}
    <section class="section"><h2 class="h3">Paying on this phone?</h2><ol class="steps-list"><li><span class="n blue">1</span><span>Save the QR image below.</span></li><li><span class="n blue">2</span><span>Open ${method.name} and scan the saved image from your gallery.</span></li><li><span class="n blue">3</span><span>Pay exactly <b>${b.amountLabel}</b>, screenshot the receipt, then upload proof.</span></li></ol></section>
    <a class="btn btn-secondary btn-block" href="${method.qrUrl}" download="le-spinners-qr" data-native>${icon('download', 20)}Save QR image</a>
    <a class="btn btn-primary btn-lg btn-block" href="${payUrl}&upload=1" data-replace>I've paid - upload proof</a>
  </div>`);
  listen($('.qr-img', root), 'error', () => navigate(payUrl, { replace: true }), { once: true });
  return startCountdown(root, { expiresAt: b.holdExpiresAt, serverNow: d.now, totalMs: state.facility.rules.holdMinutes * 60_000 });
}

export async function submittedView({ params }) {
  const { navigate, show } = viewTools();
  loadingScreen();
  let d;
  try {
    d = await loadDetail(params.id);
  } catch (err) {
    return failScreen(err, () => submittedView({ params }));
  }
  const b = d.booking;
  if (b.status !== 'PAYMENT_SUBMITTED') return navigate(`/bookings/${b.id}`, { replace: true });
  show(html`<div class="screen center-screen screen-enter">
    <div class="done-ring violet" aria-hidden="true"><span>${icon('check', 34, 3)}</span></div>
    <div class="stack stack-8 center">
      <p class="overline violet">Payment proof submitted</p>
      <h1 class="h1">Waiting for admin verification</h1>
      <p class="body">Your payment proof has been received. Staff will check it against your booking and let you know.</p>
    </div>
    <section class="card card-pad stack stack-8">
      <div class="card-head"><span class="overline">Your booking is now</span>${statusPill(b.status, { small: true })}</div>
      <p class="h3">${b.activityLabel} · ${b.resource.name}</p>
      <div class="row row-between"><span class="small">${shortDate(b.date)} · ${bookingTime(b, { full: true })}</span><span class="mono">${b.amountLabel}</span></div>
    </section>
    <p class="banner violet compact">${icon('shield-clock', 18, 2.2)}<span>The ${state.facility.rules.holdMinutes}-minute timer has stopped. ${b.resource.name} stays reserved for you while staff verify.</span></p>
    <div class="stack stack-8">
      <a class="btn btn-primary btn-lg btn-block" href="/bookings/${b.id}" data-replace>View booking</a>
      <a class="btn btn-secondary btn-block" href="/bookings/${b.id}/chat">Open chat</a>
      <a class="btn btn-text btn-block" href="/">Back to home</a>
    </div>
  </div>`);
}

