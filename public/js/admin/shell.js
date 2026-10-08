import { api } from '../core/api.js';
import { html, render, mount } from '../core/dom.js';
import { sessionState } from '../core/lifecycle.js';
import { getLogout } from '../core/logout.js';
import { initials } from '../core/format.js';
import { icon, logo } from '../core/icons.js';
import { openModal, poll, toast } from '../core/ui.js';
import { API, BASE, CONSOLE, REVENUE, isAdminConsole } from './console.js';

export const state = sessionState({
  user: null,
  router: null,
  badges: { unresolved: 0, unreadNotifications: 0, pendingVerification: 0, activeHolds: 0, unreadChats: 0 },
  settings: null,
}, () => {
  state.settings = null;
  state.alerts = null;
  state.badges = { unresolved: 0, unreadNotifications: 0, pendingVerification: 0, activeHolds: 0, unreadChats: 0 };
  badgesInFlight = null;
  firstBadges = true;
});

export const main = () => document.getElementById('main');
export const navigate = (to, opts) => state.router.navigate(to, opts);
export const goBack = (fallback) => state.router.back(fallback);

// The staff console shows operations and facility screens only; Revenue and Settings are admin-only.
const NAV = [
  {
    group: null,
    items: [
      { key: 'dashboard', label: 'Dashboard', href: `${BASE}/`, icon: 'grid' },
      ...(isAdminConsole ? [{ key: 'revenue', label: 'Revenue', href: REVENUE, icon: 'banknote' }] : []),
    ],
  },
  {
    group: 'Operations',
    items: [
      { key: 'verify', label: 'Payment verification', href: `${BASE}/verify`, icon: 'shield-clock', badge: 'pendingVerification', volt: true },
      { key: 'bookings', label: 'Bookings', href: `${BASE}/bookings`, icon: 'ticket' },
      { key: 'messages', label: 'Messages', href: `${BASE}/messages`, icon: 'chat', badge: 'unreadChats' },
      { key: 'notifications', label: 'Notifications', href: `${BASE}/notifications`, icon: 'bell', badge: 'unresolved' },
      { key: 'disruptions', label: 'Disruptions', href: `${BASE}/disruptions`, icon: 'calendar-x', badge: 'disruptionsOpen' },
      { key: 'credits', label: 'Booking credits', href: `${BASE}/credits`, icon: 'gift' },
    ],
  },
  {
    group: 'Facility',
    items: [
      { key: 'facilities', label: 'Resources', href: `${BASE}/facilities`, icon: 'layers' },
      { key: 'availability', label: 'Availability', href: `${BASE}/availability`, icon: 'calendar-clock' },
      { key: 'calendar', label: 'Calendar', href: `${BASE}/calendar`, icon: 'calendar-grid' },
    ],
  },
  ...(isAdminConsole ? [{ group: 'Admin', items: [{ key: 'settings', label: 'Settings', href: '/admin/settings', icon: 'settings' }] }] : []),
];

const TABS = [
  { key: 'dashboard', label: 'Home', href: `${BASE}/`, icon: 'grid' },
  { key: 'bookings', label: 'Bookings', href: `${BASE}/bookings`, icon: 'ticket' },
  { key: 'verify', label: 'Verify', href: `${BASE}/verify`, icon: 'shield-clock', badge: 'pendingVerification' },
  { key: 'messages', label: 'Messages', href: `${BASE}/messages`, icon: 'chat', badge: 'unreadChats' },
  { key: 'more', label: 'More', href: `${BASE}/more`, icon: 'menu' },
];

let current = { key: null, tabs: true };

function renderSidebar() {
  const u = state.user;
  if (!u) return;
  const b = state.badges;
  render(document.getElementById('sidebar'), html`
    <a class="sb-brand" href="${BASE}/">${logo(38)}<span><span class="n1">Le Spinners</span><br><span class="n2">${CONSOLE.title.toUpperCase()}</span></span></a>
    <nav class="sb-nav" aria-label="${CONSOLE.title}">${NAV.map((g) => html`<div class="sb-group">
      ${g.group ? html`<span class="sb-label">${g.group}</span>` : ''}
      ${g.items.map((it) => {
        const n = it.badge ? b[it.badge] : 0;
        return html`<a class="sb-item" href="${it.href}" ${current.key === it.key ? html`aria-current="page"` : ''}>${icon(it.icon, 20)}<span>${it.label}</span>${n ? html`<span class="sb-count${it.volt ? ' volt' : ''}" aria-label="${n} ${it.key === 'verify' ? 'pending' : 'unread'}">${n}</span>` : ''}</a>`;
      })}
    </div>`)}</nav>
    <div class="sb-foot"><span class="avatar volt sm">${initials(u.name)}</span><a class="who" href="${BASE}/profile" ${current.key === 'profile' ? html`aria-current="page"` : ''} aria-label="My profile: ${u.name}"><b>${u.name}</b><span>${u.role === 'admin' ? 'Administrator' : 'Staff'}</span></a>
      <button type="button" class="icon-btn" data-act="logout" aria-label="Log out">${icon('logout', 20)}</button></div>`);
}

