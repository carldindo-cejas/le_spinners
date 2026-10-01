import { api, onUnauthorized } from '../core/api.js';
import { createRouter } from '../core/router.js';
import { html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { bare, frame, showSessionExpired, startBadges, state } from './shell.js';
import { loginView } from './screens/login.js';
import { dashboardView } from './screens/dashboard.js';
import { queueView, verifyDetailView } from './screens/verify.js';
import { bookingsListView, bookingDetailView } from './screens/bookings.js';
import { messagesView } from './screens/messages.js';
import { notificationsView } from './screens/notifications.js';
import { settingsView } from './screens/settings.js';
import { calendarView } from './screens/calendar.js';
import { moreView } from './screens/more.js';

const isStaff = (u) => u && (u.role === 'staff' || u.role === 'admin');

function guarded(view) {
  return (ctx) => {
    if (!state.user) {
      state.router.navigate(`/admin/login?next=${encodeURIComponent(ctx.path + location.search)}`, { replace: true });
      return undefined;
    }
    if (!isStaff(state.user)) return noAccess();
    return view(ctx);
  };
}

function noAccess() {
  bare(html`<div class="page"><div class="empty">
    <span class="tile red lg">${icon('lock', 26)}</span>
    <p class="empty-title">This account doesn't have staff access</p>
    <p class="empty-body">You're signed in as ${state.user.email}. Player accounts can't open the staff console.</p>
    <div class="row" data-gap="8"><a class="btn btn-secondary btn-md" href="/" data-native>Go to the player app</a><button type="button" class="btn btn-primary btn-md" data-act="logout">Sign out</button></div>
  </div></div>`);
}

function notFound() {
  frame({ key: null, title: 'Not found', template: html`<div class="page"><div class="empty"><p class="empty-title">This page doesn't exist</p><a class="btn btn-primary btn-md" href="/admin/">Back to dashboard</a></div></div>` });
}

const routes = [
  { path: '/login', view: loginView },
  { path: '/', view: guarded(dashboardView) },
  { path: '/verify', view: guarded(queueView) },
  { path: '/verify/:id', view: guarded(verifyDetailView) },
  { path: '/bookings', view: guarded(bookingsListView) },
  { path: '/bookings/:id', view: guarded(bookingDetailView) },
  { path: '/messages', view: guarded(messagesView) },
  { path: '/messages/:id', view: guarded(messagesView) },
  { path: '/notifications', view: guarded(notificationsView) },
  { path: '/calendar', view: guarded(calendarView) },
  { path: '/settings', view: guarded(settingsView) },
  { path: '/more', view: guarded(moreView) },
];

function watchConnection() {
  const strip = document.getElementById('offline-strip');
  const update = () => {
    strip.hidden = navigator.onLine !== false;
    strip.textContent = "You're offline · the console will refresh when you reconnect.";
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

async function boot() {
  onUnauthorized(() => {
    if (state.user) showSessionExpired();
  });
  watchConnection();
  try {
    const me = await api.get('/api/auth/me', { quiet401: true });
    state.user = me.user;
  } catch {
    state.user = null;
  }
  state.router = createRouter({ routes, notFound, base: '/admin' });
  if (isStaff(state.user)) startBadges();
  await state.router.resolve();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

boot();
