// Actual admin screen, mocked API: an acknowledged retry uses the identity of
// the request whose response was lost; a separately opened refund gets a new one.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base)) throw new Error('Use an isolated local server.');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin ? route.fallback() : route.fulfill({contentType:'text/css',body:''}));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls = [];
  const user = { id: 'synthetic_admin', role: 'admin', name: 'Synthetic admin', email: 'admin@example.invalid' };
  const credit = { id: 'synthetic_credit', user: { name: 'Synthetic player', email: 'player@example.invalid' },
    origin: 'manual', state: 'available', stateLabel: 'Available', spendable: true, remaining: 50000, amount: 50000,
    remainingLabel: '₱500', amountLabel: '₱500', reason: 'Synthetic test credit', issuedAt: Date.now(), reserved: 0 };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/refund')) {
      calls.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
      if (calls.length === 1) return route.abort('failed'); // server acceptance is deliberately ambiguous
      return route.fulfill({ json: { refund: { transactionId: 'synthetic-refund' } } });
    }
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { user } });
    if (url.pathname === '/api/admin/credits/synthetic_credit') return route.fulfill({ json: { credit, history: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/admin/credits/synthetic_credit`);
  await page.locator('[data-act="refund"]').click();
  await page.locator('#cr-amount').fill('100');
  await page.locator('#cr-method').selectOption('cash');
  await page.locator('[data-act="go"]').click();
  await page.locator('.toast.error').waitFor();
  await page.locator('[data-act="go"]').click();
  await page.locator('#cr-amount').waitFor({ state: 'detached' });
  assert.equal(calls.length, 2);
  assert.match(calls[0].key, /^[A-Za-z0-9_-]{8,100}$/);
  assert.deepEqual(calls[1], calls[0]);
  await page.locator('[data-act="refund"]').click();
  await page.locator('#cr-method').selectOption('cash');
  await page.locator('[data-act="go"]').click();
  await page.locator('#cr-amount').waitFor({ state: 'detached' });
  assert.equal(calls.length, 3);
  assert.notEqual(calls[2].key, calls[0].key);
  assert.deepEqual(errors, []);
  console.log('Refund browser retry passed: stable key and payload after lost response; distinct key for a new refund.');
} finally {
  await browser.close();
}
