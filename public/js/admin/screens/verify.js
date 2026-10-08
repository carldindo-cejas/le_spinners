import { createViewTools } from '../../core/view.js';
import { createScope, currentScope, setElementScope } from '../../core/lifecycle.js';
import { api } from '../../core/api.js';
import { listen, $, $$, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { bookingTime, bytes, clock, dayClock, firstName, minutesBetween, monthDayYear, peso, shortDate, weekdayShort } from '../../core/format.js';
import { choiceKeys, copyText, dialogFocus, errorState, lockScroll, memberTag, openModal, poll, preserveFocus, skeletonRows, statusPill, syncChoiceGroups, toast } from '../../core/ui.js';
import { frame, navigate, refreshBadges, state } from '../shell.js';
import { waitLabel } from './dashboard.js';
import { miniChat } from '../minichat.js';
import { API, BASE } from '../console.js';

const viewTools = createViewTools({ listen, api, on, render, setBusy, copyText, openModal, poll, toast, frame, navigate, refreshBadges, miniChat });

async function staffSettings() {
  const { api } = viewTools();
  if (!state.settings) {
    try {
      state.settings = (await api.get(`${API}/rules`)).settings;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      state.settings = { gcashNumber: '', resubmitMinutes: 10 };
    }
  }
  return state.settings;
}

/** "Before you approve": every item must be ticked before a payment can be approved. */
function checklistItems(b, p) {
  return [
    `Amount on the screenshot is ${b.amountLabel}`,
    `Sent using ${p?.paymentMethodName || b.paymentMethodName || 'GCash'} to ${[p?.accountName, p?.accountNumber].filter(Boolean).join(' · ') || 'the configured recipient'}`,
    p && p.gcashRef ? `Reference ${p.gcashRef} is in our payment history` : 'Reference is in our payment history',
    `Paid after the booking was made (${clock(b.createdAt)})`,
  ];
}

function amountPill(check) {
  if (check === 'match') return html`<span class="pill green sm">${icon('check', 12, 2.6)}Matches</span>`;
  if (check === 'differs') return html`<span class="pill red sm">${icon('alert', 12, 2.4)}Amount differs</span>`;
  return html`<span class="pill neutral sm">Not entered</span>`;
}


// ── Queue (A37 / AM37) ─────────────────────────────────────────────────────

function pendingCard(b, i, now) {
  const p = b.proof;
  return html`<article class="vq-card${i === 0 ? '' : ''}">
    <button type="button" class="vq-thumb" data-view="${b.id}" aria-label="Open ${b.user.name}'s payment proof">${p && p.url ? html`<img src="${p.url}" alt="">` : ''}<span class="view-chip">View</span></button>
    <div class="stack stack-4">
      <span class="who-line">${b.user.name}${memberTag(b.user.membership, { small: true })}</span>
      <span class="strong">${b.activityLabel} — ${b.resource.name}</span>
      <span class="small">${weekdayShort(b.date)}, ${shortDate(b.date)} • ${bookingTime(b)}</span>
      <span class="mono small ink">${b.ref}</span>
    </div>
    <dl class="vq-details">
      <div><dt>Amount due</dt><dd class="mono">${b.amountLabel}</dd><dd class="small">${b.rate === 'member' ? 'member rate' : 'non-member rate'}</dd></div>
      <div><dt>Paid (claimed)</dt><dd><span class="mono">${p && p.amountClaimedLabel ? p.amountClaimedLabel : '—'}</span>${amountPill(p ? p.amountCheck : 'unknown')}</dd></div>
      <div><dt>Method</dt><dd>${b.paymentMethodLabel || 'GCash'}</dd></div>
      <div><dt>Payment ref.</dt><dd class="${p && p.gcashRef ? 'mono' : 'amber-text'}">${p && p.gcashRef ? p.gcashRef : 'Not provided'}</dd></div>
      <div><dt>Submitted</dt><dd>${waitLabel(b.submittedAt, now, i === 0)}</dd></div>
    </dl>
    <div class="vq-actions">
      <a class="btn btn-primary btn-sm" href="${BASE}/verify/${b.id}">Review</a>
      <a class="btn btn-secondary btn-sm" href="${BASE}/messages/${b.id}">${icon('chat', 16)}Chat${b.unreadMessages ? html`<span class="badge inline">${b.unreadMessages}</span>` : ''}</a>
    </div>
  </article>`;
}

function approvedRow(b) {
  return html`<a class="panel list-row" href="${BASE}/bookings/${b.id}">
    <span class="tile green sm">${icon('check', 20, 2.6)}</span>
    <span class="grow"><span class="strong">${b.user.name}</span><br><span class="small">${b.resource.name} · ${shortDate(b.date)} ${bookingTime(b)} · ${b.amountLabel}</span><br><span class="meta">Approved by ${firstName(b.confirmedBy || 'staff')} · ${b.confirmedAt ? clock(b.confirmedAt) : ''}</span></span>
    ${statusPill(b.status, { small: true })}
  </a>`;
}

function rejectedCard(b) {
  const outcome = b.status === 'EXPIRED' ? 'No new proof in time · booking expired, slot released'
    : b.status === 'REJECTED' ? `Waiting for new proof until ${b.holdExpiresAt ? clock(b.holdExpiresAt) : ''}`
      : b.status === 'PAYMENT_SUBMITTED' ? 'New proof sent · back in the queue'
        : b.status === 'CONFIRMED' ? 'New proof approved · booking confirmed' : 'Closed';
  return html`<article class="panel panel-body stack stack-12">
    <div class="row row-between"><span><span class="strong">${b.user.name}</span><br><span class="small">${b.resource.name} · ${weekdayShort(b.date)}, ${shortDate(b.date)} · ${bookingTime(b)}</span></span>${statusPill(b.status, { small: true })}</div>
    <div class="reason-box ink-box"><span class="eyebrow">Reason sent to ${firstName(b.user.name)}</span><p class="body">${b.rejectReason || ''}</p></div>
    <p class="row small" data-gap="8"><span class="dot red-dot"></span>Rejected by ${firstName(b.rejectedBy || 'staff')} · ${b.rejectedAt ? clock(b.rejectedAt) : ''}</p>
    <p class="row small" data-gap="8"><span class="dot grey-dot"></span>${outcome}</p>
    <a class="btn btn-secondary btn-sm" href="${BASE}/messages/${b.id}">Open conversation</a>
  </article>`;
}

export async function queueView({ query }) {
  const { listen, frame, render, on, api, poll } = viewTools();
  let tab = ['pending', 'approved', 'rejected'].includes(query.get('tab')) ? query.get('tab') : 'pending';
  const s = await staffSettings();
  const root = frame({
    key: 'verify',
    title: 'Payment verification',
    mobileTitle: 'Verify payments',
    template: html`<div class="page">
      <div class="cols c-main-aside">
        <div class="stack stack-16">
          <div class="utabs only-desktop" role="tablist" aria-label="Payment verification" data-tabs-d></div>
          <div class="seg only-mobile" role="tablist" aria-label="Payment verification" data-tabs-m></div>
          <div class="row row-between"><p class="small" data-sort></p><p class="lock-line only-mobile">${icon('lock', 14, 2.2)}Proofs are private to staff</p></div>
          <div class="stack stack-12" role="tabpanel" id="verification-panel" tabindex="0" data-list>${skeletonRows(3, 'sk-card')}</div>
          <p class="banner violet compact only-mobile"><span><b>While pending,</b> these slots stay blocked for other players and no longer expire on the ${state.settings?.holdMinutes ?? 10}-minute timer.</span></p>
        </div>
        <aside class="stack stack-16 only-desktop">
          <section class="panel panel-body stack stack-12"><p class="eyebrow">Before you approve</p>
            <ol class="checklist">
              <li>Amount on the screenshot equals the amount due.</li>
              <li>Recipient matches the selected payment method.</li>
              <li>Reference number appears in the payment method history.</li>
              <li>Payment time is after the booking was created.</li>
            </ol></section>
          <section class="dark-card"><p class="eyebrow">While pending</p><p>Slots stay blocked for other players and don't expire on the ${s.holdMinutes ?? 10}-minute timer. Decide quickly — players see "Waiting for admin verification" until you do.</p></section>
        </aside>
      </div>
    </div>`,
  });
  const list = $('[data-list]', root);
  let data = null;
  let requestGeneration = 0;

  function paintTabs() {
    const c = data ? data.counts : { pending: 0, approved: 0, rejected: 0 };
    const tabs = [
      { k: 'pending', d: html`Pending<span class="count">${c.pending}</span>`, m: `Pending · ${c.pending}` },
      { k: 'approved', d: `Approved today · ${c.approved}`, m: `Approved · ${c.approved}` },
      { k: 'rejected', d: `Rejected · ${c.rejected}`, m: `Rejected · ${c.rejected}` },
    ];
    for (const [selector, suffix, label] of [['[data-tabs-d]', 'desktop', 'd'], ['[data-tabs-m]', 'mobile', 'm']]) {
      const target = $(selector, root);
      preserveFocus(target, () => {
        render(target, tabs.map((t) => html`<button type="button" role="tab" id="verification-${suffix}-${t.k}" aria-controls="verification-panel" data-tab="${t.k}" aria-selected="${tab === t.k ? 'true' : 'false'}">${t[label]}</button>`));
        syncChoiceGroups(target);
      });
    }
    list.setAttribute('aria-labelledby', `verification-${matchMedia('(min-width: 1024px)').matches ? 'desktop' : 'mobile'}-${tab}`);
    render($('[data-sort]', root), tab === 'pending' ? html`Sorted by <b>oldest first</b>` : html`Today · newest first`);
  }

  function paint() {
    paintTabs();
    if (!data.items.length) {
      render(list, html`<div class="empty"><span class="tile green lg">${icon('check-circle', 26)}</span><p class="empty-title">${tab === 'pending' ? 'All caught up' : tab === 'approved' ? 'Nothing approved yet today' : 'Nothing rejected today'}</p><p class="empty-body">${tab === 'pending' ? 'New payment proofs appear here the moment players upload them.' : 'Decisions made today show up here.'}</p></div>`);
      return;
    }
    if (tab === 'pending') render(list, data.items.map((b, i) => pendingCard(b, i, data.now)));
    else if (tab === 'approved') render(list, data.items.map(approvedRow));
    else render(list, data.items.map(rejectedCard));
  }

  on(root, 'click', '[data-tab]', (_e, btn) => {
    tab = btn.dataset.tab;
    history.replaceState(history.state, '', tab === 'pending' ? `${BASE}/verify` : `${BASE}/verify?tab=${tab}`);
    data = null;
    render(list, skeletonRows(3, 'sk-card'));
    load();
  });
  listen(root, 'keydown', choiceKeys);
  on(list, 'click', '[data-view]', (_e, btn) => {
    const b = data.items.find((x) => x.id === btn.dataset.view);
    if (b && b.proof && b.proof.url) openViewer({ url: b.proof.url, booking: b, proof: b.proof, onDecision: () => load() });
  });

  async function load() {
    const generation = ++requestGeneration, selectedTab = tab;
    try {
      const response = await api.get(`${API}/verifications?tab=${selectedTab}`);
      if (generation !== requestGeneration || selectedTab !== tab) return;
      data = response;
      paint();
    } catch (err) {
      if (generation !== requestGeneration || selectedTab !== tab) return;
      render(list, errorState(err));
      listen($('[data-act="retry"]', list), 'click', load);
    }
  }
  load();
  return poll(load, 15_000);
}

// ── Proof stage: pan, zoom, rotate ─────────────────────────────────────────

function attachStage(stage, img, readout) {
  const { listen } = viewTools();
  const st = { zoom: 1, rot: 0, tx: 0, ty: 0 };
  const apply = () => {
    img.style.setProperty('--zoom', String(st.zoom));
    img.style.setProperty('--rot', `${st.rot}deg`);
    img.style.setProperty('--tx', `${st.tx}px`);
    img.style.setProperty('--ty', `${st.ty}px`);
    if (readout) readout.textContent = `${Math.round(st.zoom * 100)}%`;
  };
  const zoomBy = (f) => {
    st.zoom = Math.min(5, Math.max(0.25, Math.round(st.zoom * f * 100) / 100));
    apply();
  };
  const pointers = new Map();
  let pinch = null;
  listen(stage, 'pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.classList.add('dragging');
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: st.zoom };
    }
  });
  listen(stage, 'pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      st.zoom = Math.min(5, Math.max(0.25, pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)));
    } else {
      st.tx += e.clientX - prev.x;
      st.ty += e.clientY - prev.y;
    }
    apply();
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) stage.classList.remove('dragging');
  };
  listen(stage, 'pointerup', end);
  listen(stage, 'pointercancel', end);
  listen(stage, 'wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
  apply();
  return {
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(1 / 1.25),
    rotate: () => {
      st.rot = (st.rot + 90) % 360;
      apply();
    },
    fit: () => {
      Object.assign(st, { zoom: 1, tx: 0, ty: 0 });
      apply();
    },
    keys: (e) => {
      if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-') zoomBy(1 / 1.25);
      else if (e.key === '0') Object.assign(st, { zoom: 1, tx: 0, ty: 0 }), apply();
      else if (e.key.toLowerCase() === 'r') st.rot = (st.rot + 90) % 360, apply();
      else return false;
      return true;
    },
  };
}

