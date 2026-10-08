import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { addDays, isoDate } from '../public/js/core/format.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8805';
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const now = Date.now(), today = isoDate(now), tomorrow = addDays(today, 1);
const pin = 'https://maps.app.goo.gl/SyntheticLocation';
mkdirSync('.wrangler/calendar-maps', { recursive: true });
let passed = 0;

async function scenario(name, width, role, path, run) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block', hasTouch: width < 768 });
  const page = await context.newPage(), errors = [], calls = [];
  page.setDefaultTimeout(12000);
  let settings = { facilityName: 'Le Spinners', facilityAddress: 'Manila, Philippines', facilityMapsUrl: '', holdMinutes: 10, resubmitMinutes: 10, bookingWindowDays: 14, cancelCutoffHours: 24, warnMinutes: 2, slotMinutes: 60, staffAlertEmails: [], staffAlertSms: [] };
  let mode = 'normal', failDates = false, heldResponse;
  const resources = ['pickleball', 'table_tennis'].flatMap(activity => Array.from({ length: 3 }, (_, index) => ({ id: `${activity}-${index}`, activity, name: `${activity === 'pickleball' ? 'Court' : 'Table'} ${index + 1}`, maintenance: activity === 'table_tennis' && index === 1 ? { note: 'Repairing table' } : null })));
  function schedule(date, activity) {
    const rows = resources.filter(resource => !activity || resource.activity === activity);
    return { now, today, date, hours: date === tomorrow ? null : { open: 960, close: 1320, label: '4 PM – 10 PM' }, closedReason: date === tomorrow ? 'Facility event' : null,
      resources: mode === 'empty' ? [] : rows.map((resource, resourceIndex) => ({ ...resource, slots: date === tomorrow ? [] : Array.from({ length: mode === 'long' ? 24 : 6 }, (_, index) => {
        const start = mode === 'long' ? index * 60 : 960 + index * 60;
        const state = resource.maintenance ? 'maintenance' : resourceIndex === 0 && index === 2 ? 'held' : resourceIndex === 1 && index === 4 ? 'booked' : resourceIndex === 2 && index === 5 ? 'unavailable' : index < 2 && date === today ? 'past' : 'available';
        return { start, end: start + 60, label: String(start), state, ...(['held', 'booked', 'unavailable'].includes(state) ? { booking: { id: state + '-booking', userName: 'Synthetic Booker', holdExpiresAt: now + 600000 } } : {}) };
      }) })) };
  }
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.fulfill({ contentType: 'text/css', body: '' }));
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    calls.push({ path: p, query: url.searchParams, method: request.method(), body: request.postData() });
    const reply = json => route.fulfill({ json });
    if (p === '/api/auth/session') return reply({ user: role ? { id: 'synthetic-' + role, name: 'Synthetic operator', role, membership: 'member', email: role + '@example.invalid' } : null });
    if (p === '/api/facility') return reply({ now, today, tzOffsetMinutes: 480, facility: { name: settings.facilityName, address: settings.facilityAddress, mapsUrl: settings.facilityMapsUrl }, rules: settings, activities: [], resources, hours: [] });
    if (p.endsWith('/badges')) return reply({ holds: [], notifications: 0, chats: 0, unresolved: 0, pendingVerification: 0 });
    if (p.endsWith('/schedule/days')) {
      if (failDates) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic service unavailable.' } } });
      const from = url.searchParams.get('from');
      return reply({ now, today, days: Array.from({ length: 14 }, (_, index) => { const date = addDays(from, index); return { date, state: date === tomorrow ? 'closed' : date < today ? 'past' : index === 2 ? 'full' : index === 3 ? 'open_play' : 'open' }; }) });
    }
    if (p.endsWith('/schedule')) {
      if (mode === 'error') return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic schedule unavailable.' } } });
      if (mode === 'delay' && url.searchParams.get('activity') === 'pickleball') { heldResponse = () => reply(schedule(url.searchParams.get('date'), 'pickleball')).catch(() => {}); return; }
      return reply(schedule(url.searchParams.get('date'), url.searchParams.get('activity')));
    }
    if (p === '/api/admin/settings') {
      if (request.method() === 'PUT') { Object.assign(settings, request.postDataJSON()); return reply({ ok: true }); }
      return reply({ canEdit: true, settings, paymentMethods: [], resources: [], delivery: { email: 'queued' } });
    }
    if (p === '/api/admin/outbox') return reply({ summary: {}, items: [] });
    if (p === '/api/admin/storage-health') return reply({});
    if (p === '/api/bookings') return reply({ now, bookings: [] });
    return reply({});
  });
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow at ${width}px`);
  const capture = async label => { if ([320, 390, 768, 1440, 1920].includes(width)) await page.screenshot({ path: `.wrangler/calendar-maps/${label}-${width}.png`, fullPage: true }); };
  try {
    await page.goto(base + path);
    await run({ page, calls, noOverflow, capture, settings: () => settings, mode(value) { mode = value; }, datesError(value) { failDates = value; }, release: () => heldResponse?.(), held: () => Boolean(heldResponse) });
    assert.deepEqual(errors, []); passed++; console.log(`PASS ${name} (${width}px)`);
  } catch (error) { console.error(`FAIL ${name} (${width}px): ${error.stack}\n${errors.join('\n')}`); throw error; }
  finally { await context.close(); }
}

try {
  for (const [role, width] of [...[320, 375, 390, 430, 768, 1024, 1440, 1920].map(width => ['admin', width]), ['staff', 320], ['staff', 1440]]) {
    await scenario(`${role} calendar dates, filters, links and sticky grid`, width, role, `/${role}/calendar`, async ({ page, noOverflow, capture }) => {
      await page.locator('.calendar-matrix').waitFor();
      await page.waitForFunction(() => document.querySelector('.calendar-day-status')?.textContent === 'Open');
      assert.equal(await page.locator('.calendar-day').count(), 14);
      assert.equal(await page.locator('.calendar-day[aria-pressed="true"]').getAttribute('data-calendar-day'), today);
      assert.equal(await page.locator('.calendar-resource').count(), 6);
      assert.equal(await page.locator('.cell.booked').getAttribute('href'), `/${role}/bookings/booked-booking`);
      assert.equal(await page.locator('.cell.unavailable').getAttribute('href'), `/${role}/verify/unavailable-booking`);
      await noOverflow(); await capture(role === 'admin' ? 'calendar' : 'staff-calendar');
      const area = page.locator('[data-scroll-area]');
      const overflow = await area.evaluate(element => element.scrollWidth > element.clientWidth + 1);
      if (overflow) {
        assert.equal(await page.getByRole('button', { name: 'Earlier times', exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: 'Later times', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-scroll-area]').scrollLeft > 30);
        const resource = await page.locator('.calendar-resource').first().boundingBox(), box = await area.boundingBox();
        assert.ok(resource.x >= box.x - 1 && resource.x < box.x + 12, 'Resource labels stay visible when scrolling');
        await area.evaluate(element => { element.scrollTop = 100; });
        const header = await page.locator('.calendar-matrix thead th').nth(1).boundingBox();
        assert.ok(header.y >= box.y - 1 && header.y < box.y + 25, 'Time headers stay visible when scrolling');
      }
      await page.locator(`[data-calendar-day="${tomorrow}"]`).focus();
      await page.keyboard.press('Enter');
      await page.getByText('Facility event', { exact: true }).waitFor(); assert.ok(page.url().includes('date=' + tomorrow));
      await page.getByRole('button', { name: 'Previous day', exact: true }).click(); await page.locator('.calendar-matrix').waitFor();
      await page.locator('[data-activity]').selectOption('table_tennis');
      await page.waitForFunction(() => document.querySelectorAll('.calendar-resource').length === 3);
      assert.ok((await page.locator('.calendar-matrix').innerText()).includes('Table 1'));
      await page.reload(); await page.locator('.calendar-matrix').waitFor(); assert.equal(await page.locator('[data-activity]').inputValue(), 'table_tennis');
      await page.locator('[data-date]').fill(addDays(today, 4));
      await page.waitForFunction(expected => document.querySelector('[aria-pressed="true"][data-calendar-day]')?.dataset.calendarDay === expected, addDays(today, 4));
      await page.getByRole('button', { name: 'Next day', exact: true }).click();
      await page.waitForFunction(expected => document.querySelector('[data-date]').value === expected, addDays(today, 5));
      await page.evaluate(() => {
        const nativePicker = HTMLInputElement.prototype.showPicker;
        HTMLInputElement.prototype.showPicker = function () { window.calendarPickerRequested = true; return nativePicker.call(this); };
      });
      await page.locator('[data-picker]').click();
      assert.equal(await page.evaluate(() => window.calendarPickerRequested), true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Today', exact: true }).click();
      await page.waitForFunction(expected => document.querySelector('[data-date]').value === expected, today);
      await noOverflow();
    });
  }
  for (const width of [320, 390, 768, 1440]) await scenario('Maps settings save, reload and clear', width, 'admin', '/admin/settings', async ({ page, calls, noOverflow, capture }) => {
    const field = page.getByLabel('Maps location link', { exact: true }); await field.fill(pin);
    await capture('maps-settings'); await page.locator('[data-act="save"]').click();
    await page.waitForFunction(expected => document.querySelector('[name="facilityMapsUrl"]')?.value === expected && !document.querySelector('[data-act="save"]')?.disabled, pin);
    assert.deepEqual(calls.filter(call => call.path === '/api/admin/settings' && call.method === 'PUT').map(call => JSON.parse(call.body)), [{ facilityMapsUrl: pin }]);
    await page.reload(); assert.equal(await field.inputValue(), pin);
    await field.fill(''); await page.locator('[data-act="save"]').click();
    await page.waitForFunction(() => document.querySelector('[name="facilityMapsUrl"]')?.value === '' && !document.querySelector('[data-act="save"]')?.disabled);
    assert.deepEqual(JSON.parse(calls.filter(call => call.path === '/api/admin/settings' && call.method === 'PUT').at(-1).body), { facilityMapsUrl: '' });
    await noOverflow();
  });
  for (const role of [null, 'player']) await scenario('Directions use the configured pin and retain address fallback', 390, role, role ? '/' : '/welcome', async ({ page, settings, noOverflow }) => {
    settings().facilityMapsUrl = pin; await page.reload();
    const directions = page.getByRole('link', { name: role ? 'Directions' : 'Get directions', exact: true });
    assert.equal(await directions.getAttribute('href'), pin);
    settings().facilityMapsUrl = ''; await page.reload();
    assert.equal(await directions.getAttribute('href'), 'https://www.google.com/maps/search/?api=1&query=Manila%2C%20Philippines');
    settings().facilityMapsUrl = pin; settings().facilityAddress = ''; await page.reload(); assert.equal(await directions.getAttribute('href'), pin);
    await noOverflow();
  });
  await scenario('Calendar empty, unavailable and date-summary retry states', 320, 'admin', '/admin/calendar', async ({ page, mode, datesError, noOverflow }) => {
    await page.locator('.calendar-matrix').waitFor(); mode('empty'); await page.getByRole('button', { name: 'Today', exact: true }).click(); await page.getByText('No resources to show', { exact: true }).waitFor();
    mode('error'); await page.getByRole('button', { name: 'Today', exact: true }).click(); await page.getByText('Synthetic schedule unavailable.', { exact: true }).waitFor();
    mode('normal'); datesError(true); await page.getByRole('button', { name: 'Try again', exact: true }).click(); await page.locator('.calendar-matrix').waitFor(); await page.locator('[data-days-message]:visible').waitFor();
    datesError(false); await page.getByRole('button', { name: 'Retry dates', exact: true }).click(); await page.locator('[data-days-message]').waitFor({ state: 'hidden' });
    await noOverflow();
  });
  await scenario('Wide schedules and late responses keep the current activity', 390, 'admin', '/admin/calendar', async ({ page, mode, held, release, noOverflow }) => {
    await page.locator('.calendar-matrix').waitFor(); mode('long'); await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.calendar-matrix thead th').length === 25); await noOverflow();
    mode('delay'); await page.locator('[data-activity]').selectOption('pickleball');
    for (let tries = 0; tries < 50 && !held(); tries++) await page.waitForTimeout(20);
    assert.equal(held(), true); await page.locator('[data-activity]').selectOption('table_tennis');
    await page.waitForFunction(() => document.querySelectorAll('.calendar-resource').length === 3 && document.querySelector('.calendar-resource')?.textContent.includes('Table'));
    await release(); await page.waitForTimeout(100);
    assert.equal((await page.locator('.calendar-matrix').innerText()).includes('Court'), false); assert.ok(page.url().includes('activity=table_tennis'));
  });
  console.log(`${passed} calendar/maps browser scenarios passed`);
} finally { await browser.close(); }