function renderTabbar() {
  const b = state.badges;
  const el = document.getElementById('tabbar');
  el.hidden = !current.tabs;
  if (!current.tabs) return;
  render(el, TABS.map((t) => {
    const n = t.badge ? b[t.badge] : 0;
    const label = t.key === 'verify' && n ? `Verify payments, ${n} pending` : t.key === 'messages' && n ? `Messages, ${n} unread` : t.label;
    return html`<a class="stab" href="${t.href}" ${current.key === t.key ? html`aria-current="page"` : ''} aria-label="${label}"><span class="tab-pill">${icon(t.icon, 22)}${n ? html`<span class="badge" aria-hidden="true">${n}</span>` : ''}</span>${t.label}</a>`;
  }));
}

export function bell({ dark = false } = {}) {
  const n = state.badges.unresolved;
  return html`<a class="icon-btn${dark ? '' : ''}" href="${BASE}/notifications" aria-label="${n ? `Notifications, ${n} unresolved` : 'Notifications'}">${icon('bell', 21)}${n ? html`<span class="badge" aria-hidden="true">${n}</span>` : ''}</a>`;
}

/**
 * Frames a staff screen: sidebar item, desktop top bar and mobile header.
 * `mobileHeader` replaces the default dark header (title + bell) when given.
 */
export function frame({ key, eyebrow = 'Operations', title, actions = '', mobileTitle, mobileHeader, tabs = true, template }) {
  current = { key, tabs };
  document.getElementById('staff-app').classList.add('framed');
  renderSidebar();
  renderTabbar();
  render(document.getElementById('topbar'), html`
    <div class="tb-desktop"><div class="tb-titles"><div class="tb-eyebrow">${eyebrow}</div><h1 class="tb-title">${title}</h1></div><div class="tb-actions">${actions}${bell()}</div></div>
    ${mobileHeader === null ? '' : mobileHeader || html`<div class="tb-mobile"><div class="row row-between"><h1 class="m-title">${mobileTitle || title}</h1>${bell({ dark: true })}</div></div>`}`);
  const el = mount(main(), template);
  return el;
}

/** Full-screen views without the console frame (login). */
export function bare(template) {
  current = { key: null, tabs: false };
  document.getElementById('staff-app').classList.remove('framed');
  document.getElementById('sidebar').innerHTML = '';
  document.getElementById('topbar').innerHTML = '';
  document.getElementById('tabbar').hidden = true;
  const el = mount(main(), template);
  return el;
}

// ── Badges polling + "new payment proof" toast ─────────────────────────────

let stopBadges = null;
let firstBadges = true;
const listeners = new Set();
export const onBadges = (fn) => (listeners.add(fn), () => listeners.delete(fn));

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
    const b = await api.get(`${API}/badges`, { scope: null });
    const prev = state.badges;
    const changed = ['unresolved', 'pendingVerification', 'unreadChats', 'disruptionsOpen'].some((k) => b[k] !== prev[k]);
    if (!firstBadges && b.pendingVerification > prev.pendingVerification && current.key !== 'verify') {
      toast('New payment proof to verify', {
        type: 'info',
        sub: `${b.pendingVerification} waiting for verification`,
        timeout: 0,
        action: { label: 'Review', onClick: () => navigate(`${BASE}/verify`) },
      });
    }
    firstBadges = false;
    state.badges = b;
    if (changed && current.key) {
      renderSidebar();
      renderTabbar();
      for (const a of document.querySelectorAll(`#topbar a[href="${BASE}/notifications"]`)) {
        const n = b.unresolved;
        a.setAttribute('aria-label', n ? `Notifications, ${n} unresolved` : 'Notifications');
        const badge = a.querySelector('.badge');
        if (n && badge) badge.textContent = String(n);
        else if (n && !badge) a.insertAdjacentHTML('beforeend', `<span class="badge" aria-hidden="true">${Number(n)}</span>`);
        else if (!n && badge) badge.remove();
      }
    }
    for (const fn of listeners) fn(b);
  } catch (err) { throw err; }
}

export function startBadges() {
  if (!stopBadges) stopBadges = poll(() => refreshBadges({ polling: true }), 60_000, { immediate: true });
}

export function stopBadgePolling() {
  if (stopBadges) stopBadges();
  stopBadges = null;
  firstBadges = true;
}

export const logout = () => getLogout().start();

document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('[data-act="logout"]') : null;
  if (btn) logout();
});

let sessionOpen = false;
export function showSessionExpired() {
  if (sessionOpen) return;
  sessionOpen = true;
  const next = location.pathname + location.search + location.hash;
  state.user = null;
  stopBadgePolling();
  state.router.navigate(`${BASE}/login?next=${encodeURIComponent(next)}`, { replace: true });
  openModal({
    role: 'alertdialog',
    label: 'Please sign in again',
    locked: () => true,
    onClose: () => (sessionOpen = false),
    content: () => html`<span class="tile blue">${icon('lock', 24)}</span>
      <h2 class="dialog-title">Please sign in again</h2>
      <p class="body">Staff sessions end after 12 hours or when you sign out. Nothing you approved or sent was lost.</p>
      <div class="dialog-actions"><a class="btn btn-primary btn-block" href="${BASE}/login?next=${encodeURIComponent(next)}" data-signin>Sign in</a></div>`,
    onOpen: (panel, m) => panel.querySelector('[data-signin]').addEventListener('click', () => {
      sessionOpen = false;
      m.close();
    }),
  });
}
