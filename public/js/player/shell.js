import { api } from '../core/api.js';
import { $, fragment, html, render, mount } from '../core/dom.js';
import { sessionState } from '../core/lifecycle.js';
import { getLogout } from '../core/logout.js';
import { initials } from '../core/format.js';
import { icon, logo } from '../core/icons.js';
import { openModal, poll } from '../core/ui.js';

/** App-wide state for the player shell. */
export const state = sessionState({
  user: null,
  facility: null,
  badges: { notifications: 0, chats: 0, holds: [] },
  router: null,
}, () => {
  state.badges = { notifications: 0, chats: 0, holds: [] };
  badgesInFlight = null;
});

export const main = () => document.getElementById('main');
export const logout = () => getLogout().start();

export function navigate(to, opts) {
  return state.router.navigate(to, opts);
}

export function goBack(fallback) {
  state.router.back(fallback);
}

// ── Chrome: bottom tab bar (mobile) and top nav (desktop) ──────────────────

const TABS = [
  { key: 'home', label: 'Home', href: '/', icon: 'home' },
  { key: 'bookings', label: 'Bookings', href: '/bookings', icon: 'ticket' },
  { key: 'book', label: 'Book', href: '/book', icon: 'plus' },
  { key: 'alerts', label: 'Alerts', href: '/notifications', icon: 'bell' },
  { key: 'profile', label: 'Profile', href: '/profile', icon: 'user' },
];

let currentTab = null;

export function setChrome({ tab = null, nav = false } = {}) {
  currentTab = tab;
  const tabbar = document.getElementById('tabbar');
  const topnav = document.getElementById('topnav');
  document.body.classList.toggle('nav-on', nav);
  tabbar.hidden = !nav;
  topnav.hidden = !nav || !state.user;
  if (nav) {
    renderTabbar();
    renderTopnav();
  }
}

function renderTabbar() {
  const n = state.badges.notifications;
  render(
    document.getElementById('tabbar'),
    html`${TABS.map((t) => {
      if (t.key === 'book') {
        return html`<a class="tab book" href="${t.href}" aria-label="Book a court or table"><span class="tab-pill">${icon('plus', 22, 2.2)}</span>Book</a>`;
      }
      const current = currentTab === t.key;
      const label = t.key === 'alerts' && n > 0 ? `Alerts, ${n} unread` : t.label;
      return html`<a class="tab" href="${t.href}" ${current ? html`aria-current="page"` : ''} aria-label="${label}"><span class="tab-pill">${icon(t.icon, 22)}${t.key === 'alerts' && n > 0 ? html`<span class="badge" aria-hidden="true">${n > 99 ? '99+' : n}</span>` : ''}</span>${t.label}</a>`;
    })}`,
  );
}

function renderTopnav() {
  const u = state.user;
  if (!u) return;
  const n = state.badges.notifications;
  const pills = [
    { key: 'home', label: 'Home', href: '/' },
    { key: 'book', label: 'Book', href: '/book' },
    { key: 'bookings', label: 'My bookings', href: '/bookings' },
  ];
  render(
    document.getElementById('topnav'),
    html`<a class="brand" href="/" aria-label="Le Spinners home">${logo(38)}<span class="brand-name">Le Spinners</span></a>
      <nav class="nav-pills" aria-label="Main">${pills.map((p) => html`<a class="nav-pill" href="${p.href}" ${currentTab === p.key ? html`aria-current="page"` : ''}>${p.label}</a>`)}</nav>
      <div class="nav-right">
        <a class="icon-btn" href="/notifications" aria-label="${n > 0 ? `Notifications, ${n} unread` : 'Notifications'}">${icon('bell', 21)}${n > 0 ? html`<span class="badge" aria-hidden="true">${n}</span>` : ''}</a>
        <a class="profile-chip" href="/profile"><span class="avatar sm">${initials(u.name)}</span>${u.name.split(' ')[0]}</a>
      </div>`,
  );
}

/** Bell with unread badge, used in page headers. */
export function bellButton() {
  const n = state.badges.notifications;
  return html`<a class="icon-btn" href="/notifications" data-bell aria-label="${n > 0 ? `Notifications, ${n} unread` : 'Notifications'}">${icon('bell', 21)}${n > 0 ? html`<span class="badge" aria-hidden="true">${n}</span>` : ''}</a>`;
}

function refreshBells() {
  for (const el of document.querySelectorAll('[data-bell]')) {
    const replacement = fragment(bellButton()).firstElementChild;
    el.replaceWith(replacement);
  }
}

// ── Badges polling ─────────────────────────────────────────────────────────

let stopBadges = null;
const badgeListeners = new Set();

export function onBadges(fn) {
  badgeListeners.add(fn);
  return () => badgeListeners.delete(fn);
}

