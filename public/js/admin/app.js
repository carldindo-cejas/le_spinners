import { api, onUnauthorized } from '../core/api.js';
import { createRouter } from '../core/router.js';
import { html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { bare, frame, showSessionExpired, startBadges, state } from './shell.js';
import { loginView } from './screens/login.js';
import { dashboardView } from './screens/dashboard.js';
import { queueView, verifyDetailView } from './screens/verify.js';
import { bookingsListView, bookingDetailView } from './screens/bookings.js';
import { newBookingView } from './screens/newbooking.js';
import { messagesView } from './screens/messages.js';
import { notificationsView } from './screens/notifications.js';
import { settingsView } from './screens/settings.js';
import { calendarView } from './screens/calendar.js';
import { moreView } from './screens/more.js';
import { facilitiesView } from './screens/facilities.js';
import { availabilityView } from './screens/availability.js';
import { profileView } from './screens/profile.js';
import { revenueView } from './screens/revenue.js';
import { disruptionDetailView, disruptionsView, newDisruptionView } from './screens/disruptions.js';
import { creditDetailView, creditsView } from './screens/credits.js';
import { BASE, CONSOLE, HOME, REVENUE, isAdminConsole } from './console.js';

/**
 * Screens for this console's role only. Staff and admins who open the other
 * console land on the same page in their own (old /admin/ links in emails and
 * bookmarks keep working for staff). The API enforces roles regardless.
 */
function guarded(view) {
  return (ctx) => {
    if (!state.user) {
      state.router.navigate(`${BASE}/login?next=${encodeURIComponent(ctx.path + location.search)}`, { replace: true });
      return undefined;
    }
    if (state.user.role === CONSOLE.role) return view(ctx);
    if (state.user.role === 'staff' && ctx.path.startsWith(REVENUE.slice(0, -1))) return adminOnly();
    if (state.user.role === 'staff' || state.user.role === 'admin') {
      const home = HOME[state.user.role].replace(/\/$/, '');
      const rest = location.pathname.slice(BASE.length);
      const known = state.user.role === 'admin' || !/^\/settings/.test(rest);
      location.replace(known ? home + (rest || '/') + location.search : `${home}/`);
      return undefined;
    }
    return noAccess();
  };
}

function noAccess() {
  bare(html`<div class="page"><div class="empty">
    <span class="tile red lg">${icon('lock', 26)}</span>
    <p class="empty-title">This account can't open the ${CONSOLE.title.toLowerCase()}</p>
    <p class="empty-body">You're signed in as ${state.user.email}, a player account. Player accounts book from the player app.</p>
    <div class="row" data-gap="8"><a class="btn btn-secondary btn-md" href="/" data-native>Go to the player app</a><button type="button" class="btn btn-primary btn-md" data-act="logout">Sign out</button></div>
  </div></div>`);
}

/** Staff opening an admin-only page (the API refuses them too). */
function adminOnly() {
  bare(html`<div class="page"><div class="empty">
    <span class="tile red lg">${icon('lock', 26)}</span>
    <p class="empty-title">Revenue is for administrators</p>
    <p class="empty-body">You're signed in as ${state.user.email}, a staff account. Ask an administrator if you need revenue figures.</p>
    <div class="row" data-gap="8"><a class="btn btn-primary btn-md" href="${HOME.staff}" data-native>Go to the staff console</a></div>
  </div></div>`);
}

function notFound() {
  frame({ key: null, title: 'Not found', template: html`<div class="page"><div class="empty"><p class="empty-title">This page doesn't exist</p><a class="btn btn-primary btn-md" href="${BASE}/">Back to dashboard</a></div></div>` });
}

const routes = [
  { path: '/login', view: loginView },
  { path: '/', view: guarded(dashboardView) },
  { path: '/verify', view: guarded(queueView) },
  { path: '/verify/:id', view: guarded(verifyDetailView) },
  { path: '/bookings', view: guarded(bookingsListView) },
  { path: '/bookings/new', view: guarded(newBookingView) },
  { path: '/bookings/:id', view: guarded(bookingDetailView) },
  { path: '/messages', view: guarded(messagesView) },
  { path: '/messages/:id', view: guarded(messagesView) },
  { path: '/notifications', view: guarded(notificationsView) },
  { path: '/disruptions', view: guarded(disruptionsView) },
  { path: '/disruptions/new', view: guarded(newDisruptionView) },
  { path: '/disruptions/:id', view: guarded(disruptionDetailView) },
  { path: '/credits', view: guarded(creditsView) },
  { path: '/credits/:id', view: guarded(creditDetailView) },
  { path: '/calendar', view: guarded(calendarView) },
  { path: '/facilities', view: guarded(facilitiesView) },
  { path: '/availability', view: guarded(availabilityView) },
  { path: '/profile', view: guarded(profileView) },
  ...(isAdminConsole ? [{ path: '/settings', view: guarded(settingsView) }, { path: REVENUE, absolute: true, view: guarded(revenueView) }] : []),
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
    const me = await api.get('/api/auth/session', { quiet401: true });
    state.user = me.user;
  } catch {
    state.user = null;
  }
  state.router = createRouter({ routes, notFound: guarded(notFound), base: BASE });
  if (state.user && state.user.role === CONSOLE.role) startBadges();
  await state.router.resolve();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

boot();
