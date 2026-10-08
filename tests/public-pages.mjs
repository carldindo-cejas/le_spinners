/** Browser regression checks. Start npm run dev, then run with Playwright installed:
 * BASE_URL=http://127.0.0.1:8787 node tests/public-pages.mjs
 * Optional PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE select an existing local install.
 * API fixtures keep these UI checks independent of accounts and database contents.
 */
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/, 'Use an isolated local browser fixture.');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const today = '2026-10-06';
const facility = {
  today, now: Date.parse(`${today}T01:00:00Z`), tzOffsetMinutes: 480,
  facility: { name: 'Le Spinners Recreational Hub', address: 'Manila, Philippines' },
  rules: { bookingWindowDays: 14, slotMinutes: 60, holdMinutes: 10 },
  hours: [{ weekday: 2, name: 'Tuesday', isOpen: true, label: '8:00 AM – 10:00 PM' }],
  activities: ['pickleball', 'table_tennis'].map((id) => ({ id, count: 4, priceMemberLabel: '₱500', priceNonMemberLabel: '₱600' })),
};
let calendarMode = 'open';
let calendarRevision = 0;
const errors = [];

async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Horizontal overflow at ${page.url()}`);
}

async function swipe(page, selector, direction) {
  await page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await page.locator(selector).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const start = box.x + box.width * (direction > 0 ? .85 : .15);
  const end = box.x + box.width * (direction > 0 ? .15 : .85);
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] });
  for (let i = 1; i <= 16; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start + (end - start) * i / 16, y }] });
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function sportsIndex(page, index) {
  // Wait for the actual settled control update instead of assuming Chromium's
  // native/smooth scroll and the app's 160 ms settle timer finish in 700 ms.
  await page.waitForFunction(expected => document.querySelector('.lp-sports + .lp-carousel-controls span')?.textContent.startsWith(`${expected} / 2`), index);
  assert.match(await page.locator('.lp-sports + .lp-carousel-controls').innerText(), new RegExp(`^${index} / 2`));
}

async function resourceIndex(page, index) {
  await page.waitForFunction(expected => document.querySelector('.lp-resource-grid + .lp-carousel-controls span')?.textContent.startsWith(`${expected} / 4`), index);
}

try {
  for (const width of [320, 375, 430, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: width <= 760, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin ? route.fallback() : route.fulfill({contentType:'text/css',body:''}));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      let body;
      if (url.pathname === '/api/auth/session') body = { user: null };
      else if (url.pathname === '/api/facility') body = facility;
      else if (url.pathname === '/api/facility/calendar') {
        if (calendarMode === 'error') return route.fulfill({ status: 503, json: { error: { message: 'Try again later' } } });
        const activity = url.searchParams.get('activity');
        assert.ok(['pickleball', 'table_tennis'].includes(activity));
        body = {
          ...facility, dateLabel: 'Tuesday, October 6', lastDate: '2026-10-20', slotMinutes: 60, open: calendarMode !== 'closed',
          resources: Array.from({ length: 4 }, (_, i) => ({ id: `${activity}-${i}`, activity, name: `${activity === 'pickleball' ? 'Court' : 'Table'} ${i + 1}`, slots: [
            { state: 'available', label: '10:00 AM', start: 600, end: 660 },
            { state: i === 0 && calendarRevision ? 'held' : 'booked', label: '11:00 AM', start: 660, end: 720 },
          ] })),
        };
      } else return route.continue();
      await route.fulfill({ json: body });
    });

    for (const path of ['/', '/sports-rates', '/court-calendar']) {
      await page.goto(base + path);
      await page.waitForSelector('.lp');
      if (path === '/court-calendar') await page.waitForSelector('.lp-resource');
      await noOverflow(page);
      assert.match(await page.locator('.lp-footer').innerText(), /© Le Spinners Recreational Hub — Since 2026\./);
      assert.equal(await page.locator('.lp-footer a').count(), 1);
      await page.evaluate(() => window.scrollTo(0, 500));
      assert.equal(await page.locator('.lp-header').evaluate((el) => el.getBoundingClientRect().top), 0);
    }

    await page.locator('.lp-nav a[href="/sports-rates"]').click();
    await page.waitForURL('**/sports-rates');
    if (width <= 760) {
      for (const name of ['Next Sports', 'Previous Sports']) {
        for (let i = 0; i < 4; i++) {
          await page.getByRole('button', { name, exact: true }).click();
          await sportsIndex(page, i % 2 ? 1 : 2);
        }
      }
      await swipe(page, '.lp-sports', 1);
      await sportsIndex(page, 2);
      await swipe(page, '.lp-sports', 1);
      await sportsIndex(page, 1);
      await noOverflow(page);
    } else assert.equal(await page.locator('.lp-sport').count(), 2);

    await page.locator('.lp-nav a[href="/court-calendar"]').click();
    await page.waitForSelector('.lp-resource');
    assert.equal(await page.locator('[data-sport]').count(), 2);
    assert.equal(await page.locator('select').count(), 0);
    assert.equal(await page.locator('[data-sport="pickleball"]').getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Next Pickleball courts', exact: true }).click();
    await resourceIndex(page, 2);
    assert.ok(await page.locator('.lp-resource-grid').evaluate((el) => el.scrollLeft > 0));
    const scroll = await page.locator('.lp-resource-grid').evaluate((el) => el.scrollLeft);
    calendarRevision++;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(700);
    assert.ok(Math.abs(await page.locator('.lp-resource-grid').evaluate((el) => el.scrollLeft) - scroll) < 2);
    await page.locator('[data-sport="table_tennis"]').click();
    await page.waitForSelector('.lp-resource h4:text-is("Table 1")');
    assert.equal(await page.locator('.lp-resource-grid').evaluate((el) => el.scrollLeft), 0);
    assert.equal(await page.locator('.lp-resource h4').first().innerText(), 'Table 1');
    if (width <= 760) {
      await swipe(page, '.lp-resource-grid', 1);
      await resourceIndex(page, 2);
      assert.ok(await page.locator('.lp-resource-grid').evaluate((el) => el.scrollLeft > 0));
    }
    const beforeKey = await page.locator('.lp-resource-grid').evaluate((el) => el.scrollLeft);
    await page.locator('.lp-resource-grid').focus();
    await page.keyboard.press('ArrowRight');
    await resourceIndex(page, width <= 760 ? 3 : 2);
    assert.ok(await page.locator('.lp-resource-grid').evaluate((el, previous) => el.scrollLeft > previous, beforeKey));
    await noOverflow(page);
    const slotHref = await page.locator('.lp-slot.available').first().getAttribute('href');
    assert.match(decodeURIComponent(slotHref), /\/login\?next=\/book\/table_tennis\/2026-10-06\//);
    if (width === 375) {
      calendarMode = 'closed';
      await page.locator('[data-refresh]').click();
      await page.waitForSelector('.lp-calendar-message:text-matches("closed")');
      calendarMode = 'error';
      await page.locator('[data-refresh]').click();
      await page.waitForSelector('[data-retry]');
      calendarMode = 'open';
      await page.locator('[data-retry]').click();
      await page.waitForSelector('.lp-resource');
    }

    await page.locator('.lp-nav a[href="/#how-it-works"]').click();
    await page.waitForURL('**/#how-it-works');
    assert.deepEqual(await page.locator('section').evaluateAll((els) => els.map((el) => el.id)), ['', 'how-it-works', 'visit']);
    const heading = await page.locator('#how-it-works').boundingBox();
    const header = await page.locator('.lp-header').boundingBox();
    assert.ok(heading.y >= header.height);
    await page.goBack();
    await page.waitForSelector('.lp-resource');
    await page.goForward();
    await page.waitForSelector('#how-it-works');
    await page.locator('.lp-header .lp-brand').click();
    await page.waitForURL(base + '/');
    assert.equal(await page.evaluate(() => scrollY), 0);
    console.log(`PASS ${width}px: routing, sticky navbar, footer, layout and carousels`);
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
