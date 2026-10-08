import { $, $$, applyDynamic, fragment, html, on } from './dom.js';
import { icon } from './icons.js';
import { clock, mmss } from './format.js';
import { createScope, currentScope, setElementScope } from './lifecycle.js';

// ── Status pills ────────────────────────────────────────────────────────────

export const STATUS = {
  TEMPORARY: { label: 'Temporary hold', icon: 'hourglass' },
  PAYMENT_SUBMITTED: { label: 'Payment verification', icon: 'shield-clock' },
  CONFIRMED: { label: 'Confirmed', icon: 'check-circle' },
  REJECTED: { label: 'Proof rejected', icon: 'x-circle' },
  EXPIRED: { label: 'Expired', icon: 'clock-x' },
  CANCELLED: { label: 'Cancelled', icon: 'circle-slash' },
  COMPLETED: { label: 'Completed', icon: 'flag' },
};

export function statusPill(status, { small = false, onBlue = false, noIcon = false } = {}) {
  const s = STATUS[status] || { label: status, icon: 'info' };
  return html`<span class="pill st-${status}${small ? ' sm' : ''}${onBlue ? ' on-blue' : ''}">${noIcon ? '' : icon(s.icon, small ? 12 : 13, 2.4)}${s.label}</span>`;
}

export function memberTag(membership, { small = false } = {}) {
  if (membership === 'member') return html`<span class="tag member${small ? ' sm' : ''}">${small ? '' : icon('check', 13, 2.6)}Member</span>`;
  if (membership === 'pending') return html`<span class="tag pending${small ? ' sm' : ''}">Membership pending</span>`;
  return html`<span class="tag nonmember${small ? ' sm' : ''}">Non-member</span>`;
}

// ── Toasts ──────────────────────────────────────────────────────────────────

let toastHost = null;

export function toast(message, { type = 'success', sub = '', action = null, timeout } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.append(toastHost);
  }
  const ms = timeout ?? (type === 'error' ? 7000 : 4000);
  // Toasts that stay until acted on can also be dismissed (✕, or a sideways swipe).
  const dismissible = ms <= 0 || type === 'error';
  const iconName = { success: 'check', error: 'bang', info: 'shield-clock', warn: 'wifi-off' }[type] || 'check';
  const node = fragment(html`<div class="toast ${type}" role="${type === 'error' ? 'alert' : 'status'}">
    <span class="t-icon">${icon(iconName, 16, 2.6)}</span>
    <div class="t-body">${message}${sub ? html`<small>${sub}</small>` : ''}</div>
    ${action ? (action.href ? html`<a class="t-action" href="${action.href}">${action.label}</a>` : html`<button type="button" class="t-action">${action.label}</button>`) : ''}
    ${dismissible ? html`<button type="button" class="t-close" aria-label="Dismiss">${icon('x', 16, 2.4)}</button>` : ''}
  </div>`).firstElementChild;
  toastHost.append(node);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  };
  const btn = $('.t-action', node);
  if (btn) btn.addEventListener('click', () => {
    if (action.onClick) action.onClick();
    close();
  });
  $('.t-close', node)?.addEventListener('click', close);
  swipeToDismiss(node, close);
  if (ms > 0) setTimeout(close, ms);
  return close;
}

/** Drag a toast sideways (touch or pen) past a third of its width to dismiss it. */
function swipeToDismiss(node, close) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let id = null;
  let swiping = false;
  const reset = () => {
    id = null;
    swiping = false;
    node.classList.remove('dragging');
    node.style.removeProperty('--dx');
  };
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button, a')) return;
    id = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
  });
  node.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    dx = e.clientX - startX;
    if (!swiping) {
      if (Math.abs(e.clientY - startY) > 12 && Math.abs(e.clientY - startY) > Math.abs(dx)) return reset();
      if (Math.abs(dx) < 8) return;
      swiping = true;
      node.setPointerCapture(id);
      node.classList.add('dragging');
    }
    node.style.setProperty('--dx', `${dx}px`);
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    const gone = swiping && Math.abs(dx) > Math.min(120, node.offsetWidth / 3);
    if (gone) {
      node.classList.add(dx > 0 ? 'swiped-right' : 'swiped-left');
      node.classList.remove('dragging');
      id = null;
      close();
    } else reset();
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
}