function zoomTools(prefix = '') {
  return html`<div class="zoom-group" role="group" aria-label="Zoom">
      <button type="button" data-z="${prefix}out" aria-label="Zoom out">${icon('zoom-out', 18)}</button>
      <span class="zv" data-zv>100%</span>
      <button type="button" data-z="${prefix}in" aria-label="Zoom in">${icon('zoom-in', 18)}</button>
    </div>
    <button type="button" class="btn btn-secondary btn-xs" data-z="${prefix}fit">Fit</button>
    <button type="button" class="btn btn-secondary btn-xs" data-z="${prefix}rotate">${icon('rotate-cw', 16)}Rotate</button>`;
}

/** Full-screen proof viewer (A39). */
export function openViewer({ url, booking: b, proof, onDecision, canDecide = true, checklistDone = false }) {
  const parent = currentScope();
  parent?.assertCurrent();
  const scope = createScope(parent);
  const { listen, render, on } = viewTools(scope);
  const host = document.createElement('div');
  setElementScope(host, scope);
  host.className = 'viewer';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-label', 'Payment proof viewer');
  host.tabIndex = -1;
  render(host, html`<div class="v-top">
      <button type="button" class="icon-btn" data-close aria-label="Close viewer">${icon('x', 20, 2.2)}</button>
      <div class="grow"><p class="strong">${proof && proof.fileName ? proof.fileName : 'Payment screenshot'}</p><p class="small light-text">Uploaded by ${b.user.name}${proof && (proof.createdAt || proof.submittedAt) ? ` · ${dayClock(proof.createdAt || proof.submittedAt)}` : ''}</p></div>
      ${zoomTools()}
    </div>
    <div class="v-stage" data-stage><img src="${url}" alt="Payment screenshot from ${b.user.name}" draggable="false"><p class="v-hint">Drag to pan · scroll or pinch to zoom · R rotates</p></div>
    <aside class="v-rail">
      <p class="eyebrow volt-text">Booking</p>
      <p class="h3">${b.resource.name} · ${b.activityLabel}</p>
      <p class="small light-text">${weekdayShort(b.date)}, ${shortDate(b.date)} · ${bookingTime(b)}</p>
      <p class="mono small">${b.ref}</p>
      <dl class="kv">
        <div><dt>Customer</dt><dd>${b.user.name} · ${b.user.membership === 'member' ? 'Member' : 'Non-member'}</dd></div>
        <div><dt>Amount due</dt><dd class="mono">${b.amountLabel}</dd></div>
        <div><dt>Claimed paid</dt><dd>${proof && proof.amountClaimed != null ? peso(proof.amountClaimed) : 'Not entered'}${proof && proof.amountCheck === 'match' ? ' ✓' : ''}</dd></div>
        <div><dt>Method</dt><dd>${proof?.paymentMethodName || b.paymentMethodName || 'GCash'}</dd></div>
        <div><dt>Payment ref.</dt><dd class="mono">${proof && proof.gcashRef ? proof.gcashRef : 'Not provided'}</dd></div>
      </dl>
      <p class="note">Only staff can open this image. Links are signed, expire after 5–10 minutes, and every view is logged.</p>
      ${canDecide && b.status === 'PAYMENT_SUBMITTED' ? html`<button type="button" class="btn btn-volt btn-block" data-decide="approve">Approve payment</button><button type="button" class="btn btn-ghost-light btn-block" data-decide="reject">Reject payment</button>` : ''}
    </aside>`);
  document.body.append(host);
  const focus = dialogFocus(host);
  const unlock = lockScroll();
  const previous = document.activeElement;
  const ctl = attachStage($('[data-stage]', host), $('[data-stage] img', host), $('[data-zv]', host));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scope.dispose();
    focus.dispose();
    host.remove();
    unlock();
    if ((!parent || parent.isCurrent()) && previous?.isConnected) previous.focus();
  };
  const onKey = (e) => {
    if (!focus.isActive()) return;
    if (e.key === 'Escape' && !document.querySelector('.scrim')) {
      e.preventDefault();
      close();
    } else if (!document.querySelector('.scrim') && ctl.keys(e)) e.preventDefault();
  };
  scope.own(listen(document, 'keydown', onKey, true));
  scope.own(close);
  on(host, 'click', '[data-close]', close);
  on(host, 'click', '[data-z]', (_e, btn) => ({ in: ctl.zoomIn, out: ctl.zoomOut, fit: ctl.fit, rotate: ctl.rotate })[btn.dataset.z]());
  on(host, 'click', '[data-decide]', (_e, btn) => {
    const after = () => {
      close();
      if (onDecision) onDecision();
    };
    if (btn.dataset.decide === 'approve') openApprove(b, proof, after, { checklistDone });
    else openReject(b, proof, after);
  });
  $('[data-close]', host).focus();
  return close;
}

