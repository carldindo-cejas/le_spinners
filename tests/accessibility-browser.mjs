// Actual shared UI and portal modules; synthetic APIs, keyboard input, no provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8805';
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
const baseline = process.env.ACCESSIBILITY_BASELINE_ROOT && path.resolve(process.env.ACCESSIBILITY_BASELINE_ROOT);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
let passed = 0, failed = 0;
const now = Date.now(), date = '2026-10-08';
const user = (role) => ({ id: 'synthetic-' + role, role, name: 'Synthetic ' + role, email: role + '@example.invalid', membership: 'none' });
const facility = { now, today: date, tzOffsetMinutes: 480, facility: { name: 'Synthetic hub', address: '' }, rules: { slotMinutes: 60, holdMinutes: 10, resubmitMinutes: 15, bookingWindowDays: 14 }, activities: [], hours: [] };
const booking = { id: 'keyboard-proof', ref: 'SYNTHETIC-KEYBOARD', status: 'PAYMENT_SUBMITTED', activity: 'pickleball', activityLabel: 'Pickleball', resource: { id: 'court', name: 'Synthetic court' }, user: user('player'), date, start: 600, end: 660, startsAt: now, endsAt: now + 3600000, amountDue: 50000, amountLabel: 'PHP 500', durationMin: 60, createdAt: now };

