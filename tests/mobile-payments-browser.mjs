import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { addDays } from '../public/js/core/format.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8805';
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const now = Date.now(), today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const image = readFileSync('db/seed-proofs/juan.png');
mkdirSync('.wrangler/mobile-payments', { recursive: true });
let passed = 0;

async function scenario(name, width, role, path, run) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  const page = await context.newPage(), errors = [], calls = [];
  let actorRole = role;
  let methods = [
    { id: 'gcash', name: 'GCash', accountName: 'Le Spinners', accountNumber: '0917 123 4567', hasQr: true, qrUrl: '/api/facility/payment-methods/gcash/qr', enabled: true },
    { id: 'bank', name: 'Bank Transfer', accountName: null, accountNumber: '1234-5678', hasQr: false, qrUrl: null, enabled: true },
    { id: 'maya', name: 'Maya', accountName: null, accountNumber: null, hasQr: true, qrUrl: '/api/facility/payment-methods/maya/qr', enabled: true },
    { id: 'other', name: 'Other method', accountName: null, accountNumber: null, hasQr: false, qrUrl: null, enabled: true },
    { id: 'disabled', name: 'Disabled method', enabled: false },
  ];
  let booking = { id: 'test_booking', ref: 'TEST-BOOKING', status: 'TEMPORARY', activity: 'pickleball', activityLabel: 'Pickleball', resource: { id: 'court-1', name: 'Court 1' }, date: today,
    start: 600, end: 660, durationMin: 60, durationLabel: '1 hour', amountDue: 50000, amountLabel: '₱500', rate: 'member', holdExpiresAt: now + 600000,
    createdAt: now, canSubmitProof: true, paymentMethodId: null, user: { name: 'Synthetic player', email: 'player@example.invalid', membership: 'member' } };
  let availability = [{ activity: 'pickleball', available: 2, total: 3 }, { activity: 'table_tennis', available: 2, total: 3 }];
  let rejectMethodOnce = false, qrError = false, proofMethod = null;
  const facility = { now, today, tzOffsetMinutes: 480, facility: { name: 'Le Spinners', address: '' }, rules: { holdMinutes: 10, resubmitMinutes: 10, slotMinutes: 60, bookingWindowDays: 14 }, hours: [], activities: [], resources: [] };
  const detail = () => ({ now, booking, proofs: [], timeline: [], credit: null, payment: { methods: methods.filter(method => method.enabled), maxUploadMb: 10 } });
  const settings = () => ({ canEdit: true, paymentMethods: methods, settings: { ...facility.rules, cancelCutoffHours: 24, warnMinutes: 2, facilityName: 'Le Spinners', facilityAddress: '', staffAlertEmails: [], staffAlertSms: [] }, resources: [], delivery: { email: 'queued' } });
  const periods = ['day', 'week', 'month', 'year'].map((key, index) => ({ key, label: ['Daily revenue', 'Weekly revenue', 'Monthly revenue', 'Yearly revenue'][index], collected: 123456789, payments: 24, rangeLabel: today,
    previous: { toDate: 100000000 }, change: { direction: 'up', pct: 23.4 }, cancelledAfterPayment: { count: 2, amount: 100000 } }));
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.fulfill({ contentType: 'text/css', body: '' }));
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname, method = request.method();
    calls.push({ p, method, query: url.searchParams, body: request.postData() });
    const reply = json => route.fulfill({ json });
    if (p === '/api/auth/session') return reply({ user: { id: 'synthetic', name: 'Synthetic ' + actorRole, role: actorRole, email: actorRole + '@example.invalid', membership: 'member' } });
    if (p === '/api/facility') return reply(facility);
    if (p.endsWith('/badges')) return reply({ holds: [], notifications: 0, chats: 0, unresolved: 0, pendingVerification: 0 });
    if (p === '/api/admin/settings') return reply(settings());
    if (p === '/api/admin/outbox') return reply({ summary: {}, items: [] });
    if (p === '/api/admin/storage-health') return reply({});
    if (p === '/api/admin/payment-methods' && method === 'POST') {
      const body = request.postDataJSON(), id = 'pm_' + methods.length; methods.push({ id, ...body, qrUrl: null, hasQr: false }); return reply({ ok: true, id });
    }
    const methodMatch = /^\/api\/admin\/payment-methods\/([^/]+)(\/qr)?$/.exec(p);
    if (methodMatch) {
      const row = methods.find(row => row.id === methodMatch[1]);
      if (methodMatch[2]) { row.hasQr = method === 'PUT'; row.qrUrl = row.hasQr ? `/api/facility/payment-methods/${row.id}/qr` : null; }
      else if (method === 'DELETE') methods = methods.filter(row => row.id !== methodMatch[1]);
      else Object.assign(row, request.postDataJSON());
      return reply({ ok: true });
    }
    if (p.endsWith('/qr')) return qrError ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ contentType: 'image/png', body: image });
    if (p === '/api/bookings/test_booking') return reply(detail());
    if (p === '/api/bookings/test_booking/proof') {
      proofMethod = /name="paymentMethodId"\r?\n\r?\n([^\r\n]+)/.exec(request.postDataBuffer().toString())?.[1];
      if (rejectMethodOnce) { rejectMethodOnce = false; methods = methods.filter(row => row.id !== proofMethod); return route.fulfill({ status: 409, json: { error: { code: 'PAYMENT_METHOD_UNAVAILABLE', message: 'This method was disabled. Select another method.' } } }); }
      booking = { ...booking, status: 'PAYMENT_SUBMITTED', canSubmitProof: false }; return reply(detail());
    }
    if (p === '/api/admin/summary') return reply({ now, counts: { pendingVerification: 0, activeHolds: 0, unresolved: 0, unreadChats: 0, confirmedToday: 1 }, verification: [], holds: [], todaySchedule: [],
      verifiedRevenueToday: 123456789, facility: { availability, inService: 4, total: 6, maintenance: [], openPlay: [] } });
    if (p === '/api/admin/messages') return reply({ conversations: [] });
    if (p === '/api/admin/revenue/summary') return reply({ now, today, periods, resources: [{ id: 'court-1', name: 'Court 1', activity: 'pickleball' }], methods: methods.map(row => ({ value: row.id, label: row.name })) });
    if (p === '/api/admin/revenue/ledger') {
      const number = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('size') || 10);
      const rows = Array.from({ length: Math.min(size, 21 - (number - 1) * size) }, (_, i) => ({ ...booking, id: 'row-' + i, ref: `PAGE-${number}-ROW-${i}`, at: now, atKind: 'Verified', payStatus: 'paid', payStatusLabel: 'Paid · verified',
        countsAsRevenue: true, amount: 50000, methodLabel: url.searchParams.get('method') === 'bank' ? 'Bank Transfer' : 'GCash', verifiedBy: 'Admin', user: booking.user }));
      return reply({ rows, total: 21, page: number, pages: Math.ceil(21 / size), size, range: { label: today }, totals: { collected: 1050000, collectedCount: 21, pending: 50000, pendingCount: 1, cancelledAfterPayment: 100000, cancelledAfterPaymentCount: 2 } });
    }
    if (p === '/api/admin/revenue/export') return route.fulfill({ contentType: 'text/csv', body: '"Payment method"\r\n"Bank Transfer"\r\n', headers: { 'content-disposition': 'attachment; filename="test-ledger.csv"', 'x-export-parts': '1', 'x-export-version': 'test', 'x-export-rows': '21' } });
    return reply({});
  });
  async function noOverflow() {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflows at ${width}px`);
  }
  async function capture(name) {
    if ([320, 390, 1440].includes(width)) await page.screenshot({ path: `.wrangler/mobile-payments/${name}-${width}.png`, fullPage: !name.startsWith('export') });
  }
  try {
    await page.goto(base + path);
    await run({ page, calls, noOverflow, capture, methods: () => methods, setRole(value) { actorRole = value; }, none() { methods = []; }, disableOnUpload() { rejectMethodOnce = true; }, breakQr() { qrError = true; }, facilities(value) { availability = value; }, proofMethod: () => proofMethod });
    assert.deepEqual(errors, []); passed++; console.log(`PASS ${name} (${width}px)`);
  } catch (error) { console.error(`FAIL ${name} (${width}px): ${error.stack}\n${errors.join('\n')}`); throw error; }
  finally { await context.close(); }
}

try {
  for (const width of [320, 375, 390, 430, 1440]) {
    await scenario('Revenue grid, filters, pagination and CSV', width, 'admin', '/revenue/', async ({ page, calls, noOverflow, capture }) => {
      await page.locator('.rev-card').last().waitFor();
      const boxes = await page.locator('.rev-card').evaluateAll(cards => cards.map(card => ({ x: card.offsetLeft, y: card.offsetTop })));
      assert.equal(boxes[0].y, boxes[1].y);
      if (width < 768) { assert.equal(boxes[2].y, boxes[3].y); assert.ok(boxes[2].y > boxes[0].y); assert.equal(await page.locator('details').getAttribute('open'), null); }
      else assert.equal(boxes[0].y, boxes[3].y);
      assert.equal((await page.locator('#main').innerText()).includes('Collected revenue counts'), false);
      assert.equal(await page.locator('.ledger-totals, .rev-foot').count(), 0);
      assert.equal((await page.locator('[data-cards]').innerText()).includes('cancelled after payment'), false);
      await capture('revenue');
      const header = await page.locator('.ledger-head').boundingBox(), button = await page.locator('[data-act="export"]').boundingBox();
      assert.ok(button.x + button.width <= header.x + header.width && button.x > header.x + header.width / 2);
      if (width < 768) await page.locator('summary').click();
      await page.waitForFunction(() => document.querySelector('[data-filter-label]').textContent === 'Hide Filters');
      await page.locator('[data-f="method"]').selectOption('bank');
      await page.waitForFunction(() => document.querySelector('[data-ledger]').textContent.includes('Bank Transfer'));
      assert.ok(calls.some(call => call.p.endsWith('/ledger') && call.query.get('method') === 'bank'));
      await page.locator('[data-q]').fill('PAGE');
      await page.waitForRequest(request => new URL(request.url()).searchParams.get('q') === 'PAGE');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-ledger]').textContent.includes('PAGE-2'));
      const ledgerUrl = page.url(), ledgerFrom = await page.locator('[data-date="from"]').inputValue();
      const lastYear = new Date(today + 'T00:00:00Z'); lastYear.setUTCFullYear(lastYear.getUTCFullYear() - 1);
      for (const [range, from] of [['1d', today], ['7d', addDays(today, -6)], ['30d', addDays(today, -29)], ['1y', addDays(lastYear.toISOString().slice(0, 10), 1)], ['custom', '2025-12-30']]) {
        const before = calls.filter(call => call.p.endsWith('/export')).length;
        await page.locator('[data-act="export"]').click();
        const dialog = page.getByRole('dialog', { name: 'Export booking ledger' });
        assert.equal(calls.filter(call => call.p.endsWith('/export')).length, before, 'Opening the chooser must not download');
        assert.equal(await dialog.locator('[data-export-range]').count(), 5);
        await dialog.locator(`[data-export-range="${range}"]`).click();
        assert.equal(await dialog.locator(`[data-export-range="${range}"]`).getAttribute('aria-pressed'), 'true');
        if (range === 'custom') {
          await dialog.locator('[name="from"]').fill('');
          await dialog.locator('[data-confirm-export]').click();
          assert.equal(await dialog.locator('[data-export-error]').isVisible(), true);
          await dialog.locator('[name="from"]').fill('2026-01-10');
          await dialog.locator('[name="to"]').fill('2026-01-04');
          await dialog.locator('[data-confirm-export]').click();
          assert.match(await dialog.locator('[data-export-error]').innerText(), /start date must be/);
          assert.equal(calls.filter(call => call.p.endsWith('/export')).length, before, 'Invalid dates must not export');
          await dialog.locator('[name="from"]').fill(from);
          await capture('export-calendar');
        }
        await noOverflow();
        const downloadReady = page.waitForEvent('download'); await dialog.locator('[data-confirm-export]').click();
        const download = await downloadReady; assert.equal(download.suggestedFilename(), 'test-ledger.csv');
        await dialog.waitFor({ state: 'hidden' });
        const exported = calls.filter(call => call.p.endsWith('/export')).at(-1).query;
        assert.equal(exported.get('from'), from); assert.equal(exported.get('to'), range === 'custom' ? '2026-01-04' : today);
        assert.equal(exported.get('method'), 'bank'); assert.equal(exported.get('q'), 'PAGE');
        assert.equal(exported.get('page'), null); assert.equal(page.url(), ledgerUrl);
        assert.equal(await page.locator('[data-date="from"]').inputValue(), ledgerFrom);
      }
      const beforeCancel = calls.filter(call => call.p.endsWith('/export')).length;
      await page.locator('[data-act="export"]').click(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(calls.filter(call => call.p.endsWith('/export')).length, beforeCancel);
      await page.locator('summary').click(); await page.waitForFunction(() => document.querySelector('[data-filter-label]').textContent === 'Show Filters');
      await noOverflow();
    });
    await scenario('Dashboard revenue and facility segments', width, 'admin', '/admin/', async ({ page, noOverflow, capture }) => {
      await page.locator('.facility-stat').waitFor();
      assert.ok((await page.locator('.facility-stat').innerText()).includes('Pickleball 2/3'));
      assert.ok((await page.locator('.facility-stat').innerText()).includes('Table Tennis 2/3'));
      assert.deepEqual(await page.locator('.facility-bar i').evaluateAll(nodes => nodes.map(node => node.className)), ['blue', 'blue', 'red', 'green', 'green', 'red']);
      await noOverflow(); await capture('dashboard'); await page.locator('.revenue-stat').click(); await page.locator('.rev-card').last().waitFor(); assert.ok(page.url().includes('/revenue/'));
    });
    await scenario('Booker conditional instructions and selected proof method', width, 'player', '/bookings/test_booking/pay', async ({ page, methods, noOverflow, proofMethod, capture }) => {
      await page.locator('[data-payment-method]').waitFor();
      assert.equal(await page.locator('.qr-panel').count(), 1);
      await capture('payment');
      assert.equal(await page.locator('[data-payment-method] option[value="disabled"]').count(), 0);
      await page.locator('[data-payment-method]').selectOption('bank');
      assert.equal(await page.locator('.qr-panel').count(), 0); assert.equal(await page.getByText('Account name', { exact: true }).count(), 0);
      assert.equal(await page.getByText('1234-5678', { exact: true }).count(), 1);
      await page.locator('[data-payment-method]').selectOption('maya');
      assert.equal(await page.locator('.qr-panel').count(), 1); assert.equal(await page.getByText('Account number', { exact: true }).count(), 0);
      await page.locator('[data-payment-method]').selectOption('other'); assert.equal(await page.locator('[data-payment-info] .card').count(), 0);
      assert.equal((await page.locator('#main').innerText()).includes('No QR'), false);
      await page.locator('[data-payment-method]').selectOption('bank'); await noOverflow();
      const bank = methods().find(method => method.id === 'bank');
      Object.assign(bank, { name: 'N'.repeat(80), accountName: 'A'.repeat(120), accountNumber: '1'.repeat(100) });
      await page.reload(); await page.getByText(bank.accountNumber, { exact: true }).waitFor();
      assert.ok(await page.locator('.gc-number, .gcash-card .gc-head .pill, .gcash-card .kv-stack .strong').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), 'Configured payment details must wrap without clipping');
      await noOverflow();
      await page.locator('[data-file-input]').setInputFiles('db/seed-proofs/juan.png');
      await page.locator('[data-submit]').click(); await page.getByRole('heading', { name: 'Waiting for admin verification' }).waitFor(); assert.equal(proofMethod(), 'bank');
    });
    await scenario('Admin adds, edits, toggles and archives payment methods and QR', width, 'admin', '/admin/settings', async ({ page, methods, setRole, noOverflow, capture }) => {
      await page.locator('[data-add-method]').click();
      let dialog = page.getByRole('dialog');
      await dialog.locator('[name="name"]').fill('New Bank');
      await dialog.getByRole('button', { name: 'Add', exact: true }).first().click(); await dialog.locator('[name="accountName"]').fill('Recipient');
      await dialog.getByRole('button', { name: 'Add', exact: true }).click(); await dialog.locator('[name="accountNumber"]').fill('123-456');
      await noOverflow(); await capture('method-editor'); await dialog.getByRole('button', { name: 'Save payment method', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      const id = methods().find(method => method.name === 'New Bank').id;
      const toggle = page.locator(`[data-toggle-method="${id}"]`);
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      await toggle.click(); await page.waitForFunction(id => document.querySelector(`[data-toggle-method="${id}"]`)?.getAttribute('aria-checked') === 'false', id);
      assert.equal(methods().find(method => method.id === id).enabled, false);
      assert.equal(methods().find(method => method.id === id).accountName, 'Recipient');
      assert.equal(methods().find(method => method.id === id).accountNumber, '123-456');
      setRole('player'); await page.goto(base + '/bookings/test_booking/pay'); await page.locator('[data-payment-method]').waitFor();
      assert.equal(await page.locator(`[data-payment-method] option[value="${id}"]`).count(), 0);
      setRole('admin'); await page.goto(base + '/admin/settings'); await page.locator(`[data-toggle-method="${id}"]`).click();
      await page.waitForFunction(id => document.querySelector(`[data-toggle-method="${id}"]`)?.getAttribute('aria-checked') === 'true', id);
      assert.equal(methods().find(method => method.id === id).enabled, true);
      setRole('player'); await page.goto(base + '/bookings/test_booking/pay'); await page.locator(`[data-payment-method] option[value="${id}"]`).waitFor({ state: 'attached' });
      setRole('admin'); await page.goto(base + '/admin/settings'); await noOverflow(); await capture('payment-methods');
      await page.locator(`[data-edit-method="${id}"]`).click(); dialog = page.getByRole('dialog');
      await dialog.locator('[data-method-file]').setInputFiles('db/seed-proofs/juan.png');
      await dialog.getByRole('button', { name: 'Save payment method', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      assert.equal(methods().find(method => method.id === id).hasQr, true);
      await page.locator(`[data-edit-method="${id}"]`).click(); dialog = page.getByRole('dialog');
      await dialog.locator('[name="enabled"]').uncheck(); await dialog.getByRole('button', { name: 'Remove QR', exact: true }).click();
      await dialog.getByRole('button', { name: 'Save payment method', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      assert.equal(methods().find(method => method.id === id).enabled, false); assert.equal(methods().find(method => method.id === id).hasQr, false);
      assert.equal(await page.locator('[data-remove-method]').count(), 0);
      await page.locator(`[data-archive-method="${id}"]`).click(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(methods().some(method => method.id === id), true);
      await page.locator(`[data-archive-method="${id}"]`).click(); await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal(methods().some(method => method.id === id), false);
      await noOverflow();
    });
  }
  await scenario('Disabled method during upload preserves screenshot and refreshes methods', 390, 'player', '/bookings/test_booking/pay', async ({ page, disableOnUpload, proofMethod }) => {
    await page.locator('[data-payment-method]').selectOption('bank'); disableOnUpload();
    await page.locator('[data-file-input]').setInputFiles('db/seed-proofs/juan.png'); await page.locator('[data-submit]').click();
    await page.getByText('Payment method changed', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-payment-method] option[value="bank"]').count(), 0);
    await page.locator('[data-payment-method]').selectOption('other'); await page.locator('[data-submit]').click();
    await page.getByRole('heading', { name: 'Waiting for admin verification' }).waitFor(); assert.equal(proofMethod(), 'other');
  });
  await scenario('No enabled methods and QR loading failures leave no blank QR container', 320, 'player', '/bookings/test_booking/pay', async ({ page, none, breakQr, noOverflow }) => {
    await page.locator('.qr-img').waitFor(); breakQr(); await page.locator('[data-payment-method]').selectOption('maya');
    await page.waitForFunction(() => !document.querySelector('.qr-panel'));
    assert.equal(await page.locator('[data-payment-info] .card').count(), 0);
    none(); await page.reload(); await page.locator('[data-method-state]:visible').waitFor();
    assert.equal(await page.locator('.qr-panel').count(), 0); assert.equal(await page.locator('[data-submit]').isDisabled(), true); await noOverflow();
  });
  console.log(`${passed} mobile/payment browser scenarios passed`);
} finally { await browser.close(); }
