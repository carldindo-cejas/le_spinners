import { api, onUnauthorized } from '../core/api.js';
import { createRouter } from '../core/router.js';
import { html, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/ui.js';
import { main, show, showSessionExpired, startBadges, state } from './shell.js';
import { loginView, registerView } from './screens/auth.js';
import { homeView } from './screens/home.js';
import { activityStep, dateStep, resourceStep, timeStep, reviewStep } from './screens/book.js';
import { heldView, payView, gcashView, submittedView } from './screens/pay.js';
import { bookingView, confirmedView, cancelledView } from './screens/booking.js';
import { bookingsView } from './screens/bookings.js';
import { chatView } from './screens/chat.js';
import { notificationsView } from './screens/notifications.js';
import { profileView } from './screens/profile.js';
import { creditDetailView, creditsView } from './screens/credits.js';

const HOME = { player: '/', staff: '/staff/', admin: '/admin/' };
const isPlayer = (u) => Boolean(u) && u.role === 'player';

/** Views that need a signed-in player. Staff and admin accounts can't book (the API refuses them too). */
function guarded(view) {
  return (ctx) => {
    if (!state.user) {
      const next = ctx.path + (location.search || '');
      state.router.navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
      return undefined;
    }
    if (!isPlayer(state.user)) return wrongAccountView();
    return view(ctx);
  };
}

/** Sign-in pages: a signed-in account goes to its own dashboard instead. */
function publicOnly(view) {
  return (ctx) => {
    if (state.user) {
      if (isPlayer(state.user)) state.router.navigate('/', { replace: true });
      else location.replace(HOME[state.user.role] || '/');
      return undefined;
    }
    return view(ctx);
  };
}

function wrongAccountView() {
  const u = state.user;
  const consoleName = u.role === 'admin' ? 'admin console' : 'staff console';
  const root = show(html`<div class="screen">
    <div class="empty">
      <span class="tile blue lg">${icon('lock', 26)}</span>
      <p class="empty-title">You're signed in to the ${consoleName}</p>
      <p class="empty-body">${u.email} is a ${u.role === 'admin' ? 'administrator' : 'staff'} account. Booking courts and tables needs a player account.</p>
      <a class="btn btn-primary btn-md" href="${HOME[u.role]}" data-native>Open the ${consoleName}</a>
      <button class="btn btn-secondary btn-md" type="button" data-act="switch">Sign out and use a player account</button>
    </div>
  </div>`);
  root.querySelector('[data-act="switch"]').addEventListener('click', async () => {
    await api.post('/api/auth/logout').catch(() => {});
    state.user = null;
    state.router.navigate('/login', { replace: true });
  });
}

function notFoundView() {
  show(html`<div class="screen">
    <div class="empty">
      <span class="tile blue lg">${icon('info', 26)}</span>
      <p class="empty-title">This page doesn't exist</p>
      <p class="empty-body">The link may be old. Your bookings are safe.</p>
      <a class="btn btn-primary btn-md" href="/">Back to home</a>
    </div>
  </div>`);
}

const routes = [
  { path: '/login', view: publicOnly(loginView) },
  { path: '/register', view: publicOnly(registerView) },
  { path: '/', view: guarded(homeView) },
  { path: '/book', view: guarded(activityStep) },
  { path: '/book/:activity', view: guarded(dateStep) },
  { path: '/book/:activity/:date', view: guarded(resourceStep) },
  { path: '/book/:activity/:date/:resourceId', view: guarded(timeStep) },
  { path: '/book/:activity/:date/:resourceId/:start', view: guarded(reviewStep) },
  { path: '/bookings', view: guarded(bookingsView) },
  { path: '/bookings/:id', view: guarded(bookingView) },
  { path: '/bookings/:id/held', view: guarded(heldView) },
  { path: '/bookings/:id/pay', view: guarded(payView) },
  { path: '/bookings/:id/gcash', view: guarded(gcashView) },
  { path: '/bookings/:id/submitted', view: guarded(submittedView) },
  { path: '/bookings/:id/confirmed', view: guarded(confirmedView) },
  { path: '/bookings/:id/cancelled', view: guarded(cancelledView) },
  { path: '/bookings/:id/chat', view: guarded(chatView) },
  { path: '/notifications', view: guarded(notificationsView) },
  { path: '/profile', view: guarded(profileView) },
  { path: '/credits', view: guarded(creditsView) },
  { path: '/credits/:id', view: guarded(creditDetailView) },
];

function watchConnection() {
  const strip = document.getElementById('offline-strip');
  const update = () => {
    const offline = navigator.onLine === false;
    strip.hidden = !offline;
    if (offline) render(strip, html`${icon('wifi-off', 20, 2.2)}<span><b>You're offline</b> · booking and live availability need internet.</span>`);
  };
  window.addEventListener('online', () => {
    update();
    toast('Back online', { sub: 'Live availability is on again.' });
  });
  window.addEventListener('offline', update);
  update();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version is ready', {
            type: 'info',
            timeout: 0,
            action: {
              label: 'Refresh',
              onClick: () => {
                // Never reload in the middle of paying or uploading.
                if (/\/(pay|gcash)$/.test(location.pathname)) {
                  toast('Refresh after you submit your payment proof.', { type: 'info' });
                  return;
                }
                worker.postMessage('skipWaiting');
              },
            },
          });
        }
      });
    });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

async function boot() {
  onUnauthorized(() => {
    if (state.user) showSessionExpired();
  });
  watchConnection();
  try {
    const [me, facility] = await Promise.all([
      api.get('/api/auth/session', { quiet401: true }),
      api.get('/api/facility'),
    ]);
    state.user = me.user;
    state.facility = facility;
  } catch (err) {
    state.user = null;
    if (err && err.code === 'NETWORK') {
      main().innerHTML = '';
      show(html`<div class="screen"><div class="page-error" role="alert"><span class="tile red lg">${icon('wifi-off', 26)}</span><p class="h3">Can't reach Le Spinners</p><p class="small">${err.message}</p><button class="btn btn-secondary btn-md" type="button" data-act="reload">${icon('refresh', 18)}Try again</button></div></div>`);
      main().querySelector('[data-act="reload"]').addEventListener('click', () => location.reload());
      return;
    }
  }
  state.router = createRouter({ routes, notFound: notFoundView, ignore: ['/admin', '/staff', '/api/'] });
  if (isPlayer(state.user)) startBadges();
  await state.router.resolve();
  registerServiceWorker();
}

boot();
