// Browser races against mocked APIs and a disposable static server. No database or provider access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import { chromium } from 'playwright';
import { postBooking } from '../public/js/core/booking-request.js';
import { api } from '../public/js/core/api.js';

const publicRoot = fileURLToPath(new URL('../public', import.meta.url));
let server, browser, base;
const today = new Date(Date.now() + 480 * 60_000).toISOString().slice(0, 10);
const now = Date.now();
const court = { id: 'court-1', name: 'Synthetic court', activity: 'pickleball', status: 'active', price: 50_000, priceMember: 50_000, priceNonMember: 50_000 };
const table = { ...court, id: 'table-1', name: 'Synthetic table', activity: 'table_tennis' };
const facility = { now, today, tzOffsetMinutes: 480, facility: { name: 'Synthetic hub' }, rules: { slotMinutes: 60, bookingWindowDays: 14, holdMinutes: 10, resubmitMinutes: 10, warnMinutes: 2 }, hours: [], activities: [], resources: [court, table] };
const day = (activity = 'pickleball', slotState = 'available') => ({ now, today, date: today, dateLabel: today, slotMinutes: 60, hours: { open: 600, close: 660, label: '10 AM – 11 AM' }, resources: [{ ...(activity === 'table_tennis' ? table : court), slots: [{ start: 600, end: 660, label: '10 AM', state: slotState }] }] });
const booking = { id: 'synthetic-booking', ref: 'SYNTHETIC', status: 'TEMPORARY', activity: 'pickleball', activityLabel: 'Pickleball', resource: court, user: { id: 'synthetic-player', name: 'Synthetic player', email: 'player@example.invalid' }, date: today, dateLabel: today, start: 600, end: 660, segments: [{ start: 600, end: 660 }], timeLabel: '10 AM – 11 AM', durationMin: 60, durationLabel: '1 hour', amountDue: 50_000, amountLabel: 'PHP 500', rate: 'member', holdExpiresAt: now + 600_000, canSubmitProof: true };

before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = path.resolve(publicRoot, '.' + pathname);
      if (file !== publicRoot && !file.startsWith(publicRoot + path.sep)) { res.writeHead(403).end(); return; }
      if (!path.extname(pathname)) file = path.join(publicRoot, pathname.startsWith('/admin') ? 'admin/index.html' : pathname.startsWith('/staff') ? 'staff/index.html' : 'index.html');
      const data = await fs.readFile(file);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function app(t, role, extra) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.fulfill({ contentType: 'text/css', body: '' }));
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url()), p = url.pathname;
    if (await extra?.(route, url)) return;
    if (p === '/api/auth/session') return route.fulfill({ json: { user: { id: `synthetic-${role}`, role, name: `Synthetic ${role}`, email: `${role}@example.invalid`, membership: 'member' } } });
    if (p === '/api/facility') return route.fulfill({ json: facility });
    if (p.endsWith('/rules')) return route.fulfill({ json: { settings: facility.rules } });
    if (p.endsWith('/badges')) return route.fulfill({ json: { notifications: 0, chats: 0, holds: [], unresolved: 0, pendingVerification: 0 } });
    if (p.endsWith('/schedule') || p === '/api/availability') return route.fulfill({ json: day(url.searchParams.get('activity')) });
    if (p === '/api/bookings/quote') return route.fulfill({ json: { price: 50_000, amountDue: 50_000, creditApplied: 0, personalOverlaps: [] } });
    if (p === '/api/bookings/synthetic-booking') return route.fulfill({ json: { now, booking, actions: {}, proofs: [], timeline: [], payment: { methods: [{ id: 'gcash', name: 'GCash', accountName: 'Synthetic', accountNumber: '09000000000', qrUrl: null, enabled: true }], gcashName: 'Synthetic', gcashNumber: '09000000000', hasQr: false } } });
    return route.fulfill({ json: {} });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No uncaught frontend error'));
  return page;
}

for (const role of ['admin', 'staff']) test(`${role}: late schedule cannot overwrite a newer activity`, async t => {
  let old, calls = 0, ready;
  const pending = new Promise(resolve => { ready = resolve; });
  const page = await app(t, role, (route, url) => {
    if (url.pathname.endsWith('/schedule') && url.searchParams.get('activity') === 'pickleball' && ++calls > 1) { old = route; ready(); return true; }
  });
  await page.goto(`${base}/${role}/bookings/new`);
  await page.locator('[data-res="court-1"]').waitFor();
  const tomorrow = new Date(Date.now() + 480 * 60_000 + 86_400_000).toISOString().slice(0, 10);
  await page.locator('[data-date]').fill(tomorrow);
  await page.locator('[data-date]').press('Tab');
  await pending;
  await page.locator('[data-activity-id="table_tennis"]').click();
  await page.locator('[data-res="table-1"]').waitFor();
  assert.ok(old, 'The earlier request is still pending');
  await old.fulfill({ json: day('pickleball') });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('[data-res="court-1"]').count(), 0);
  assert.equal(await page.locator('[data-res="table-1"]').count(), 1);
});