// ── Dialogs and sheets ──────────────────────────────────────────────────────

const FOCUSABLE = 'a[href], button, input, textarea, select, [tabindex]';
const dialogStack = [];
const visibleControl = (el) => !el.matches(':disabled, [type="hidden"]') && !el.closest('[hidden], [inert]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
function focusableElements(root) { return $$(FOCUSABLE, root).filter((el) => el.tabIndex >= 0 && visibleControl(el)); }

/** Only the top dialog contains keyboard focus, including nested proof decisions. */
export function dialogFocus(panel) {
  const entry = { panel };
  dialogStack.push(entry);
  const isActive = () => dialogStack.at(-1) === entry;
  const focusInitial = () => {
    const items = focusableElements(panel);
    (items.find((el) => el.hasAttribute('autofocus')) || items[0] || panel).focus({ preventScroll: true });
  };
  const key = (e) => {
    if (!isActive() || e.key !== 'Tab') return;
    const items = focusableElements(panel), first = items[0], last = items.at(-1);
    const active = document.activeElement;
    if (!items.length || !panel.contains(active) || active === panel || (e.shiftKey ? active === first : active === last)) {
      e.preventDefault();
      (items.length ? e.shiftKey ? last : first : panel).focus({ preventScroll: true });
    }
  };
  const focus = (e) => { if (isActive() && !panel.contains(e.target)) focusInitial(); };
  document.addEventListener('keydown', key, true);
  document.addEventListener('focusin', focus);
  let disposed = false;
  return { isActive, focusInitial, dispose() {
    if (disposed) return;
    disposed = true;
    dialogStack.splice(dialogStack.indexOf(entry), 1);
    document.removeEventListener('keydown', key, true);
    document.removeEventListener('focusin', focus);
  } };
}

/** Restore an equivalent control after a render; fall back inside the dialog. */
export function preserveFocus(root, render, fallback = null) {
  const active = document.activeElement, owned = root.contains(active);
  const attributes = owned ? [...active.attributes].filter((a) => a.name === 'id' || a.name === 'name' || a.name.startsWith('data-') && a.name !== 'data-css').sort((a, b) => (a.name === 'id' ? 0 : a.name === 'name' ? 2 : 1) - (b.name === 'id' ? 0 : b.name === 'name' ? 2 : 1)) : [];
  render();
  if (!owned) return;
  const items = $$(FOCUSABLE, root).filter(visibleControl);
  const replacement = attributes.map((a) => items.find((el) => el.tagName === active.tagName && el.getAttribute(a.name) === a.value && (a.name !== 'name' || !active.matches('input[type="radio"], input[type="checkbox"]') || el.getAttribute('value') === active.getAttribute('value')))).find(Boolean);
  if (replacement?.matches('[role="tab"], [role="radio"]')) {
    const group = replacement.closest('[role="tablist"], [role="radiogroup"]');
    for (const item of $$('[role="tab"], [role="radio"]', group)) item.tabIndex = item === replacement ? 0 : -1;
  }
  (replacement || fallback || focusableElements(root)[0] || root).focus({ preventScroll: true });
}

/** ARIA radios use arrow selection; tabs use arrow focus and explicit activation. */
export function syncChoiceGroups(root) {
  const selector = '[role="radiogroup"], [role="tablist"]';
  const groups = root.matches?.(selector) ? [root, ...$$(selector, root)] : $$(selector, root);
  for (const group of groups) {
    const radio = group.getAttribute('role') === 'radiogroup';
    const items = $$(`[role="${radio ? 'radio' : 'tab'}"]`, group).filter((el) => el.closest('[role="radiogroup"], [role="tablist"]') === group);
    const eligible = items.filter((el) => !el.matches(':disabled, [aria-disabled="true"]') && !el.closest('[hidden], [inert]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
    const selected = eligible.find((el) => el.getAttribute(radio ? 'aria-checked' : 'aria-selected') === 'true') || eligible[0];
    for (const item of items) item.tabIndex = item === selected ? 0 : -1;
  }
}
export function choiceKeys(e) {
  const group = e.target.closest?.('[role="radiogroup"], [role="tablist"]');
  if (!group) return;
  const radio = group.getAttribute('role') === 'radiogroup';
  const vertical = group.getAttribute('aria-orientation') === 'vertical';
  const forward = radio || vertical ? ['ArrowRight', 'ArrowDown'] : ['ArrowRight'];
  const backward = radio || vertical ? ['ArrowLeft', 'ArrowUp'] : ['ArrowLeft'];
  if (![...forward, ...backward, 'Home', 'End'].includes(e.key)) return;
  const items = $$(`[role="${radio ? 'radio' : 'tab'}"]`, group).filter((el) => !el.matches(':disabled, [aria-disabled="true"]') && visibleControl(el) && el.closest('[role="radiogroup"], [role="tablist"]') === group);
  const index = items.indexOf(document.activeElement);
  if (index < 0) return;
  e.preventDefault();
  const next = items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (forward.includes(e.key) ? 1 : -1) + items.length) % items.length];
  for (const item of items) item.tabIndex = item === next ? 0 : -1;
  next.focus();
  if (radio) next.click();
}
let openCount = 0;
export function lockScroll() {
  let released = false;
  openCount++;
  document.body.style.setProperty('overflow', 'hidden');
  return () => {
    if (released) return;
    released = true;
    if (--openCount <= 0) document.body.style.removeProperty('overflow');
  };
}

/**
 * Opens a modal dialog (or bottom sheet). `content(close)` returns the inner
 * template. Focus is trapped; Esc and scrim clicks close unless `locked()`.
 */
export function openModal({ content, sheet = false, wide = false, label, role = 'dialog', onOpen, onClose, locked = () => false, className = '' }) {
  const parent = currentScope();
  parent?.assertCurrent();
  const scope = createScope(parent);
  const previous = document.activeElement;
  const scrim = document.createElement('div');
  setElementScope(scrim, scope);
  scrim.className = `scrim${sheet ? ' sheet-host' : ''}`;
  const panel = document.createElement('div');
  panel.className = `${sheet ? 'sheet' : 'dialog'}${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`;
  panel.setAttribute('role', role);
  panel.setAttribute('aria-modal', 'true');
  if (label) panel.setAttribute('aria-label', label);
  panel.tabIndex = -1;
  scrim.append(panel);
  const focus = dialogFocus(panel);
  let closed = false;
  let unlock = () => {};

  const close = (result) => {
    if (closed) return;
    closed = true;
    scope.dispose();
    document.removeEventListener('keydown', onKey, true);
    focus.dispose();
    scrim.remove();
    unlock();
    if ((!parent || parent.isCurrent()) && previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    if (onClose) onClose(result);
  };
  scope.own(() => close());

  const renderContent = () => {
    panel.innerHTML = '';
    if (sheet) panel.append(fragment(html`<div class="sheet-handle" aria-hidden="true"></div>`));
    panel.append(fragment(content(close)));
    applyDynamic(panel);
    syncChoiceGroups(panel);
  };

  function onKey(e) {
    if (!focus.isActive()) return;
    if (e.key === 'Escape') {
      if (!locked()) {
        e.preventDefault();
        close();
      }
      return;
    }
  }

  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim && !locked()) close();
  });
  on(panel, 'click', '[data-close]', () => {
    if (!locked()) close();
  });
  try {
    document.addEventListener('keydown', onKey, true);
    panel.addEventListener('keydown', choiceKeys);
    renderContent();
    document.body.append(scrim);
    unlock = lockScroll();
    focus.focusInitial();
    const api = { close, panel, scope, signal: scope.signal, isOpen: () => !closed && scope.isCurrent(), rerender: () => { if (!closed && scope.isCurrent()) preserveFocus(panel, renderContent, panel); } };
    if (onOpen) onOpen(panel, api);
    return api;
  } catch (error) { close(); throw error; }
}

