// Real player modules and browser interactions with synthetic, read-only API fixtures.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { addDays, minutesLabel } from '../public/js/core/format.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8805';
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const today = '2026-10-08', now = Date.parse('2026-10-08T09:30:00Z');
mkdirSync('.wrangler/player-availability', { recursive: true });
let passed = 0;

async function scenario(name, width, run) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 768, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], calls = [];
  page.setDefaultTimeout(10000);
  let gridError = false, datesError = false, empty = false, taken = false;
  const heldResponses = [];
  const resources = ['pickleball', 'table_tennis'].flatMap(activity => Array.from({ length: 3 }, (_, index) => ({
    id: `${activity}-${index + 1}`, activity, name: `${activity === 'pickleball' ? 'Court' : 'Table'} ${index + 1}`,
    status: index === 2 ? 'open_play' : activity === 'table_tennis' && index === 1 ? 'maintenance' : 'active', price: 50000, priceMember: 50000, priceNonMember: 60000,
    maintenance: activity === 'table_tennis' && index === 1 ? { note: 'Repairing table' } : null,
  })));
  const facility = { now, today, tzOffsetMinutes: 480, facility: { name: 'Le Spinners Recreational Hub', address: 'Manila, Philippines' },
    rules: { bookingWindowDays: 14, slotMinutes: 60, holdMinutes: 10 },
    hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, isOpen: true, open: 960, close: 1320, label: '4 PM – 10 PM' })),
    activities: [{ id: 'pickleball', label: 'Pickleball', count: 3 }, { id: 'table_tennis', label: 'Table tennis', count: 3 }], resources };
  function availability(activity, date) {
    const closed = date === addDays(today, 2), full = date === addDays(today, 3);
    return { now, today, date, activity, open: !closed, hours: closed ? null : { open: 960, close: 1320 }, slotMinutes: 60, closedReason: closed ? 'Facility event' : null,
      resources: empty ? [] : resources.filter(resource => resource.activity === activity).map(resource => ({ ...resource,
        slots: closed ? [] : Array.from({ length: 6 }, (_, index) => {
          const start = 960 + index * 60;
          const state = full ? 'booked' : date === today && index === 0 ? 'past' : resource.status === 'maintenance' ? 'maintenance' : resource.status === 'open_play' ? 'open_play'
            : resource.id === 'pickleball-1' && index === 1 ? 'held' : resource.id === 'pickleball-2' && index === 1 ? 'mine'
              : resource.id === 'pickleball-1' && index === 4 ? 'booked' : resource.id === 'pickleball-1' && index === 5 ? 'unavailable'
                : taken && resource.id === 'pickleball-1' && index === 2 ? 'held' : 'available';
          return { start, end: start + 60, label: minutesLabel(start), state, ...(state === 'mine' ? { booking: { id: 'own-booking', status: 'CONFIRMED' } } : {}) };
        }) })) };
  }
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.fulfill({ contentType: 'text/css', body: '' }));
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    calls.push({ path, method: request.method(), date: url.searchParams.get('date'), activity: url.searchParams.get('activity') });
    const reply = json => route.fulfill({ json });
    if (path === '/api/auth/session') return reply({ user: { id: 'synthetic-player', role: 'player', name: 'Jamie Player', email: 'player@example.invalid', membership: 'member' } });
    if (path === '/api/facility') return reply(facility);
    if (path.endsWith('/badges')) return reply({ holds: [], notifications: 0, chats: 0 });
    if (path === '/api/bookings') return reply({ now, bookings: [], credits: { available: 0 } });
    if (path === '/api/bookings/quote') return reply({ price: 100000, creditApplied: 0, amountDue: 100000, personalOverlaps: [] });
    if (path === '/api/availability/days') {
      if (datesError) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic date error' } } });
      const activity = url.searchParams.get('activity');
      return reply({ now, today, days: Array.from({ length: 15 }, (_, index) => {
        const date = addDays(today, index), day = availability(activity, date);
        const available = day.resources.flatMap(resource => resource.slots).filter(slot => slot.state === 'available').length;
        return { date, available, load: index === 2 ? 'closed' : index === 3 ? 'full' : available ? 'open' : 'closed', openPlay: index === 2 || index === 3 ? 0 : 1 };
      }) });
    }
    if (path === '/api/availability') {
      if (gridError) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic grid error' } } });
      if (url.searchParams.get('date') === addDays(today, 5)) {
        heldResponses.push(() => reply(availability(url.searchParams.get('activity'), url.searchParams.get('date'))).catch(() => {}));
        return;
      }
      return reply(availability(url.searchParams.get('activity'), url.searchParams.get('date')));
    }
    return reply({});
  });
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow at ${width}px`);
  try {
    await page.goto(base + '/');
    await run({ page, calls, noOverflow, gridError(value) { gridError = value; }, datesError(value) { datesError = value; }, empty(value) { empty = value; }, taken(value) { taken = value; }, held: () => heldResponses.length > 0, release: () => Promise.all(heldResponses.map(release => release())) });
    assert.deepEqual(errors, []);
    assert.ok(calls.every(call => call.method === 'GET'), 'Browsing and adding times must not reserve or charge');
    passed++; console.log(`PASS ${name} (${width}px)`);
  } finally { await context.close(); }
}

try {
  for (const width of [320, 375, 390, 430, 768, 1024, 1440, 1920]) {
    await scenario('Calendar layout and one-click handoff to step 4 with additional times', width, async ({ page, noOverflow }) => {
      await page.locator('.home-calendar-matrix').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('.home-calendar-day.open').length > 1);
      assert.equal(await page.locator('.home-calendar-day').count(), 15);
      assert.equal(await page.locator('.home-calendar-resource').count(), 3);
      assert.equal(await page.locator('.home-calendar-matrix thead th').count(), 7);
      assert.equal(await page.locator('[data-calendar-activity][aria-pressed="true"]').getAttribute('data-calendar-activity'), 'pickleball');
      assert.equal(await page.locator('.home-calendar-day[aria-pressed="true"]').getAttribute('data-availability-date'), today);
      for (const state of ['held', 'booked', 'unavailable', 'open_play', 'past']) assert.equal(await page.locator(`a.home-calendar-slot.${state}`).count(), 0, `${state} cannot start a booking`);
      assert.equal(await page.locator('.home-calendar-slot.mine').getAttribute('href'), '/bookings/own-booking');
      assert.equal(await page.getByText('Choose an available time, then add more times to your booking.', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Swipe or scroll to see all times', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Choose this time', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: /Earlier times|Later times/ }).count(), 0);
      const available = page.locator('[data-availability-slot="pickleball-1-1080"]');
      assert.equal(await available.locator('b').innerText(), '6:00–7:00');
      assert.equal(await available.locator('span').innerText(), 'Available');
      assert.match(await available.getAttribute('aria-label'), /6:00.*7:00 PM: Available/);
      assert.ok((await available.boundingBox()).height <= 64, 'Availability cards stay compact');
      assert.ok(await page.locator('.home-calendar-slot').evaluateAll(slots => slots.every(slot => slot.scrollWidth <= slot.clientWidth + 1)), 'Time ranges fit inside every card');
      const tables = page.locator('[data-calendar-activity="table_tennis"]');
      await tables.click();
      assert.equal(await tables.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.home-calendar-resource').count(), 3);
      assert.ok((await page.locator('.home-calendar-resource').allTextContents()).every(text => text.includes('Table tennis')));
      assert.equal(await page.locator('[data-availability-slot^="pickleball-"]').count(), 0);
      assert.ok(await page.locator('.home-calendar-slot.maintenance').count() > 0);
      assert.equal(await page.locator('a.home-calendar-slot.maintenance').count(), 0);
      await noOverflow();
      if ([320, 768, 1920].includes(width)) await page.locator('[data-availability-calendar]').screenshot({ path: `.wrangler/player-availability/calendar-tables-${width}.png`, style: '.topnav, .tabbar { visibility: hidden; }' });
      await page.locator('[data-calendar-activity="pickleball"]').click();
      if ([320, 390, 768, 1440, 1920].includes(width)) {
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
        await page.screenshot({ path: `.wrangler/player-availability/home-${width}.png`, fullPage: true });
        await page.locator('[data-availability-calendar]').screenshot({ path: `.wrangler/player-availability/calendar-${width}.png`, style: '.topnav, .tabbar { visibility: hidden; }' });
      }
      const area = page.locator('[data-calendar-scroll-area]');
      if (await area.evaluate(element => element.scrollWidth > element.clientWidth + 1)) {
        await area.focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.querySelector('[data-calendar-scroll-area]').scrollLeft > 0);
        const resource = await page.locator('.home-calendar-resource').first().boundingBox(), box = await area.boundingBox();
        assert.ok(resource.x >= box.x - 1 && resource.x < box.x + 12, 'Resource labels stay visible while scrolling');
      }
      await area.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 110; });
      const heading = await page.locator('.home-calendar-matrix thead th').nth(1).boundingBox(), box = await area.boundingBox();
      assert.ok(heading.y >= box.y - 1 && heading.y < box.y + 25, 'Time headers stay visible while scrolling');
      await area.evaluate(element => { element.scrollTop = 0; });
      await noOverflow();
      const slot = page.locator('[data-availability-slot="pickleball-1-1080"]');
      assert.equal(await slot.getAttribute('href'), `/book/pickleball/${today}/pickleball-1?start=1080`);
      await slot.click();
      await page.getByRole('heading', { name: 'Choose your times', exact: true }).waitFor();
      await page.locator('[data-start="1080"][aria-checked="true"]').waitFor();
      assert.match(await page.locator('.wiz-step').innerText(), /4/);
      assert.equal(new URL(page.url()).searchParams.get('start'), '1080');
      await page.locator('[data-start="1140"]').click();
      assert.equal(await page.locator('[data-start][aria-checked="true"]').count(), 2);
      assert.match(await page.locator('[data-summary]').innerText(), /2 hours/);
      assert.match(await page.locator('[data-summary]').innerText(), /1,000/);
      await noOverflow();
      await page.locator('[data-act="continue"]').click();
      await page.getByRole('heading', { name: 'Booking summary', exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, `/book/pickleball/${today}/pickleball-1/1080,1140`);
    });
  }
  await scenario('Date keyboard navigation, closed/full dates, native picker and table booking', 390, async ({ page, noOverflow }) => {
    await page.locator('.home-calendar-matrix').waitFor();
    const closed = page.locator(`[data-availability-date="${addDays(today, 2)}"]`);
    await closed.focus(); await page.keyboard.press('Enter');
    await page.getByText('Facility event', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-availability-slot]').count(), 0);
    await page.locator(`[data-availability-date="${addDays(today, 3)}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('.home-calendar-slot.booked').length === 18);
    assert.equal(await page.locator('[data-availability-slot]').count(), 0);
    await page.evaluate(() => {
      const showPicker = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.showPicker = function () { window.calendarPickerRequested = true; return showPicker.call(this); };
    });
    await page.getByLabel('Calendar date', { exact: true }).click();
    assert.equal(await page.evaluate(() => window.calendarPickerRequested), true);
    await page.keyboard.press('Escape');
    await page.getByLabel('Calendar date', { exact: true }).fill(addDays(today, 1));
    await page.locator('[data-calendar-activity="table_tennis"]').click();
    await page.locator(`[data-availability-slot="table_tennis-1-960"]`).waitFor();
    assert.equal(await page.locator('.home-calendar-day[aria-pressed="true"]').getAttribute('data-availability-date'), addDays(today, 1));
    assert.equal(await page.getByLabel('Calendar date', { exact: true }).getAttribute('min'), today);
    assert.equal(await page.getByLabel('Calendar date', { exact: true }).getAttribute('max'), addDays(today, 14));
    await noOverflow();
    await page.locator('[data-availability-slot="table_tennis-1-960"]').click();
    await page.locator('[data-start="960"][aria-checked="true"]').waitFor();
    assert.equal(new URL(page.url()).pathname, `/book/table_tennis/${addDays(today, 1)}/table_tennis-1`);
    await page.locator('[data-start="1080"]').click();
    assert.equal(new URL(page.url()).searchParams.get('start'), '960,1080');
  });
  await scenario('Sport filters update date summaries and preserve the selected date across resize', 390, async ({ page, calls, noOverflow }) => {
    const date = addDays(today, 4);
    await page.route('**/api/availability/days?**', route => {
      const activity = new URL(route.request().url()).searchParams.get('activity');
      return route.fulfill({ json: { now, today, days: Array.from({ length: 15 }, (_, index) => ({ date: addDays(today, index), available: activity === 'pickleball' ? 3 : 0, openPlay: 0, load: activity === 'pickleball' ? 'open' : 'full' })) } });
    });
    await page.reload();
    await page.locator('.home-calendar-matrix').waitFor();
    const day = page.locator(`[data-availability-date="${date}"]`);
    await page.waitForFunction(value => document.querySelector(`[data-availability-date="${value}"]`).classList.contains('open'), date);
    await page.locator('[data-calendar-activity="table_tennis"]').focus();
    await page.keyboard.press('Enter');
    assert.match(await day.getAttribute('class'), /full/);
    await day.click();
    await page.locator(`[data-availability-slot="table_tennis-1-960"]`).waitFor();
    const requests = calls.filter(call => call.path === '/api/availability').length;
    for (const width of [320, 768, 1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.locator('[data-calendar-activity][aria-pressed="true"]').getAttribute('data-calendar-activity'), 'table_tennis');
      assert.equal(await page.locator('.home-calendar-day[aria-pressed="true"]').getAttribute('data-availability-date'), date);
      await noOverflow();
    }
    await page.locator('[data-calendar-activity="pickleball"]').click();
    assert.equal(calls.filter(call => call.path === '/api/availability').length, requests, 'Switching sports uses the loaded live availability');
    assert.ok((await page.locator('[data-availability-slot]').first().getAttribute('href')).includes(`/pickleball/${date}/`));
  });
  await scenario('Independent retry states, empty resources and stale date responses', 1440, async ({ page, gridError, datesError, empty, held, release, noOverflow }) => {
    gridError(true); datesError(true); await page.reload();
    await page.getByText("Couldn't load live availability", { exact: true }).waitFor();
    await page.locator('[data-calendar-message]:not([hidden])').waitFor();
    datesError(false); await page.locator('[data-retry-dates]').click();
    await page.waitForFunction(() => document.querySelector('[data-calendar-message]').hidden);
    gridError(false); await page.locator('[data-calendar-grid] [data-act="retry"]').click();
    await page.locator('.home-calendar-matrix').waitFor();
    const pending = page.waitForRequest(request => request.url().includes('/api/availability?') && request.url().includes(addDays(today, 5)));
    await page.locator(`[data-availability-date="${addDays(today, 5)}"]`).click();
    await pending;
    assert.ok(held());
    await page.locator('[data-calendar-activity="table_tennis"]').click();
    await page.locator(`[data-availability-date="${addDays(today, 1)}"]`).click();
    await page.locator(`[data-availability-slot="table_tennis-1-960"]`).waitFor();
    await release();
    assert.equal(await page.locator('[data-calendar-activity][aria-pressed="true"]').getAttribute('data-calendar-activity'), 'table_tennis');
    assert.equal(await page.locator('[data-availability-slot^="pickleball-"]').count(), 0);
    assert.equal(await page.locator('.home-calendar-day[aria-pressed="true"]').getAttribute('data-availability-date'), addDays(today, 1));
    assert.ok((await page.locator('[data-availability-slot]').first().getAttribute('href')).includes(addDays(today, 1)));
    empty(true); await page.locator(`[data-availability-date="${addDays(today, 4)}"]`).click();
    await page.getByText('No courts or tables to show yet', { exact: true }).waitFor();
    await noOverflow();
  });
  await scenario('Step 4 revalidates a slot taken after the calendar loads', 390, async ({ page, taken }) => {
    await page.locator('[data-availability-slot="pickleball-1-1080"]').waitFor();
    taken(true); await page.locator('[data-availability-slot="pickleball-1-1080"]').click();
    await page.locator('.slot.locked.held').first().waitFor();
    assert.equal(await page.locator('[data-start][aria-checked="true"]').count(), 0);
    assert.ok(await page.locator('[data-act="continue"]').isDisabled());
    assert.equal(new URL(page.url()).searchParams.has('start'), false);
    await page.locator('[data-start="1140"]').click();
    assert.equal(new URL(page.url()).searchParams.get('start'), '1140');
  });
  console.log(`Player availability: ${passed} browser scenarios passed.`);
} finally { await browser.close(); }
