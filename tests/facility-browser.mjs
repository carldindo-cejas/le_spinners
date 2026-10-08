// Real facility edit dialogs; synthetic APIs model a change committed by another operator.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8799';
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const now = Date.now();
const original = { id: 'court', activity: 'pickleball', name: 'Synthetic court', status: 'active',
  maintenanceNote: null, maintenanceUntil: null, upcomingBookings: 0,
  priceMember: 50000, priceNonMember: 60000, priceMemberLabel: '500', priceNonMemberLabel: '600' };
let passed = 0, failed = 0;
async function scenario(name, role, shown, current, edit, expected, open = '[data-edit="court"]') {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const errors = [], patches = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => new URL(route.request().url()).origin === base
      ? route.continue() : route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: 'synthetic-' + role, role, name: 'Synthetic operator', email: 'operator@example.invalid' } } });
      if (path === '/api/facility') return route.fulfill({ json: { now, today: '2026-10-07', tzOffsetMinutes: 480,
        facility: { name: 'Synthetic hub' }, rules: { slotMinutes: 60 }, activities: [] } });
      if (path === `/api/${role}/facilities` && route.request().method() === 'GET') return route.fulfill({ json: { resources: [shown] } });
      if (path === `/api/${role}/facilities/court`) {
        const payload = route.request().postDataJSON();
        const { confirmAffected, ...fields } = payload;
        patches.push(fields);
        Object.assign(current, fields);
        return route.fulfill({ json: { resource: current, affected: [] } });
      }
      if (path.endsWith('/badges')) return route.fulfill({ json: { notifications: 0, chats: 0, holds: [], pendingVerification: 0, unresolved: 0 } });
      return route.fulfill({ json: {} });
    });
    await page.goto(base + `/${role}/facilities`, { waitUntil: 'domcontentloaded' });
    await page.locator(open).click();
    await edit(page);
    await page.locator('.scrim [type="submit"]').click();
    if (expected === null) {
      await page.getByText('Nothing changed', { exact: true }).waitFor();
      assert.deepEqual(patches, []);
    } else {
      await page.waitForFunction(() => !document.querySelector('.scrim'));
      assert.deepEqual(patches, [expected]);
    }
    assert.deepEqual(errors, []);
    passed++;
    console.log('PASS ' + name);
  } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); }
  finally { await page.close(); }
}
try {
  for (const role of ['staff', 'admin']) await scenario(`M09 ${role}: rename preserves a later status change`, role,
    { ...original }, { ...original, status: 'disabled' },
    page => page.locator('#r-name').fill('Renamed court'), { name: 'Renamed court' });
  await scenario('M09 maintenance rename preserves later maintenance details', 'staff',
    { ...original, status: 'maintenance', maintenanceNote: 'Old reason', maintenanceUntil: '2026-11-01' },
    { ...original, status: 'maintenance', maintenanceNote: 'Later reason', maintenanceUntil: '2026-12-01' },
    page => page.locator('#r-name').fill('Renamed court'), { name: 'Renamed court' });
  await scenario('M09 maintenance note edit sends only the changed note', 'admin',
    { ...original, status: 'maintenance', maintenanceNote: 'Old reason', maintenanceUntil: '2026-11-01' },
    { ...original, status: 'maintenance', maintenanceNote: 'Old reason', maintenanceUntil: '2026-12-01' },
    page => page.locator('#r-note').fill('Changed reason'), { maintenanceNote: 'Changed reason' });
  await scenario('M09 explicit maintenance transition sends its dependent fields', 'staff',
    { ...original }, { ...original }, async page => {
      await page.locator('#r-status').selectOption('maintenance');
      await page.locator('#r-note').fill('Resurfacing');
      await page.locator('#r-until').fill('2026-12-01');
    }, { status: 'maintenance', maintenanceNote: 'Resurfacing', maintenanceUntil: '2026-12-01' });
  await scenario('M09 unchanged dialog does not perform an update', 'staff',
    { ...original }, { ...original, status: 'disabled' }, async () => {}, null);
  await scenario('M09 maintenance shortcut compares against the actual active resource', 'staff',
    { ...original }, { ...original }, async page => {
      assert.equal(await page.locator('#r-status').inputValue(), 'maintenance');
      await page.locator('#r-note').fill('Resurfacing');
    }, { status: 'maintenance', maintenanceNote: 'Resurfacing', maintenanceUntil: null }, '[data-maint="court"]');
} finally { await browser.close(); }
console.log(`${passed} facility scenarios passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