let badgesInFlight = null;
export async function refreshBadges({ polling = false } = {}) {
  if (!state.user) return;
  if (!badgesInFlight) {
    const task = fetchBadges().finally(() => { if (badgesInFlight === task) badgesInFlight = null; });
    badgesInFlight = task;
  }
  try { await badgesInFlight; }
  catch (err) { if (polling) throw err; }
}

async function fetchBadges() {
  if (!state.user) return;
  try {
    const b = await api.get('/api/notifications/badges', { scope: null });
    const changed = b.notifications !== state.badges.notifications || b.chats !== state.badges.chats;
    state.badges = b;
    if (changed) {
      if (!document.getElementById('tabbar').hidden) renderTabbar();
      if (!document.getElementById('topnav').hidden) renderTopnav();
      refreshBells();
    }
    for (const fn of badgeListeners) fn(b);
  } catch (err) { throw err; }
}

export function startBadges() {
  if (stopBadges) return;
  stopBadges = poll(() => refreshBadges({ polling: true }), 60_000, { immediate: true });
}

export function stopBadgePolling() {
  if (stopBadges) stopBadges();
  stopBadges = null;
}

// ── Headers ────────────────────────────────────────────────────────────────

/** Booking wizard header: "Step n of 5 · Label" + progress bar. */
export function wizardHeader({ step, label, sub, backHref, closeable = true, total = 5 }) {
  return html`<header class="wiz-head">
    <div class="wiz-row">
      ${backHref ? html`<a class="icon-btn" href="${backHref}" data-back aria-label="Back">${icon('chevron-left', 22, 2.2)}</a>` : html`<span class="icon-btn ghost" aria-hidden="true"></span>`}
      <div class="grow"><span class="wiz-step">Step ${step} of ${total} · ${label}</span><span class="wiz-sub">${sub}</span></div>
      ${closeable ? html`<a class="icon-btn" href="/" aria-label="Close booking">${icon('x', 20, 2.2)}</a>` : html`<span class="icon-btn ghost" aria-hidden="true"></span>`}
    </div>
    <div class="progress" role="progressbar" aria-label="Booking step ${step} of ${total}" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="${step}">
      ${Array.from({ length: total }, (_, i) => html`<span class="${i + 1 < step ? 'done' : i + 1 === step ? 'current' : ''}"></span>`)}
    </div>
  </header>`;
}

/** White sticky header for sub-pages (booking details, payment, chat). */
export function subHeader({ backHref, backLabel = 'Back', title, sub, subMono = false, right = '', below = '' }) {
  return html`<header class="sub-head">
    <div class="sub-head-inner">
      <a class="icon-btn flat" href="${backHref}" data-back aria-label="${backLabel}">${icon('chevron-left', 22, 2.2)}</a>
      <div class="grow">${sub && !subMono ? html`<div class="t1">${sub}</div>` : ''}<div class="t2">${title}</div>${sub && subMono ? html`<div class="t-ref">${sub}</div>` : ''}</div>
      ${right}
    </div>
    ${below ? html`<div class="cd-slot">${below}</div>` : ''}
  </header>`;
}

/** Wires [data-back] links to history.back() when there is in-app history. */
export function wireBack(root) {
  for (const a of root.querySelectorAll('a[data-back]')) {
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      goBack(a.getAttribute('href'));
    });
  }
}

/** Standard screen render: sets chrome, renders, wires back links. */
export function show(template, { tab = null, nav = false } = {}) {
  setChrome({ tab, nav });
  const el = mount(main(), template);
  wireBack(el);
  return el;
}

// ── Session expired (S10) ──────────────────────────────────────────────────

let sessionDialogOpen = false;

export function showSessionExpired() {
  if (sessionDialogOpen) return;
  sessionDialogOpen = true;
  const next = location.pathname + location.search + location.hash;
  state.user = null;
  stopBadgePolling();
  state.router.navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
  openModal({
    role: 'alertdialog',
    label: 'Please sign in again',
    locked: () => true,
    onClose: () => (sessionDialogOpen = false),
    content: (close) => html`<span class="tile blue">${icon('lock', 24)}</span>
      <h2 class="dialog-title">Please sign in again</h2>
      <p class="body">Your session ended after some time without activity. This keeps your bookings and payment proofs private on shared phones.</p>
      <p class="banner neutral compact">${icon('check-circle', 18, 2.2)}<span>Nothing is lost. Bookings, holds and uploaded proofs are saved on our side.</span></p>
      <div class="dialog-actions">
        <a class="btn btn-primary btn-block" href="/login?next=${encodeURIComponent(next)}" data-session-signin>Sign in</a>
        <a class="btn btn-text btn-block" href="/login" data-session-signin>Use a different account</a>
      </div>`,
    onOpen: (panel, m) => {
      for (const a of panel.querySelectorAll('[data-session-signin]')) {
        a.addEventListener('click', () => {
          sessionDialogOpen = false;
          m.close();
        });
      }
    },
  });
}

export function logoMark(size = 38, inverse = false) {
  return logo(size, inverse);
}

export function $main(sel) {
  return $(sel, main());
}