// ── Approve (A43) and reject (A44) ─────────────────────────────────────────

async function nextPending(exceptId) {
  const { api } = viewTools();
  try {
    const res = await api.get(`${API}/verifications?tab=pending`);
    return res.items.find((x) => x.id !== exceptId) || null;
  } catch {
    return null;
  }
}

function openApprove(b, proof, onDone, { checklistDone = false } = {}) {
  const { openModal, on, setBusy, api, refreshBadges, toast, navigate } = viewTools();
  const first = firstName(b.user.name);
  const items = checklistItems(b, proof);
  const dayName = new Date(`${b.date}T00:00:00Z`).toLocaleString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const chatText = `Payment verified — see you on ${dayName}!`;
  let busy = false;
  const m = openModal({
    label: 'Approve this booking?',
    locked: () => busy,
    content: () => html`<span class="tile volt">${icon('shield-check', 24)}</span>
      <h2 class="dialog-title">Approve this booking?</h2>
      <p class="body">This marks the payment as verified and confirms the booking.</p>
      <dl class="kv card-soft">
        <div><dt>Booking</dt><dd>${b.resource.name} · ${monthDayYear(b.date).replace(/, \d{4}$/, '')} · ${bookingTime(b)}</dd></div>
        <div><dt>Customer</dt><dd>${b.user.name} · ${b.user.membership === 'member' ? 'Member' : 'Non-member'}</dd></div>
        <div><dt>Payment</dt><dd>${b.amountLabel} · ${proof?.paymentMethodName || b.paymentMethodName || 'GCash'} · ${proof && proof.gcashRef ? `Payment ref ${proof.gcashRef}` : 'no ref. entered'}</dd></div>
      </dl>
      ${proof && proof.amountCheck === 'differs' ? html`<p class="banner warn compact">${icon('alert', 18, 2.2)}<span>${first} entered <b>${peso(proof.amountClaimed)}</b> but <b>${b.amountLabel}</b> is due. Approve only if the screenshot shows the full amount.</span></p>` : ''}
      ${checklistDone ? '' : html`<fieldset class="fieldset stack stack-4"><legend class="label">Before you approve <span class="req">*</span> <span class="opt">— tick every check</span></legend>
        ${items.map((c, i) => html`<label class="check-toggle"><input type="checkbox" data-gate="${i}"><span>${c}</span></label>`)}
      </fieldset>`}
      <label class="check-row"><input type="checkbox" name="post" checked><span class="check-box">${icon('check', 16, 3)}</span><span><b>Also post in the booking chat:</b> "${chatText}"</span></label>
      <p class="small row row-top" data-gap="8">${icon('bell', 18)}<span>${first} gets an in-app notification right away: "Your payment has been verified and your booking is confirmed."</span></p>
      <div class="dialog-actions inline"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button type="button" class="btn btn-primary" data-act="approve" ${checklistDone ? '' : 'disabled'}>${checklistDone ? 'Approve booking' : 'Tick every check to approve'}</button></div>`,
    onOpen: (panel) => {
      const go = panel.querySelector('[data-act="approve"]');
      const gates = [...panel.querySelectorAll('[data-gate]')];
      const allTicked = () => gates.every((g) => g.checked);
      on(panel, 'change', '[data-gate]', () => {
        go.disabled = !allTicked();
        go.textContent = allTicked() ? 'Approve booking' : 'Tick every check to approve';
      });
      on(panel, 'click', '[data-act="approve"]', async (_e, btn) => {
        if (!allTicked()) return;
        busy = true;
        setBusy(btn, true, 'Approving…');
        try {
          const post = panel.querySelector('[name="post"]').checked;
          const res = await api.post(`${API}/bookings/${b.id}/approve`, { proofId: proof.id, checklist: true, ...(post ? { message: chatText } : {}) });
          busy = false;
          m.close();
          await refreshBadges();
          const next = await nextPending(b.id);
          const left = state.badges.pendingVerification;
          // A closure was waiting on this payment: the booking is now cancelled with a credit.
          const closed = (res.resolvedDisruptions || []).find((x) => x.outcome === 'cancelled' || x.outcome === 'partial');
          toast(closed ? 'Payment verified · booking cancelled by the closure' : 'Booking confirmed', {
            sub: closed
              ? `${first} got ${peso(closed.credit || 0)} booking credit${left ? ` · ${left} left to verify` : ''}`
              : left ? `${first} was notified · ${left} left to verify` : `${first} was notified`,
            timeout: 8000,
            action: next ? { label: 'Next', onClick: () => navigate(`${BASE}/verify/${next.id}`) } : null,
          });
          onDone();
        } catch (err) {
          busy = false;
          setBusy(btn, false);
          m.close();
          toast(err.message, { type: 'error' });
          onDone();
        }
      });
    },
  });
}

