// Real booking review and payment screens with synthetic API fixtures. No live writes.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const publicRoot = fileURLToPath(new URL('../public', import.meta.url));
const now = Date.now();
const date = new Date(now + 480 * 60_000).toISOString().slice(0, 10);
const player = { id: 'overlap-player', role: 'player', name: 'Synthetic player', email: 'player@example.invalid', membership: 'member' };
const resources = ['court-1', 'court-2', 'table-1'].map(id => ({ id, activity: id.startsWith('table') ? 'table_tennis' : 'pickleball', name: id === 'court-1' ? 'Court 1' : id === 'court-2' ? 'Court 2' : 'Table 1', status: 'active', priceMember: 50_000, priceNonMember: 60_000, price: 50_000 }));
const facility = { now, today: date, tzOffsetMinutes: 480, facility: { name: 'Synthetic hub' }, rules: { slotMinutes: 60, bookingWindowDays: 14, holdMinutes: 10, warnMinutes: 2 }, hours: [], activities: [], resources };
const overlap = (status = 'CONFIRMED', other = {}) => ({ id: 'existing-booking', resourceId: 'court-1', resourceName: 'Court 1', date, status, segments: [{ start: 960, end: 1020 }], ...other });
const quote = personalOverlaps => ({ price: 50_000, creditApplied: 0, amountDue: 50_000, personalOverlaps });
let server, browser, base;