// ── Countdown ───────────────────────────────────────────────────────────────

const RING_48 = 2 * Math.PI * 20; // r=20 in a 48 box
const RING_132 = 2 * Math.PI * 56;

export function ringSvg(size = 48) {
  if (size === 132) {
    return html`<svg viewBox="0 0 132 132" aria-hidden="true"><circle class="rl-fill" cx="66" cy="66" r="56"/><circle class="cd-track" cx="66" cy="66" r="56" fill="none" stroke-width="10"/><circle class="cd-bar" cx="66" cy="66" r="56" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${RING_132.toFixed(2)}" stroke-dashoffset="0" transform="rotate(-90 66 66)"/></svg>`;
  }
  return html`<svg class="cd-ring" viewBox="0 0 48 48" aria-hidden="true"><circle class="cd-track" cx="24" cy="24" r="20" fill="none" stroke-width="5"/><circle class="cd-bar" cx="24" cy="24" r="20" fill="none" stroke-width="5" stroke-linecap="round" stroke-dasharray="${RING_48.toFixed(2)}" stroke-dashoffset="0" transform="rotate(-90 24 24)"/></svg>`;
}

/**
 * Drives every countdown element inside `root`:
 *   [data-countdown] root element gets .warn / .ended classes
 *   [data-cd-time]   text mm:ss
 *   .cd-bar          ring progress (circle)
 * The clock follows the server: `skew` = serverNow − Date.now() at fetch time.
 */