const REASONS = [
  'Payment amount does not match booking amount.',
  'Uploaded proof does not clearly show the transaction.',
  'Reference number not found in our payment history.',
  'Payment was sent to a different account.',
];

function openReject(b, proof, onDone) {
  const { listen, openModal, on, setBusy, api, refreshBadges, toast, navigate } = viewTools();
  const first = firstName(b.user.name);
  const minutes = (state.settings && state.settings.resubmitMinutes) || 10;
  let choice = null;
  let busy = false;
  const m = openModal({
    wide: true,
    label: 'Reject payment proof?',
    locked: () => busy,
    content: () => html`<div class="row" data-gap="12"><span class="tile red">${icon('x-circle', 24)}</span><div><h2 class="dialog-title">Reject payment proof?</h2><p class="small">${b.user.name} · ${b.resource.name} · ${shortDate(b.date)} · ${bookingTime(b)} · ${b.amountLabel}</p></div></div>
      <fieldset class="fieldset stack stack-8"><legend class="label">Reason <span class="req">*</span> <span class="opt">— ${first} will see this</span></legend>
        <div class="stack stack-8" role="radiogroup" aria-label="Reason">
          ${[...REASONS, 'Other — I will explain in the message.'].map((r, i) => html`<button type="button" class="reason-opt" role="radio" aria-checked="${choice === i ? 'true' : 'false'}" data-reason="${i}"><span class="radio"></span><span>${r}</span></button>`)}
        </div>
      </fieldset>
      <div class="field"><label class="label" for="rj-msg">Message to ${first}</label><textarea class="textarea" id="rj-msg" name="message" maxlength="1000" placeholder="Pick a reason above, or write your own."></textarea></div>
      <label class="check-row"><input type="checkbox" name="keep" checked><span class="check-box">${icon('check', 16, 3)}</span><span><b>Keep ${b.resource.name} on hold for ${minutes} minutes</b> so ${first} can send corrected proof. After that the slot is released.</span></label>
      <div class="dialog-actions inline"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button type="button" class="btn btn-danger" data-act="reject" disabled>Choose a reason to reject</button></div>`,
    onOpen: (panel) => {
      const msg = panel.querySelector('#rj-msg');
      const submit = panel.querySelector('[data-act="reject"]');
      const sync = () => {
        const other = choice === REASONS.length;
        const ok = choice != null && (!other || msg.value.trim().length >= 3);
        submit.disabled = !ok;
        submit.textContent = choice == null ? 'Choose a reason to reject' : other && !ok ? 'Explain the reason to reject' : 'Reject payment';
      };
      on(panel, 'click', '[data-reason]', (_e, btn) => {
        choice = Number(btn.dataset.reason);
        for (const r of panel.querySelectorAll('[data-reason]')) r.setAttribute('aria-checked', String(Number(r.dataset.reason) === choice));
        syncChoiceGroups(panel);
        msg.value = choice < REASONS.length ? `${REASONS[choice]} Please send a new screenshot in the booking chat or with "Submit new proof".` : '';
        if (choice === REASONS.length) msg.focus();
        sync();
      });
      listen(msg, 'input', sync);
      on(panel, 'click', '[data-act="reject"]', async () => {
        const other = choice === REASONS.length;
        const message = msg.value.trim();
        const reason = other ? message.slice(0, 300) : REASONS[choice];
        const keepHold = panel.querySelector('[name="keep"]').checked;
        busy = true;
        setBusy(submit, true, 'Rejecting…');
        try {
          await api.post(`${API}/bookings/${b.id}/reject`, { proofId: proof.id, reason, message: message || undefined, keepHold });
          busy = false;
          m.close();
          refreshBadges();
          const next = await nextPending(b.id);
          toast('Proof rejected', {
            type: 'info',
            sub: `${first} was notified with your reason.${keepHold ? ` ${b.resource.name} stays on hold for ${minutes} minutes.` : ' The slot was released.'}`,
            timeout: 8000,
            action: next ? { label: 'Next', onClick: () => navigate(`${BASE}/verify/${next.id}`) } : null,
          });
          onDone();
        } catch (err) {
          busy = false;
          setBusy(submit, false);
          toast(err.message, { type: 'error' });
          if (err.code === 'INVALID_STATUS' || err.code === 'PROOF_CHANGED') {
            m.close();
            onDone();
          }
        }
      });
    },
  });
}