before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = path.resolve(publicRoot, '.' + pathname);
      if (file !== publicRoot && !file.startsWith(publicRoot + path.sep)) return res.writeHead(403).end();
      if (!path.extname(pathname)) file = path.join(publicRoot, 'index.html');
      const body = await fs.readFile(file);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function review(t, { width = 390, resourceId = 'court-2', starts = [960], response = quote([overlap()]), quoteHandler, postHandler } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 768, serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [], requests = [];
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No uncaught frontend error'));
  let currentQuote = response, currentBooking;
  const resource = resources.find(row => row.id === resourceId);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.fulfill({ contentType: 'text/css', body: '' }));
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    requests.push({ path: p, method: request.method(), query: Object.fromEntries(url.searchParams), body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
    const reply = json => route.fulfill({ json });
    if (p === '/api/auth/session') return reply({ user: player });
    if (p === '/api/facility') return reply(facility);
    if (p.endsWith('/badges')) return reply({ notifications: 0, chats: 0, holds: [] });
    if (p === '/api/bookings/quote') {
      assert.equal(url.searchParams.get('date'), date);
      if (await quoteHandler?.(route, requests)) return;
      return reply(currentQuote);
    }
    if (p === '/api/availability') return reply({ now, today: date, date, slotMinutes: 60, hours: { open: 900, close: 1260 }, resources: resources.filter(row => row.activity === resource.activity).map(row => ({ ...row, slots: [900, 960, 1020, 1080, 1140, 1200].map(start => ({ start, end: start + 60, state: 'available' })) })) });
    if (p === '/api/bookings' && request.method() === 'POST') {
      if (await postHandler?.(route, requests)) return;
      const credit = request.postDataJSON().useCredit ? currentQuote.creditApplied : 0;
      currentBooking = { id: 'new-booking', ref: 'SYNTHETIC', status: credit === currentQuote.price ? 'CONFIRMED' : 'TEMPORARY', activity: resource.activity, activityLabel: resource.activity === 'table_tennis' ? 'Table tennis' : 'Pickleball', resource, user: player, date, segments: starts.map(start => ({ start, end: start + 60 })), amountDue: currentQuote.price - credit, amountLabel: 'PHP 500', creditApplied: credit, creditAppliedLabel: 'PHP 500', totalLabel: 'PHP 500', holdExpiresAt: now + 600_000, canSubmitProof: true };
      return reply({ booking: currentBooking });
    }
    if (p === '/api/bookings/new-booking') return reply({ now, booking: currentBooking, timeline: [], proofs: [], actions: {}, payment: { methods: [{ id: 'gcash', name: 'GCash', enabled: true, accountName: 'Synthetic account', accountNumber: '09000000000' }] } });
    return reply({});
  });
  await page.goto(`${base}/book/${resource.activity}/${date}/${resourceId}/${starts.join(',')}`);
  await page.getByRole('heading', { name: 'Booking summary', exact: true }).waitFor();
  return { page, requests, resource, setQuote(value) { currentQuote = value; }, posts: () => requests.filter(row => row.path === '/api/bookings' && row.method === 'POST'), noOverflow: async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal overflow at ${width}px`) };
}

for (const width of [320, 375, 390, 430, 768, 1024, 1440, 1920]) test(`overlap warning remains readable at ${width}px before any hold`, async t => {
  const { page, posts, noOverflow } = await review(t, { width, response: quote([overlap('CONFIRMED', { resourceName: 'Pickleball Court 1 for group reservations' })]) });
  const warning = page.getByRole('alert', { name: 'Overlapping booking warning' });
  await warning.waitFor();
  assert.match(await warning.innerText(), /You already have a booking during this time/);
  assert.match(await warning.innerText(), /Court 1.*4:00 PM.*5:00 PM/s);
  assert.equal(await page.getByRole('button', { name: 'Continue to Payment', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('link', { name: 'Review / Change Time', exact: true }).count(), 1);
  assert.equal(await warning.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 243, 214)');
  assert.equal(posts().length, 0);
  await noOverflow();
});

for (const status of ['CONFIRMED', 'PAYMENT_SUBMITTED', 'TEMPORARY', 'REJECTED']) test(`server active ${status} reservation warns without blocking a different facility`, async t => {
  const { page, posts } = await review(t, { resourceId: 'table-1', response: quote([overlap(status, { segments: [{ start: 930, end: 990 }] })]) });
  await page.getByRole('alert', { name: 'Overlapping booking warning' }).waitFor();
  await page.getByRole('button', { name: 'Continue to Payment', exact: true }).click();
  await page.getByRole('heading', { name: 'Table 1 is held for you' }).waitFor();
  assert.equal(posts().length, 1);
  assert.deepEqual(posts()[0].body.starts, [960]);
  assert.equal(posts()[0].body.resourceId, 'table-1');
  assert.ok(posts()[0].key);
  await page.locator('[data-pay]').click();
  await page.locator('[data-form="proof"]').waitFor();
  assert.match(await page.locator('[data-payment-info]').innerText(), /GCash|Synthetic/);
});

test('warning preserves gaps and review returns to the selected times without holding', async t => {
  const { page, posts } = await review(t, { starts: [960, 1140], response: { ...quote([overlap('CONFIRMED', { segments: [{ start: 960, end: 1020 }, { start: 1140, end: 1200 }] })]), price: 100_000, amountDue: 100_000 } });
  const warning = page.getByRole('alert', { name: 'Overlapping booking warning' });
  await warning.waitFor();
  assert.match(await warning.innerText(), /4:00 PM.*5:00 PM, 7:00 PM.*8:00 PM/);
  assert.doesNotMatch(await warning.innerText(), /4:00 PM\s*–\s*8:00 PM/);
  await page.getByRole('link', { name: 'Review / Change Time', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose your times' }).waitFor();
  await page.locator('[data-start="1140"][aria-checked="true"]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('start'), '960,1140');
  assert.equal(await page.locator('[data-start][aria-checked="true"]').count(), 2);
  assert.equal(posts().length, 0);
});

test('no active personal overlap follows the normal booking flow', async t => {
  const { page, posts } = await review(t, { response: quote([]) });
  await page.waitForFunction(() => !document.querySelector('[data-act="reserve"]').disabled);
  assert.equal(await page.getByRole('alert', { name: 'Overlapping booking warning' }).count(), 0);
  assert.match(await page.locator('[data-act="reserve"]').innerText(), /Reserve & pay/);
  await page.locator('[data-act="reserve"]').click();
  await page.getByRole('heading', { name: 'Court 2 is held for you' }).waitFor();
  assert.equal(posts().length, 1);
});

test('full credit still warns and credit preference keeps an in-flight reservation disabled', async t => {
  let pending;
  const response = { ...quote([overlap()]), creditApplied: 50_000, amountDue: 0 };
  const { page, posts } = await review(t, { response, postHandler(route) { pending = route; return true; } });
  await page.getByRole('button', { name: 'Continue with Credit', exact: true }).waitFor();
  await page.locator('[data-use-credit]').uncheck();
  await page.getByRole('button', { name: 'Continue to Payment', exact: true }).waitFor();
  await page.locator('[data-use-credit]').check();
  await page.getByRole('button', { name: 'Continue with Credit', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-act="reserve"]').getAttribute('aria-busy') === 'true');
  await page.locator('[data-use-credit]').uncheck();
  assert.equal(await page.locator('[data-act="reserve"]').isDisabled(), true);
  await page.locator('[data-act="reserve"]').dispatchEvent('click');
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.useCredit, true);
  assert.equal(posts()[0].body.expectedCredit, 50_000);
  await pending.fulfill({ status: 409, json: { error: { code: 'CREDIT_CHANGED', message: 'Credit changed. Review the amount.' } } });
  await page.getByRole('button', { name: 'Continue to Payment', exact: true }).waitFor();
  assert.equal(await page.locator('[data-act="reserve"]').isEnabled(), true);
});

test('overlapping credit-funded reservation still confirms immediately', async t => {
  const { page, posts } = await review(t, { response: { ...quote([overlap()]), creditApplied: 50_000, amountDue: 0 } });
  await page.getByRole('button', { name: 'Continue with Credit', exact: true }).click();
  await page.getByRole('heading', { name: 'Booking confirmed', exact: true }).waitFor();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.expectedCredit, 50_000);
  assert.match(page.url(), /\/new-booking\/confirmed$/);
});

test('same-facility conflict still offers alternatives after the overlap warning', async t => {
  const { page, posts } = await review(t, { postHandler: async route => {
    await route.fulfill({ status: 409, json: { error: { code: 'SLOT_TAKEN', message: 'This court was just taken.', details: { alternatives: [{ resourceId: 'court-2', resourceName: 'Court 2', start: 1020, starts: [1020] }] } } } });
    return true;
  } });
  await page.getByRole('button', { name: 'Continue to Payment', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Nothing was held or charged/);
  assert.match(await dialog.innerText(), /already reserved/);
  assert.doesNotMatch(await dialog.innerText(), /Another player/);
  assert.equal(posts().length, 1);
  assert.match(page.url(), /\/court-2\/960$/);
});

test('a delayed overlap preview cannot create a hold before the warning arrives', async t => {
  let pending;
  const { page, posts } = await review(t, { quoteHandler(route) { pending = route; return true; } });
  assert.equal(await page.locator('[data-act="reserve"]').isDisabled(), true);
  await page.locator('[data-act="reserve"]').dispatchEvent('click');
  assert.equal(posts().length, 0);
  await pending.fulfill({ json: quote([overlap()]) });
  await page.getByRole('alert', { name: 'Overlapping booking warning' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Continue to Payment', exact: true }).isEnabled(), true);
});

for (const failure of ['network', 'server', 'missing-overlaps', 'invalid-overlap', 'invalid-money']) test(`failed ${failure} preview cannot silently omit the warning and Retry recovers`, async t => {
  let first = true;
  const { page, posts } = await review(t, { quoteHandler: async route => {
    if (!first) return false;
    first = false;
    if (failure === 'network') await route.abort('failed');
    else if (failure === 'server') await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Try again.' } } });
    else if (failure === 'missing-overlaps') await route.fulfill({ json: { price: 50_000, creditApplied: 0, amountDue: 50_000 } });
    else if (failure === 'invalid-overlap') await route.fulfill({ json: quote([{ ...overlap(), segments: [{ start: 1100, end: 1000 }] }]) });
    else await route.fulfill({ json: { ...quote([]), amountDue: -1 } });
    return true;
  } });
  await page.getByText("Couldn't check your existing bookings", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-act="reserve"]').isDisabled(), true);
  await page.locator('[data-act="reserve"]').dispatchEvent('click');
  assert.equal(posts().length, 0);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('alert', { name: 'Overlapping booking warning' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Continue to Payment', exact: true }).isEnabled(), true);
});

for (const failure of ['network', 'malformed-response']) test(`${failure} reservation recovery preserves the request identity and avoids false success`, async t => {
  let first = true;
  const { page, posts } = await review(t, { postHandler: async route => {
    if (!first) return false;
    first = false;
    if (failure === 'network') await route.abort('failed');
    else await route.fulfill({ json: {} });
    return true;
  } });
  await page.getByRole('button', { name: 'Continue to Payment', exact: true }).click();
  await page.locator('.toast.error').waitFor();
  assert.match(page.url(), /\/court-2\/960$/);
  await page.getByRole('button', { name: 'Continue to Payment', exact: true }).click();
  await page.getByRole('heading', { name: 'Court 2 is held for you' }).waitFor();
  assert.equal(posts().length, 2);
  assert.equal(posts()[0].key, posts()[1].key);
});
