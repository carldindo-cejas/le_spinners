import { $, $$, applyDynamic, fragment, html, on } from './dom.js';
import { icon } from './icons.js';
import { clock, mmss } from './format.js';

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
  const iconName = { success: 'check', error: 'bang', info: 'shield-clock', warn: 'wifi-off' }[type] || 'check';
  const node = fragment(html`<div class="toast ${type}" role="${type === 'error' ? 'alert' : 'status'}">
    <span class="t-icon">${icon(iconName, 16, 2.6)}</span>
    <div class="t-body">${message}${sub ? html`<small>${sub}</small>` : ''}</div>
    ${action ? (action.href ? html`<a class="t-action" href="${action.href}">${action.label}</a>` : html`<button type="button" class="t-action">${action.label}</button>`) : ''}
  </div>`).firstElementChild;
  toastHost.append(node);
  const close = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  };
  const btn = $('.t-action', node);
  if (btn) btn.addEventListener('click', () => {
    if (action.onClick) action.onClick();
    close();
  });
  const ms = timeout ?? (type === 'error' ? 7000 : 4000);
  if (ms > 0) setTimeout(close, ms);
  return close;
}

// ── Dialogs and sheets ──────────────────────────────────────────────────────

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
let openCount = 0;

/**
 * Opens a modal dialog (or bottom sheet). `content(close)` returns the inner
 * template. Focus is trapped; Esc and scrim clicks close unless `locked()`.
 */
export function openModal({ content, sheet = false, wide = false, label, role = 'dialog', onOpen, onClose, locked = () => false, className = '' }) {
  const previous = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = `scrim${sheet ? ' sheet-host' : ''}`;
  const panel = document.createElement('div');
  panel.className = `${sheet ? 'sheet' : 'dialog'}${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`;
  panel.setAttribute('role', role);
  panel.setAttribute('aria-modal', 'true');
  if (label) panel.setAttribute('aria-label', label);
  panel.tabIndex = -1;
  scrim.append(panel);
  let closed = false;

  const close = (result) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    openCount--;
    if (openCount <= 0) document.body.style.removeProperty('overflow');
    if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    if (onClose) onClose(result);
  };

  const renderContent = () => {
    panel.innerHTML = '';
    if (sheet) panel.append(fragment(html`<div class="sheet-handle" aria-hidden="true"></div>`));
    panel.append(fragment(content(close)));
    applyDynamic(panel);
  };

  function onKey(e) {
    if (e.key === 'Escape') {
      if (!locked()) {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key !== 'Tab') return;
    const items = $$(FOCUSABLE, panel).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim && !locked()) close();
  });
  on(panel, 'click', '[data-close]', () => {
    if (!locked()) close();
  });
  document.addEventListener('keydown', onKey, true);
  renderContent();
  document.body.append(scrim);
  openCount++;
  document.body.style.setProperty('overflow', 'hidden');
  const autofocus = $('[autofocus]', panel) || $(FOCUSABLE, panel) || panel;
  autofocus.focus({ preventScroll: true });
  const api = { close, panel, rerender: renderContent };
  if (onOpen) onOpen(panel, api);
  return api;
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
    document.body.append(ta);
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
    input.setAttribute('aria-describedby', id);
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
    el.removeAttribute('aria-describedby');
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

/** Polls `fn` every `ms` while the page is visible. Returns stop(). */
export function poll(fn, ms, { immediate = false } = {}) {
  let timer = null;
  let stopped = false;
  const run = async () => {
    if (stopped || document.hidden) return;
    try {
      await fn();
    } catch (err) {
      console.warn('poll failed', err);
    }
    schedule();
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(run, ms);
  };
  const onVisible = () => {
    if (!document.hidden && !stopped) run();
  };
  document.addEventListener('visibilitychange', onVisible);
  if (immediate) run();
  else schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** A polite live region for screen-reader announcements. */
let liveRegion = null;
export function announce(text) {
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'sr-only';
    liveRegion.setAttribute('aria-live', 'polite');
    document.body.append(liveRegion);
  }
  liveRegion.textContent = '';
  setTimeout(() => (liveRegion.textContent = text), 50);
}