async function scenario(name, role, routePath, run) {
  const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.fulfill({ contentType: 'text/css', body: '' });
    if (baseline && (url.pathname.startsWith('/js/') || url.pathname === '/css/admin.css')) {
      const file = path.join(baseline, 'public', url.pathname);
      if (fs.existsSync(file)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file, 'utf8') });
    }
    return route.fallback();
  });
  await context.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/auth/session') return route.fulfill({ json: { user: role === 'guest' ? null : user(role) } });
    if (p === '/api/facility') return route.fulfill({ json: facility });
    if (p.endsWith('/badges')) return route.fulfill({ json: { notifications: 0, chats: 0, holds: [], pendingVerification: 0, unresolved: 0 } });
    if (p.endsWith('/settings') || p.endsWith('/rules')) return route.fulfill({ json: { settings: { holdMinutes: 10, resubmitMinutes: 15, gcashNumber: 'Synthetic' } } });
    if (p.endsWith('/availability')) return route.fulfill({ json: { now, today: date, hours: Array.from({ length: 7 }, () => ({ isOpen: true, open: 480, close: 1320 })), resources: [] } });
    if (p.endsWith('/verifications')) return route.fulfill({ json: { now, counts: { pending: 0, approved: 0, rejected: 0 }, items: [] } });
    if (p === '/api/bookings') return route.fulfill({ json: { now, bookings: [], credits: { available: 0 }, page: { hasMore: false, nextCursor: null } } });
    return route.fulfill({ json: {} });
  });
  try {
    await page.goto(base + routePath);
    await run(page);
    assert.deepEqual(errors, []);
    passed++; console.log('PASS ' + name);
  } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message + (errors.length ? '\n' + errors.join('\n') : '')); }
  finally { await context.close(); }
}
async function viewer(page, decide = false) {
  await page.locator('[data-act="password"]').waitFor();
  await page.evaluate(async ({ booking, decide }) => {
    const { openViewer } = await import('/js/admin/screens/verify.js');
    document.querySelector('[data-act="password"]').focus();
    window.keyboardViewerClose = openViewer({ url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>', booking, proof: {}, canDecide: decide });
  }, { booking, decide });
}
try {
  await scenario('G09 shared rerender preserves calendar-like selected control and containment', 'player', '/profile', async (page) => {
    await page.locator('[data-act="password"]').waitFor();
    await page.evaluate(async () => {
      const { openModal } = await import('/js/core/ui.js'), { html } = await import('/js/core/dom.js');
      let month = 1;
      const m = openModal({ label: 'Synthetic calendar', content: () => html`<button type="button" data-month="1">Next month ${month}</button><button type="button" data-close>Close calendar</button>` });
      m.panel.addEventListener('click', (e) => { if (e.target.matches('[data-month]')) { month++; m.rerender(); } });
    });
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.month), '1');
    assert.match(await page.locator('[data-month]').innerText(), /2$/);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-close')), true);
  });
  await scenario('G09 initial/wrapped focus skips hidden and fieldset-disabled controls', 'player', '/profile', async (page) => {
    await page.locator('[data-act="password"]').waitFor();
    await page.evaluate(async () => {
      const { openModal } = await import('/js/core/ui.js'), { html } = await import('/js/core/dom.js');
      openModal({ label: 'Synthetic focus', content: () => html`<input type="hidden"><button type="button" id="first-keyboard">First</button><fieldset disabled><input id="disabled-keyboard"></fieldset><button type="button" id="last-keyboard">Last</button>` });
    });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'first-keyboard');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'last-keyboard');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'first-keyboard');
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'last-keyboard');
  });
  await scenario('G09 nested modal owns Tab and Escape and returns focus in order', 'player', '/profile', async (page) => {
    await page.locator('[data-act="password"]').waitFor();
    await page.evaluate(async () => {
      const { openModal } = await import('/js/core/ui.js'), { html } = await import('/js/core/dom.js');
      document.querySelector('[data-act="password"]').focus();
      openModal({ label: 'Outer', content: () => html`<button type="button" id="outer-keyboard">Outer</button><button type="button" data-close>Close outer</button>` });
      openModal({ label: 'Inner', content: () => html`<button type="button" id="inner-first">Inner first</button><button type="button" id="inner-last">Inner last</button>` });
    });
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'inner-last');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'inner-first');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.scrim').count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'outer-keyboard');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.scrim').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'password');
  });
  await scenario('M04 failed dialog construction removes listeners/lock before next dialog', 'player', '/profile', async (page) => {
    await page.locator('[data-act="password"]').waitFor();
    const result = await page.evaluate(async () => {
      const { openModal } = await import('/js/core/ui.js'), { html } = await import('/js/core/dom.js');
      let caught = 0;
      try { openModal({ content: () => { throw Error('Synthetic content failure'); } }); } catch { caught++; }
      try { openModal({ content: () => html`<button>Broken opening</button>`, onOpen: () => { throw Error('Synthetic opening failure'); } }); } catch { caught++; }
      const residual = { caught, dialogs: document.querySelectorAll('.scrim').length, overflow: document.body.style.overflow };
      openModal({ label: 'After failure', content: () => html`<button id="after-failure-first">First</button><button id="after-failure-last">Last</button>` });
      return residual;
    });
    assert.deepEqual(result, { caught: 2, dialogs: 0, overflow: '' });
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'after-failure-last');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.scrim').count(), 0);
  });
  await scenario('G09 registration errors preserve original help and password descriptions', 'guest', '/register', async (page) => {
    await page.locator('#f-phone').fill('123'); await page.locator('#f-password').fill('short');
    await page.locator('form [type="submit"]').click();
    const descriptions = await page.evaluate(() => ['f-phone', 'f-password'].map((id) => document.getElementById(id).getAttribute('aria-describedby')));
    assert.match(descriptions[0], /\bphone-help\b/); assert.match(descriptions[0], /\berr-phone-/);
    assert.match(descriptions[1], /\bpw-meter\b/); assert.match(descriptions[1], /\berr-password-/);
    const cleared = await page.evaluate(async () => { const { clearFieldErrors } = await import('/js/core/ui.js'); clearFieldErrors(document.querySelector('form')); return ['f-phone', 'f-password'].map((id) => ({ description: document.getElementById(id).getAttribute('aria-describedby'), invalid: document.getElementById(id).hasAttribute('aria-invalid') })); });
    assert.deepEqual(cleared, [{ description: 'phone-help', invalid: false }, { description: 'pw-meter', invalid: false }]);
  });
  for (const role of ['staff', 'admin']) {
    await scenario(`G09 ${role} proof viewer contains forward/backward Tab and returns focus`, role, `/${role}/profile`, async (page) => {
      await viewer(page);
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-close')), true);
      const contrast = await page.evaluate(() => {
        const control = document.activeElement, style = getComputedStyle(control);
        let parent = control.parentElement, background;
        while (parent) { background = getComputedStyle(parent).backgroundColor; if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break; parent = parent.parentElement; }
        const luminance = (color) => { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((c) => c / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4); return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2]; };
        const foreground = luminance(style.outlineColor), behind = luminance(background);
        return { style: style.outlineStyle, width: style.outlineWidth, contrast: (Math.max(foreground, behind) + .05) / (Math.min(foreground, behind) + .05) };
      });
      assert.equal(contrast.style, 'solid'); assert.equal(contrast.width, '3px'); assert.ok(contrast.contrast >= 3, JSON.stringify(contrast));
      await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.dataset.z), 'rotate');
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-close')), true);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.viewer').count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'password');
    });
    await scenario(`G09 ${role} rejection radio arrow selection and nested viewer return`, role, `/${role}/profile`, async (page) => {
      await viewer(page, true); await page.locator('[data-decide="reject"]').click();
      const radios = page.locator('[data-reason]'); await radios.first().focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.reason), '1');
      assert.equal(await radios.nth(1).getAttribute('aria-checked'), 'true');
      assert.equal(await radios.nth(1).getAttribute('tabindex'), '0');
      assert.equal(await radios.first().getAttribute('tabindex'), '-1');
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.scrim').count(), 0); assert.equal(await page.locator('.viewer').count(), 1);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.decide), 'reject');
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.viewer').count(), 0);
    });
  }
  await scenario('G09 actual disruption category rerender retains radio and error description', 'admin', '/admin/profile', async (page) => {
    await page.locator('[data-act="password"]').waitFor();
    await page.evaluate(async () => { const { openDisruptionDialog } = await import('/js/admin/disrupt.js'); openDisruptionDialog({ title: 'Synthetic disruption', scope: { kind: 'bookings', bookingIds: ['keyboard-proof'] } }); });
    const radios = page.locator('[data-category]'); await radios.first().focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.category), await radios.nth(1).getAttribute('data-category'));
    assert.equal(await radios.nth(1).getAttribute('aria-checked'), 'true');
    await page.locator('[data-act="preview"]').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dz-reason');
    assert.equal(await page.locator('#dz-reason').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#dz-reason').getAttribute('aria-describedby'), 'dz-reason-error');
  });
  for (const role of ['staff', 'admin']) {
    await scenario(`G09 ${role} disruption form category arrow selection and single tab stop`, role, `/${role}/disruptions/new`, async (page) => {
      const radios = page.locator('[data-cat]'); await radios.first().waitFor(); await radios.first().focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await radios.nth(1).evaluate((el) => document.activeElement === el), true);
      assert.equal(await radios.nth(1).getAttribute('aria-checked'), 'true');
      assert.equal(await radios.nth(1).getAttribute('tabindex'), '0');
      assert.equal(await radios.first().getAttribute('tabindex'), '-1');
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'dz-r');
    });
  }
  for (const role of ['player', 'staff', 'admin']) {
    await scenario(`G09 ${role} tabs use arrow focus, explicit activation and associated panel`, role, role === 'player' ? '/bookings' : `/${role}/verify`, async (page) => {
      const tabs = page.locator('[role="tab"]:visible');
      await tabs.first().waitFor(); await tabs.first().focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await tabs.nth(1).evaluate((el) => document.activeElement === el), true);
      assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
      const refresh = page.waitForResponse((r) => /\/(bookings|verifications)$/.test(new URL(r.url()).pathname));
      await page.evaluate(() => window.dispatchEvent(new Event('online'))); await (await refresh).finished();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await tabs.nth(1).evaluate((el) => document.activeElement === el), true);
      assert.equal(await tabs.nth(1).getAttribute('tabindex'), '0');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')].some((el) => el.getClientRects().length && el.getAttribute('aria-selected') === 'true' && el.dataset.tab !== 'upcoming' && el.dataset.tab !== 'pending'));
      const active = tabs.nth(1); assert.equal(await active.evaluate((el) => document.activeElement === el), true);
      const panelId = await active.getAttribute('aria-controls'); assert.ok(panelId);
      assert.equal(await page.locator('#' + panelId).getAttribute('aria-labelledby'), await active.getAttribute('id'));
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'tabpanel');
    });
  }
  for (const role of ['staff', 'admin']) {
    await scenario(`M03 ${role} reversed tab responses cannot overwrite current verification category`, role, `/${role}/verify`, async (page) => {
      let hold;
      const delayed = new Promise((resolve) => { hold = resolve; });
      await page.route('**/verifications?**', (route) => {
        if (new URL(route.request().url()).searchParams.get('tab') === 'approved') { hold(route); return; }
        return route.fallback();
      });
      await page.locator('[data-tab="pending"]:visible').waitFor();
      await page.locator('[data-tab="approved"]:visible').click();
      const held = await delayed;
      await page.locator('[data-tab="rejected"]:visible').click();
      await page.waitForFunction(() => document.querySelector('[data-tab="rejected"][aria-selected="true"]'));
      const response = page.waitForResponse((r) => r.url().includes('/verifications?tab=approved'));
      await held.fulfill({ json: { now, counts: { pending: 91, approved: 92, rejected: 93 }, items: [{ ...booking, user: { ...booking.user, name: 'STALE-APPROVED-RESPONSE' }, status: 'CONFIRMED' }] } });
      await (await response).finished();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal((await page.locator('[data-list]').innerText()).includes('STALE-APPROVED-RESPONSE'), false);
      assert.equal(await page.locator('[data-tab="rejected"]:visible').getAttribute('aria-selected'), 'true');
      assert.match(await page.locator('[data-tab="rejected"]:visible').innerText(), /0/);
    });
  }
} finally { await browser.close(); }
console.log(`${passed} accessibility keyboard/form scenarios passed; ${failed} failed${baseline ? ' against preserved baseline' : ''}`);
if (failed) process.exitCode = 1;