export function startCountdown(root, { expiresAt, serverNow, totalMs = 600_000, warnMs = 120_000, onWarn, onEnd, onTick, announce }) {
  const skew = serverNow ? serverNow - Date.now() : 0;
  let warned = false;
  let ended = false;
  const announced = new Set();
  const tick = () => {
    const left = Math.max(0, expiresAt - (Date.now() + skew));
    const els = $$('[data-countdown]', root);
    for (const el of els) {
      el.classList.toggle('warn', left > 0 && left <= warnMs);
      el.classList.toggle('ended', left <= 0);
    }
    for (const t of $$('[data-cd-time]', root)) t.textContent = mmss(left);
    for (const bar of $$('.cd-bar', root)) {
      const circ = Number(bar.getAttribute('stroke-dasharray'));
      const frac = Math.min(1, Math.max(0, 1 - left / totalMs));
      bar.setAttribute('stroke-dashoffset', String(circ * frac));
    }
    if (announce) {
      for (const mark of [300_000, 120_000, 60_000]) {
        if (left <= mark && left > mark - 1500 && !announced.has(mark)) {
          announced.add(mark);
          announce(`${Math.round(mark / 60_000)} minute${mark === 60_000 ? '' : 's'} left to upload your payment proof.`);
        }
      }
    }
    if (onTick) onTick(left);
    if (!warned && left > 0 && left <= warnMs) {
      warned = true;
      if (onWarn) onWarn(left);
    }
    if (!ended && left <= 0) {
      ended = true;
      if (onEnd) onEnd();
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  const onVisible = () => {
    if (!document.hidden) tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** Countdown panel shown under the header while a hold runs. */
export function countdownPanel({ expiresAt, caption = 'Payment window', resourceName, alwaysAmber = false, line }) {
  return html`<div class="countdown${alwaysAmber ? ' amber-always' : ''}" data-countdown role="timer" aria-live="off" aria-label="Time left to upload your payment proof">
    ${ringSvg(48)}
    <div class="grow stack stack-4">
      <span class="cd-caption"><span class="when-calm">${caption}</span><span class="when-warn">Expiring soon</span><span class="when-ended">Window closed</span></span>
      <span class="cd-line"><span class="when-calm">${line ?? `Slot held until ${clock(expiresAt)}`}</span><span class="when-warn">Slot held until ${clock(expiresAt)}</span><span class="when-ended">Slot released</span></span>
    </div>
    <div class="stack stack-4 shrink-0"><span class="cd-time" data-cd-time>--:--</span><span class="cd-unit when-not-ended">remaining</span></div>
  </div>
  <p class="banner warn compact when-warn-only" role="alert" data-warn-line hidden>${icon('hourglass', 18, 2.2)}<span><b>Your temporary reservation will expire soon.</b> Upload your proof now to keep ${resourceName}.</span></p>`;
}

/** Keeps the "expiring soon" alert line in sync with the countdown state. */
export function syncWarnLine(root, left, warnMs = 120_000) {
  for (const el of $$('[data-warn-line]', root)) el.hidden = !(left > 0 && left <= warnMs);
}

// ── Misc helpers ────────────────────────────────────────────────────────────

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'sr-only';
    (dialogStack.at(-1)?.panel || document.body).append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Shows server validation messages next to fields named like the details keys. */
const errorDescriptions = new WeakMap();
export function showFieldErrors(form, details) {
  clearFieldErrors(form);
  if (!details) return false;
  let first = null;
  for (const [name, messages] of Object.entries(details)) {
    const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (!input) continue;
    const msg = Array.isArray(messages) ? messages[0] : String(messages);
    const id = `err-${name}-${Math.random().toString(36).slice(2, 7)}`;
    const holder = input.closest('.input-group') || input;
    if (holder.classList.contains('input-group')) holder.dataset.invalid = 'true';
    input.setAttribute('aria-invalid', 'true');
    errorDescriptions.set(input, input.getAttribute('aria-describedby'));
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
    const field = input.closest('.field') || holder.parentElement;
    field.append(fragment(html`<p class="field-error" id="${id}" data-field-error>${icon('alert', 16, 2.2)}<span>${msg}</span></p>`));
    if (!first) first = input;
  }
  if (first) first.focus();
  return Boolean(first);
}

export function clearFieldErrors(form) {
  for (const el of $$('[data-field-error]', form)) el.remove();
  for (const el of $$('[aria-invalid="true"]', form)) {
    el.removeAttribute('aria-invalid');
    if (errorDescriptions.has(el)) {
      const description = errorDescriptions.get(el);
      if (description === null) el.removeAttribute('aria-describedby');
      else el.setAttribute('aria-describedby', description);
      errorDescriptions.delete(el);
    }
  }
  for (const el of $$('[data-invalid]', form)) delete el.dataset.invalid;
}

export function errorState(err, { retry = true, title } = {}) {
  const offline = err && err.code === 'NETWORK';
  return html`<div class="page-error" role="alert">
    <span class="tile red lg">${icon(offline ? 'wifi-off' : 'alert', 26)}</span>
    <p class="empty-title h3">${title || (offline ? "Can't reach Le Spinners" : "Something didn't load")}</p>
    <p class="small">${err && err.message ? err.message : 'Please try again.'}</p>
    ${retry ? html`<button type="button" class="btn btn-secondary btn-md" data-act="retry">${icon('refresh', 18)}Try again</button>` : ''}
  </div>`;
}

export function skeletonRows(n = 4, cls = 'sk-row') {
  return html`<div class="stack stack-8" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () => html`<div class="skeleton ${cls}"></div>`)}</div>`;
}

export { poll } from './poll.js';

/** A polite live region for screen-reader announcements. */
let liveRegion = null;
let announceTimer = null;
export function clearSessionMessages() {
  toastHost?.replaceChildren();
  clearTimeout(announceTimer);
  if (liveRegion) liveRegion.textContent = '';
}
export function announce(text) {
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'sr-only';
    liveRegion.setAttribute('aria-live', 'polite');
    document.body.append(liveRegion);
  }
  liveRegion.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => (liveRegion.textContent = text), 50);
}
