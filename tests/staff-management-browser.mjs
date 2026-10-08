import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8805';
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const now = Date.now(); let passed = 0;
async function scenario(name, width, role, path, run, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], calls = [];
  let accounts = [
    { id: 'active', name: 'Synthetic Staff', email: 'staff@example.invalid', role: 'staff', status: 'active', createdAt: now, updatedAt: now, authVersion: 1 },
    { id: 'inactive', name: 'Long staff name '.repeat(5), email: 'long'.repeat(45) + '@example.invalid', role: 'staff', status: 'disabled', createdAt: now - 1000, updatedAt: now, authVersion: 1 },
  ];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.fulfill({ body: '', contentType: 'text/css' }));
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() : null; calls.push({ p, method, body, q: url.searchParams.get('q') });
    const reply = json => route.fulfill({ json });
    if (p === '/api/auth/session') return reply({ user: role ? { id: 'operator', role, email: 'admin@example.invalid', name: 'Synthetic Admin' } : null });
    if (p.endsWith('/badges')) return reply({ unresolved: 0, unreadChats: 0, pendingVerification: 0, activeHolds: 0, holds: [] });
    if (p === '/api/auth/salt') return reply({ scheme: 'client_pbkdf2_hmac_v1', iterations: 600000, salt: 'S'.repeat(22) });
    if (p === '/api/facility') return reply({ now, today: '2026-10-09', facility: {}, rules: {}, activities: [] });
    if (p.endsWith('/summary')) return reply({ now, verification: [], holds: [], todaySchedule: [], counts: { pendingVerification: 0, activeHolds: 0, confirmedToday: 0, unresolved: 0, unreadChats: 0 }, ...(role === 'admin' ? { verifiedRevenueToday: 0 } : {}) });
    if (p.endsWith('/messages')) return reply({ conversations: [] });
    if (p === '/api/admin/staff' && method === 'GET') {
      if (options.errorOnce) { options.errorOnce = false; return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'Synthetic list error' } } }); }
      const q = (url.searchParams.get('q') || '').toLowerCase(), status = url.searchParams.get('status');
      const filtered = accounts.filter(row => (!q || (row.name + row.email).toLowerCase().includes(q)) && (!status || row.status === status));
      const second = url.searchParams.has('cursor');
      if (options.pages) return reply({ staff: [filtered[second ? 1 : 0]], page: { hasMore: !second, nextCursor: second ? null : 'second' } });
      return reply({ staff: filtered, page: { hasMore: false, nextCursor: null } });
    }
    if (p === '/api/admin/staff' && method === 'POST') {
      if (body.email === 'duplicate@example.invalid') return route.fulfill({ status: 409, json: { error: { code: 'EMAIL_TAKEN', message: 'Email already registered', details: { email: ['Already registered.'] } } } });
      const row = { id: 'created', name: body.name, email: body.email, role: 'staff', status: body.status, createdAt: now, updatedAt: now, authVersion: 1 }; accounts.unshift(row);
      return route.fulfill({ status: 201, json: { staff: row } });
    }
    const match = /^\/api\/admin\/staff\/([^/]+)(\/reset-password)?$/.exec(p);
    if (match) {
      if (options.expireOnSave) return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'Session ended' } } });
      const row = accounts.find(account => account.id === match[1]);
      if (match[2]) row.authVersion++;
      else { for (const key of ['name', 'email', 'status']) if (body[key] !== undefined) row[key] = body[key]; }
      row.updatedAt++; return reply({ staff: row });
    }
    return reply({});
  });
  try {
    await page.goto(base + path, { waitUntil: 'domcontentloaded' });
    await run({ page, calls, options }); assert.deepEqual(errors, []); passed++; console.log('PASS ' + name);
  } finally { await context.close(); }
}
const dialog = page => page.locator('.scrim');
const closed = page => page.waitForFunction(() => !document.querySelector('.scrim'));
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
try {
  for (const width of [320, 375, 390, 430, 768, 1440]) await scenario('Staff list responsive at ' + width, width, 'admin', '/admin/staff', async ({ page }) => {
    await page.locator('[data-edit="active"]:visible').waitFor();
    assert.equal(await page.locator('.staff-table').isVisible(), width >= 1024);
    assert.equal(await page.locator('.staff-card').first().isVisible(), width < 1024);
    assert.equal(await overflow(page), false);
    if (width >= 1024) {
      assert.deepEqual(await page.locator('.sb-group').last().locator('.sb-item').allTextContents(), ['Staff Management', 'Settings']);
      assert.equal(await page.locator('a.sb-item[href="/admin/staff"]').getAttribute('aria-current'), 'page');
    }
    await page.locator('[data-add]:visible').click(); await dialog(page).waitFor();
    assert.equal(await page.locator('#staff-name').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape'); await closed(page);
    assert.equal(await page.locator('[data-add]:visible').evaluate(el => el === document.activeElement), true);
  });
  await scenario('Mobile More places staff management above Settings', 390, 'admin', '/admin/more', async ({ page }) => {
    const links = await page.locator('nav[aria-label="People and alerts"] a').allTextContents();
    assert.ok(links.findIndex(text => text.includes('Staff Management')) + 1 === links.findIndex(text => text.includes('Settings')));
    await page.locator('a[href="/admin/staff"]:visible').click(); await page.locator('[data-staff-page]').waitFor();
  });
  for (const role of ['admin', 'staff']) await scenario('Dashboard header identifies ' + role, 390, role, `/${role}/`, async ({ page }) => {
    await page.locator('.tb-mobile .sb-brand .n2').waitFor(); assert.equal(await page.locator('.tb-mobile .sb-brand .n2').textContent(), role.toUpperCase());
    if (role === 'staff') assert.equal(await page.locator('a[href="/admin/staff"]').count(), 0);
  });
  for (const role of ['staff', 'player']) await scenario('Management UI refuses ' + role, 1440, role, '/admin/staff', async ({ page, calls }) => {
    await page.getByText(role === 'staff' ? 'Staff Management is for administrators' : "This account can't open the admin console").waitFor();
    assert.equal(await page.locator('[data-staff-page]').count(), 0); assert.equal(calls.some(call => call.p === '/api/admin/staff'), false);
  });
  await scenario('Anonymous management deep link points to admin login', 390, null, '/admin/staff', async ({ page }) => {
    await page.waitForURL('**/admin/login?next=*'); assert.equal(new URL(page.url()).searchParams.get('next'), '/admin/staff');
  });
  await scenario('Search, status filter and empty state', 390, 'admin', '/admin/staff', async ({ page }) => {
    await page.locator('[data-edit="active"]:visible').waitFor();
    await page.locator('[data-search]').fill('nobody'); await page.getByText('No staff accounts match').waitFor();
    await page.locator('[data-search]').fill(''); await page.locator('[data-status-filter]').selectOption('disabled');
    await page.locator('[data-edit="inactive"]:visible').waitFor(); assert.equal(await page.locator('[data-edit="active"]:visible').count(), 0);
  });
  await scenario('Bounded cursor pagination moves forward and back', 1440, 'admin', '/admin/staff', async ({ page }) => {
    await page.locator('[data-edit="active"]:visible').waitFor(); await page.getByRole('button', { name: 'Older', exact: true }).click();
    await page.locator('[data-edit="inactive"]:visible').waitFor(); await page.getByRole('button', { name: 'Newer', exact: true }).click();
    await page.locator('[data-edit="active"]:visible').waitFor();
  }, { pages: true });
  await scenario('Failed list supports retry', 390, 'admin', '/admin/staff', async ({ page }) => {
    await page.getByText('Synthetic list error').waitFor(); await page.getByRole('button', { name: 'Try again' }).click(); await page.locator('[data-edit="active"]:visible').waitFor();
  }, { errorOnce: true });
  await scenario('Add validates password confirmation and duplicates, then creates inactive staff', 390, 'admin', '/admin/staff', async ({ page, calls }) => {
    await page.locator('[data-add]:visible').click(); await page.locator('#staff-name').fill('New Staff'); await page.locator('#staff-email').fill('duplicate@example.invalid');
    await page.locator('#staff-password').fill('secure-staff-pass'); await page.locator('#staff-confirm').fill('different-pass'); await dialog(page).locator('[type="submit"]').click();
    await page.getByText('Passwords must match.').waitFor(); assert.equal(calls.filter(call => call.p === '/api/admin/staff' && call.method === 'POST').length, 0);
    await page.locator('#staff-confirm').fill('secure-staff-pass'); await dialog(page).locator('[type="submit"]').click(); await page.getByText('Already registered.').waitFor();
    await page.locator('#staff-email').fill('new@example.invalid'); await page.locator('#staff-status').selectOption('disabled'); await dialog(page).locator('[type="submit"]').click(); await closed(page);
    await page.locator('[data-edit="created"]:visible').waitFor();
    const create = calls.filter(call => call.p === '/api/admin/staff' && call.method === 'POST').at(-1);
    assert.equal(create.body.status, 'disabled'); assert.equal(create.body.password.scheme, 'client_pbkdf2_hmac_v1'); assert.equal(create.body.password.iterations, 600000);
    assert.ok(!JSON.stringify(create.body).includes('secure-staff-pass')); assert.equal('role' in create.body, false);
  });
  await scenario('Editing, status confirmation and secure administrator reset', 1440, 'admin', '/admin/staff', async ({ page, calls }) => {
    await page.locator('[data-edit="active"]:visible').click(); await page.locator('#staff-name').fill('Renamed Staff'); await dialog(page).locator('[type="submit"]').click(); await closed(page);
    await page.locator('[data-status="active"]:visible').click(); await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await closed(page);
    assert.equal(calls.some(call => call.body?.status), false);
    await page.locator('[data-status="active"]:visible').click(); await dialog(page).locator('[type="submit"]').click(); await closed(page);
    await page.locator('[data-reset="active"]:visible').click(); await page.getByText('This account will remain inactive.', { exact: false }).waitFor();
    await page.locator('#staff-password').fill('replacement-pass'); await page.locator('#staff-confirm').fill('replacement-pass'); await page.locator('#staff-admin-password').fill('administrator-pass');
    await dialog(page).locator('[type="submit"]').click(); await closed(page);
    const reset = calls.find(call => call.p.endsWith('/reset-password')); assert.ok(reset.body.currentClientHash); assert.ok(reset.body.newPassword.clientHash);
    assert.ok(!JSON.stringify(reset.body).includes('replacement-pass')); assert.ok(!JSON.stringify(reset.body).includes('administrator-pass'));
  });
  await scenario('Session revocation closes pending form and clears account view', 390, 'admin', '/admin/staff', async ({ page }) => {
    await page.locator('[data-edit="active"]:visible').click(); await page.locator('#staff-name').fill('Later Name'); await dialog(page).locator('[type="submit"]').click();
    await page.waitForURL('**/admin/login*'); assert.equal(await page.locator('[data-staff-page]').count(), 0);
  }, { expireOnSave: true });
} finally { await browser.close(); }
console.log(`${passed} staff management browser scenarios passed`);