for (const role of ['admin', 'staff']) test(`${role}: editing or refreshing cannot unlock an in-flight booking`, async t => {
  let post, submissions = 0;
  const page = await app(t, role, (route, url) => {
    if (url.pathname === `/api/${role}/bookings` && route.request().method() === 'POST') { submissions++; post = route; return true; }
  });
  await page.goto(`${base}/${role}/bookings/new`);
  await page.locator('.slot.available').click();
  await page.locator('[data-booker]').fill('First name');
  await page.locator('[data-act="book"]').click();
  await page.waitForFunction(() => document.querySelector('[data-act="book"]').textContent.includes('Booking'));
  await page.locator('[data-booker]').fill('Changed name');
  await page.locator('[data-rate-id="non_member"]').click();
  assert.equal(await page.locator('[data-act="book"]').isDisabled(), true);
  await page.locator('[data-act="book"]').dispatchEvent('click');
  assert.equal(submissions, 1);
  await post.fulfill({ status: 409, json: { error: { code: 'SLOT_TAKEN', message: 'Synthetic conflict' } } });
  await page.waitForFunction(() => !document.querySelector('[data-act="book"]').disabled);
});

test('player: a lost selected slot is removed on the next live refresh', async t => {
  let calls = 0;
  const page = await app(t, 'player', (route, url) => {
    if (url.pathname === '/api/availability') { calls++; return route.fulfill({ json: day('pickleball', calls === 1 ? 'available' : 'held') }).then(() => true); }
  });
  await page.clock.install({ time: now });
  await page.goto(`${base}/book/pickleball/${today}/court-1`);
  await page.locator('.slot.available').click();
  assert.equal(await page.locator('[data-act="continue"]').isEnabled(), true);
  await page.clock.fastForward(15_001);
  await page.locator('.slot.locked.held').waitFor();
  assert.equal(await page.locator('[data-act="continue"]').isDisabled(), true);
  assert.equal(new URL(page.url()).searchParams.has('start'), false);
});

test('player: stale review receives a conflict with alternatives and no success navigation', async t => {
  let submissions = 0;
  const page = await app(t, 'player', (route, url) => {
    if (url.pathname === '/api/bookings' && route.request().method() === 'POST') {
      submissions++;
      assert.ok(route.request().headers()['idempotency-key']);
      return route.fulfill({ status: 409, json: { error: { code: 'SLOT_TAKEN', message: 'Another player took this slot.', details: { alternatives: [{ resourceId: 'court-1', resourceName: 'Synthetic court', start: 660, starts: [660] }] } } } }).then(() => true);
    }
  });
  await page.goto(`${base}/book/pickleball/${today}/court-1/600`);
  await page.locator('[data-act="reserve"]').click();
  await page.getByRole('alertdialog').waitFor();
  assert.match(await page.getByRole('alertdialog').innerText(), /Nothing was held or charged/);
  assert.match(page.url(), /\/court-1\/600$/);
  assert.equal(submissions, 1);
});

test('player: repeated proof submits remain one upload while the first is in flight', async t => {
  let upload, submissions = 0;
  const page = await app(t, 'player', (route, url) => {
    if (url.pathname.endsWith('/proof')) { submissions++; upload = route; return true; }
  });
  await page.goto(`${base}/bookings/synthetic-booking/pay`);
  await page.locator('[data-file-input]').setInputFiles(fileURLToPath(new URL('../db/seed-proofs/juan.png', import.meta.url)));
  await page.locator('[data-form="proof"]').dispatchEvent('submit');
  await page.waitForFunction(() => document.querySelector('[data-submit]').textContent.includes('Submitting'));
  await page.locator('[data-form="proof"]').dispatchEvent('submit');
  assert.equal(await page.locator('[data-submit]').isDisabled(), true);
  assert.equal(submissions, 1);
  await upload.fulfill({ status: 422, json: { error: { code: 'UNSUPPORTED_FILE_TYPE', message: 'Synthetic file error' } } });
  await page.locator('.file-card.error').waitFor();
});

test('API deadline aborts a hung mutation once and booking recovery keeps its original key', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const data = new Map(), originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } });
  t.after(() => originalStorage ? Object.defineProperty(globalThis, 'sessionStorage', originalStorage) : delete globalThis.sessionStorage);
  const keys = []; let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (++calls > 1) return Response.json({ booking: { id: 'committed-despite-timeout' } });
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('deadline', 'AbortError')), { once: true }));
  });
  const body = { resourceId: 'court-deadline', date: today, starts: [600] };
  const first = postBooking('/api/bookings', body, 'deadline-player');
  const rejected = assert.rejects(first, error => error.code === 'NETWORK' && error.status === 0);
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(calls, 1, 'No automatic retry of the ambiguous write');
  assert.equal(data.size, 1, 'Recovery identity survives the timeout');
  const retry = await postBooking('/api/bookings', body, 'deadline-player');
  assert.equal(retry.booking.id, 'committed-despite-timeout');
  assert.equal(keys[0], keys[1]);
  assert.equal(data.size, 0);
});

test('API deadline also covers a response whose JSON body stalls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let parsing;
  const started = new Promise(resolve => { parsing = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => ({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), json() {
    parsing();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('deadline', 'AbortError')), { once: true }));
  } }));
  const result = api.get('/api/hung-body');
  const rejected = assert.rejects(result, error => error.code === 'NETWORK');
  await started;
  t.mock.timers.tick(30_000);
  await rejected;
});
