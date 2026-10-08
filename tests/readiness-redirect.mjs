import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localTarget, loginReturnTarget } from '../public/js/core/navigation.js';
import { createRouter } from '../public/js/core/router.js';

const origin = 'https://hub.example.invalid';
const malicious = [
  '/\\audit-redirect.invalid', '//audit-redirect.invalid', '///audit-redirect.invalid',
  '/%5caudit-redirect.invalid', '/%255Caudit-redirect.invalid', '/%25255caudit-redirect.invalid',
  '\\audit-redirect.invalid', 'https://audit-redirect.invalid/profile',
  'https://hub.example.invalid.attacker.invalid/profile', 'javascript:alert(1)', 'data:text/html,test',
  'https://user@hub.example.invalid/profile', 'https://user:password@hub.example.invalid/profile',
  'https://hub.example.invalid:444/profile', 'http://hub.example.invalid/profile',
  '/\taudit-redirect.invalid', '/\naudit-redirect.invalid', '/\raudit-redirect.invalid', '/\u0000profile',
  '/profile?value=%09', '/profile?value=%250a', '/profile#%5c', '/profile?value=%7f',
  ' /profile', '/profile ', '/profile\u007f', '/profile//', '/%2fprofile', '/%252fprofile',
  '/profile/../admin/', '/admin/../profile', '/%2e%2e/profile', '/profile/.',
  '/profile/%2e%2e/profile', '/profile/%252e%252e/profile', '/bookings/%', '/bookings/%ff',
  null, undefined, {}, 42, '', 'profile', '?next=/profile', '#profile',
];

test('untrusted URL syntax is rejected before browser normalization', () => {
  for (const target of malicious) assert.equal(localTarget(target, { origin }), null, String(target));
});

for (const portal of ['player', 'admin', 'staff']) {
  test(`${portal} malicious login returns use its local fallback`, () => {
    const fallback = portal === 'player' ? '/' : `/${portal}/`;
    for (const target of malicious) assert.equal(loginReturnTarget(target, { origin, portal }), fallback, String(target));
  });
}

test('local absolute URLs require exact origin and become root-relative', () => {
  assert.equal(localTarget(origin + '/profile?tab=account#password', { origin }), '/profile?tab=account#password');
  assert.equal(localTarget('https://hub.example.invalid:443/profile', { origin }), '/profile');
  assert.equal(localTarget(origin.toUpperCase() + '/profile', { origin }), '/profile');
  assert.equal(localTarget('https://hub.example.invalid./profile', { origin }), null);
  assert.equal(localTarget('https://[::1]:8799/profile', { origin: 'https://[::1]:8799' }), '/profile');
  assert.equal(localTarget('https://[::1]:8798/profile', { origin: 'https://[::1]:8799' }), null);
});

test('legitimate player routes preserve query strings and fragments', () => {
  for (const path of ['/', '/welcome', '/sports-rates', '/court-calendar', '/book', '/book/badminton',
    '/book/badminton/2026-10-07', '/book/badminton/2026-10-07/court-1',
    '/book/badminton/2026-10-07/court-1/480,540', '/bookings', '/bookings/id',
    ...['held','pay','gcash','submitted','confirmed','cancelled','chat'].map(action => '/bookings/id/' + action),
    '/notifications', '/profile', '/credits', '/credits/id']) {
    const target = path + '?label=court%20one&date=2026-10-07#details';
    assert.equal(loginReturnTarget(target, { origin }), target);
    assert.equal(loginReturnTarget(origin + target, { origin }), target);
  }
});

test('player returns exclude authentication loops, other portals and non-view paths', () => {
  for (const target of ['/login', '/register', '/%6cogin', '/admin/', '/staff/', '/revenue/',
    '/api/auth/logout', '/js/player/app.js', '/unknown', '/book/a/b/c/d/e', '/bookings/id/unknown']) {
    assert.equal(loginReturnTarget(target, { origin }), '/', target);
  }
});

test('console returns require the correct portal and enforce admin-only paths', () => {
  for (const portal of ['admin','staff']) {
    const base = `/${portal}`;
    for (const suffix of ['/', '/verify', '/verify/id', '/bookings', '/bookings/new', '/bookings/id',
      '/messages', '/messages/id', '/notifications', '/disruptions', '/disruptions/new',
      '/disruptions/id', '/credits', '/credits/id', '/calendar', '/facilities', '/availability', '/profile', '/more']) {
      const target = base + suffix + '?filter=pending#details';
      assert.equal(loginReturnTarget(target, { origin, portal }), target);
    }
    for (const target of ['/profile', '/administer/profile', '/staffing/profile', '/api/staff/bookings',
      base + '/login', base + '/unknown', `/${portal === 'staff' ? 'admin' : 'staff'}/profile`]) {
      assert.equal(loginReturnTarget(target, { origin, portal }), base + '/');
    }
  }
  assert.equal(loginReturnTarget('/revenue/?from=2026-01-01#totals', { origin, portal:'admin' }), '/revenue/?from=2026-01-01#totals');
  assert.equal(loginReturnTarget('/revenue/../staff/', { origin, portal:'admin' }), '/admin/');
  assert.equal(loginReturnTarget('/revenue/extra', { origin, portal:'admin' }), '/admin/');
  assert.equal(loginReturnTarget('/admin/settings', { origin, portal:'admin' }), '/admin/settings');
  assert.equal(loginReturnTarget('/admin/staff?q=staff#accounts', { origin, portal:'admin' }), '/admin/staff?q=staff#accounts');
  assert.equal(loginReturnTarget('/admin/staff', { origin, portal:'staff' }), '/staff/');
  assert.equal(loginReturnTarget('/staff/staff', { origin, portal:'staff' }), '/staff/');
  assert.equal(loginReturnTarget('/staff/settings', { origin, portal:'staff' }), '/staff/');
  assert.equal(loginReturnTarget('/revenue/', { origin, portal:'staff' }), '/staff/');
});

test('encoded query values remain usable and never become navigation syntax', () => {
  const target = '/profile?message=a%2Fb%3Fc%23d&return=%2Fbookings%3Ffilter%3Dopen#account';
  assert.equal(loginReturnTarget(target, { origin }), target);
});

test('router invalid targets never assign location and use the local home', async () => {
  const saved = Object.fromEntries(['document','window','location','history'].map(key => [key,globalThis[key]]));
  globalThis.document = new EventTarget(); document.getElementById = () => null;
  globalThis.window = new EventTarget(); window.scrollTo = () => {};
  globalThis.location = { href:origin + '/profile', origin };
  globalThis.history = { state:{}, replaceState(state,_,path) { this.state=state; location.href=new URL(path,origin).href; },
    pushState(state,_,path) { this.replaceState(state,_,path); } };
  try {
    for (const base of ['', '/admin', '/staff']) {
      const router = createRouter({ base, routes:[{path:'/',view(){}},{path:'/profile',view(){}}],
        ignore:base ? [] : ['/admin','/staff','/api/'], notFound(){} });
      try {
        for (const target of [...malicious, ...(base ? [base + 'ister/profile', '/profile'] : ['/admin/profile','/staff/profile','/api/auth/session'])]) {
          await router.navigate(target);
          assert.equal(location.href, origin + base + '/', String(target));
        }
        await router.navigate(origin + base + '/profile?tab=account#details');
        assert.equal(location.href, origin + base + '/profile?tab=account#details');
      } finally { router.dispose(); }
    }
  } finally { for (const [key,value] of Object.entries(saved)) { if(value===undefined)delete globalThis[key];else globalThis[key]=value; } }
});