// ── Verification detail (A38 / AM38) ───────────────────────────────────────

export async function verifyDetailView({ params }) {
  const { listen, frame, render, miniChat, on, copyText, toast, api } = viewTools();
  const id = params.id;
  await staffSettings();
  let d = null;
  let chat = null;
  // Ticked checklist items survive repaints; they reset when another proof comes in.
  const ticked = new Set();
  let tickedFor = null;
  const root = frame({
    key: 'verify',
    eyebrow: 'Payment verification',
    title: 'Booking verification',
    mobileHeader: null,
    tabs: false,
    template: html`<div data-body>${skeletonRows(4, 'sk-card')}</div>`,
  });
  const body = $('[data-body]', root);
  let stopStageKeys = () => {};

  function paint() {
    const b = d.booking;
    const p = d.proofs[0];
    const first = firstName(b.user.name);
    const decided = b.status !== 'PAYMENT_SUBMITTED';
    const checks = checklistItems(b, p);
    if (tickedFor !== (p ? p.id : null)) {
      ticked.clear();
      tickedFor = p ? p.id : null;
    }
    render(body, html`<div class="tb-mobile vd-head">
        <div class="row row-between"><a class="icon-btn" href="${BASE}/verify" data-back aria-label="Back to verification queue">${icon('chevron-left', 22, 2.2)}</a>${statusPill(b.status, { small: true })}</div>
        <div><p class="m-title row row-wrap" data-gap="8">${b.user.name}${memberTag(b.user.membership, { small: true })}</p>
        <p class="small light-text">${b.activityLabel} · ${b.resource.name} · ${weekdayShort(b.date)}, ${shortDate(b.date)} · ${bookingTime(b)}</p>
        <p class="small light-text mono">${b.ref}${b.submittedAt ? ` · proof sent ${clock(b.submittedAt)} · ${minutesBetween(b.submittedAt, d.now)} min ago` : ''}</p></div>
      </div>
      <div class="page no-tabbar">
        <div class="row only-desktop" data-gap="12"><a class="icon-btn" href="${BASE}/verify" data-back aria-label="Back to queue">${icon('chevron-left', 22, 2.2)}</a><span class="small">Payment verification / <span class="mono">${b.ref}</span></span>${statusPill(b.status, { small: true })}</div>
        ${decided ? html`<p class="banner ${b.status === 'CONFIRMED' ? 'success' : b.status === 'REJECTED' || b.status === 'EXPIRED' ? 'error' : 'neutral'}">${icon(b.status === 'CONFIRMED' ? 'check-circle' : 'info', 20, 2.2)}<span>${
          b.status === 'CONFIRMED' ? html`<b>Payment verified.</b> Approved by ${b.confirmedBy || 'staff'} · ${b.confirmedAt ? dayClock(b.confirmedAt) : ''}.`
            : b.status === 'REJECTED' ? html`<b>Proof rejected</b> by ${b.rejectedBy || 'staff'} · ${b.rejectedAt ? dayClock(b.rejectedAt) : ''}. Waiting for new proof${b.holdExpiresAt ? ` until ${clock(b.holdExpiresAt)}` : ''}.`
              : b.status === 'EXPIRED' && b.rejectedAt ? html`<b>Proof rejected</b> by ${b.rejectedBy || 'staff'}; the slot was released.`
                : html`This booking is <b>${b.status.toLowerCase().replace('_', ' ')}</b> — nothing to verify.`
        }</span></p>` : ''}
        ${(d.credit?.disruptions || []).filter((x) => x.outcome === 'deferred').map((x) => html`<p class="banner warn" role="status">${icon('calendar-x', 20, 2.2)}<span><b>This time is closed · ${x.reason}.</b> Verify the payment as usual: approving cancels the booking and gives ${firstName(b.user.name)} the value as booking credit. Rejecting leaves nothing to credit.</span></p>`)}
        <div class="cols c-420">
          <div class="stack stack-16">
            <section class="panel panel-body stack stack-8"><p class="eyebrow">Booking verification</p>
              <dl class="kv">
                <div><dt>Customer</dt><dd><a href="${BASE}/bookings/${b.id}">${b.user.name}</a></dd></div>
                <div><dt>Account</dt><dd>${memberTag(b.user.membership, { small: true })}</dd></div>
                <div><dt>Activity</dt><dd>${b.activityLabel}</dd></div>
                <div><dt>Resource</dt><dd>${b.resource.name}</dd></div>
                <div><dt>Date</dt><dd>${monthDayYear(b.date)}</dd></div>
                <div><dt>Time</dt><dd>${bookingTime(b, { full: true })}${b.durationMin > 60 ? ` · ${b.durationLabel}` : ''}</dd></div>
                <div><dt>Amount due</dt><dd class="mono big-amt">${b.amountLabel}</dd></div>
              </dl></section>
            <section class="panel panel-body stack stack-8"><p class="eyebrow">What ${first} submitted</p>
              ${p ? html`<dl class="kv">
                <div><dt>Method</dt><dd>${p.paymentMethodName || b.paymentMethodName || 'GCash'}</dd></div>
                ${p.accountName ? html`<div><dt>Account name</dt><dd>${p.accountName}</dd></div>` : ''}
                ${p.accountNumber ? html`<div><dt>Account number</dt><dd class="mono">${p.accountNumber}</dd></div>` : ''}
                <div><dt>Payment reference</dt><dd class="row" data-gap="6"><span class="mono">${p.gcashRef || 'Not provided'}</span>${p.gcashRef ? html`<button type="button" class="icon-btn sm flat" data-copy="${p.gcashRef}" aria-label="Copy reference">${icon('copy', 16)}</button>` : ''}</dd></div>
                <div><dt>Amount paid</dt><dd class="row" data-gap="8"><span class="mono">${p.amountClaimedLabel || '—'}</span>${amountPill(p.amountCheck)}</dd></div>
                <div><dt>Submitted</dt><dd>${dayClock(p.createdAt)}</dd></div>
              </dl>
              <p class="small">These are the details ${first} typed. Match them against the screenshot and your payment history before approving.</p>` : html`<p class="small">No payment proof yet.</p>`}
            </section>
            <section class="panel panel-body stack stack-4 checklist-panel" data-checklist>
              <div class="row row-between"><p class="eyebrow">Before you approve <span class="req" aria-hidden="true">*</span></p><span class="small" data-checked aria-live="polite"></span></div>
              ${!decided ? html`<p class="small">Required · tick every check before approving.</p>` : ''}
              ${checks.map((c, i) => html`<label class="check-toggle"><input type="checkbox" data-check="${i}" ${ticked.has(i) ? 'checked' : ''} ${decided ? 'disabled' : ''}><span>${c}</span></label>`)}
            </section>
          </div>
          <div class="stack stack-16">
            <section class="panel panel-body stack stack-12">
              <div class="row row-between row-wrap"><p class="eyebrow">Payment proof</p>${p ? html`<span class="mono small">${p.fileName || 'screenshot'} · ${bytes(p.size)}</span>` : ''}</div>
              ${p ? html`<div class="row row-wrap" data-gap="8">${zoomTools()}<button type="button" class="btn btn-dark btn-xs" data-act="full">${icon('fullscreen', 16)}View full image</button></div>
                <div class="proof-stage" data-stage><span class="stage-chip">${icon('lock', 12, 2.4)}Private · signed link expires in 5–10 min</span><img src="${p.url}" alt="Payment screenshot from ${b.user.name}" draggable="false"></div>` : html`<div class="empty"><p class="empty-body">No screenshot uploaded.</p></div>`}
              ${d.proofs.length > 1 ? html`<p class="small">Earlier proofs: ${d.proofs.slice(1).map((x) => `${dayClock(x.createdAt)} (${x.status})`).join(' · ')}</p>` : ''}
            </section>
            <div data-chat-slot></div>
          </div>
        </div>
      </div>
      ${!decided ? html`<div class="decision-bar"><p data-decision-note></p><div class="btns"><button type="button" class="btn btn-danger-outline" data-act="reject">Reject payment</button><button type="button" class="btn btn-primary" data-act="approve" aria-describedby="decision-note">Approve payment</button></div></div>`
        : html`<div class="decision-bar"><p>${b.status === 'CONFIRMED' ? 'Decision recorded.' : 'Nothing to decide right now.'}</p><div class="btns"><a class="btn btn-dark" href="${BASE}/verify" data-next>Back to queue</a></div></div>`}`);
    for (const a of body.querySelectorAll('[data-back]')) {
      listen(a, 'click', (e) => {
        if (history.state && history.state.depth > 0) {
          e.preventDefault();
          history.back();
        }
      });
    }
    if (!chat) chat = miniChat({ bookingId: b.id, playerName: b.user.name, unread: d.unreadMessages });
    chat.setUnread(d.unreadMessages);
    chat.mount($('[data-chat-slot]', body));
    syncChecklist();
    stopStageKeys();
    const stage = $('[data-stage]', body);
    if (stage) {
      const ctl = attachStage(stage, $('img', stage), $('[data-zv]', body));
      const off = on(body, 'click', '[data-z]', (_e, btn) => ({ in: ctl.zoomIn, out: ctl.zoomOut, fit: ctl.fit, rotate: ctl.rotate })[btn.dataset.z]());
      stopStageKeys = off;
    }
    if (decided) {
      nextPending(b.id).then((next) => {
        const a = body.querySelector('[data-next]');
        if (a && next) {
          a.setAttribute('href', `${BASE}/verify/${next.id}`);
          a.textContent = `Next payment · ${state.badges.pendingVerification || 1} left`;
        }
      });
    }
  }

  /** Approve stays off until every checklist item is ticked. */
  function syncChecklist() {
    const total = $$('[data-check]', body).length;
    const done = ticked.size >= total && total > 0;
    const count = $('[data-checked]', body);
    if (count) count.textContent = `${ticked.size} of ${total} checked`;
    $('[data-checklist]', body)?.classList.toggle('complete', done);
    const approve = $('.decision-bar [data-act="approve"]', body);
    if (approve) approve.disabled = !done;
    const note = $('[data-decision-note]', body);
    if (note) {
      note.id = 'decision-note';
      note.textContent = done
        ? `Your decision notifies ${firstName(d.booking.user.name)} right away and is recorded with your name.`
        : `Tick all ${total} checks under "Before you approve" to approve. ${total - ticked.size} left.`;
    }
  }

  on(body, 'change', '[data-check]', (_e, box) => {
    const i = Number(box.dataset.check);
    if (box.checked) ticked.add(i);
    else ticked.delete(i);
    syncChecklist();
  });
  on(body, 'click', '[data-copy]', async (_e, btn) => {
    if (await copyText(btn.dataset.copy)) toast('Reference copied');
  });
  on(body, 'click', '[data-act="approve"]', (_e, btn) => {
    if (btn.disabled || ticked.size < checklistItems(d.booking, d.proofs[0]).length) {
      $('[data-checklist]', body)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      return;
    }
    openApprove(d.booking, proofWithCheck(), load, { checklistDone: true });
  });
  on(body, 'click', '[data-act="reject"]', () => openReject(d.booking, proofWithCheck(), load));
  on(body, 'click', '[data-act="full"]', () => openViewer({
    url: d.proofs[0].url,
    booking: d.booking,
    proof: proofWithCheck(),
    onDecision: load,
    checklistDone: ticked.size >= checklistItems(d.booking, d.proofs[0]).length,
  }));

  function proofWithCheck() {
    const p = d.proofs[0];
    return p ? { ...p, amountCheck: p.amountCheck, submittedAt: p.createdAt } : null;
  }

  async function load() {
    try {
      d = await api.get(`${API}/bookings/${encodeURIComponent(id)}`);
      paint();
    } catch (err) {
      render(body, html`<div class="page">${errorState(err, { title: err.status === 404 ? 'Booking not found' : undefined, retry: err.status !== 404 })}</div>`);
      listen($('[data-act="retry"]', body), 'click', load);
    }
  }
  await load();
  return () => {
    stopStageKeys();
    chat?.destroy();
  };
}

