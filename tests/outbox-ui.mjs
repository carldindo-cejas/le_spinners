// Actual settings screen, synthetic API: delivery labels, filtering and failed refresh.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base)) throw new Error('Use an isolated local server.');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
try {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin ? route.fallback() : route.fulfill({contentType:'text/css',body:''}));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = Date.now();
  const user = { id: 'synthetic_admin', role: 'admin', name: 'Synthetic admin', email: 'admin@example.invalid' };
  const settings = { canEdit: true, delivery: { email: 'disabled' }, resources: [], settings: {
    holdMinutes: 10, resubmitMinutes: 15, bookingWindowDays: 14, cancelCutoffHours: 24,
    warnMinutes: 2, slotMinutes: 60, gcashName: 'Synthetic account', gcashNumber: '00000000000',
    hasQr: false, staffAlertEmails: [], staffAlertSms: [], facilityName: 'Synthetic facility', facilityAddress: 'Test address',
  } };
  const row = (id, deliveryState, statusLabel, fields = {}) => ({ id, channel: 'email', recipient: `${id}@example.invalid`,
    subject: `Synthetic ${id}`, deliveryState, statusLabel, status: 'queued', attempts: 1, createdAt: now, ...fields });
  const review = row('old-review', 'needs_review', 'Delivery unconfirmed — review required', { lastError: 'REPLAY_WINDOW_CLOSED', createdAt: now - 86400000 });
  const delivery = { emailEnabled: false, smsEnabled: false, emailPausedUntil: now + 600000,
    summary: { needs_review: 1, failed: 0, retry: 1, unsupported: 1 }, items: [
      row('accepted', 'accepted', 'Accepted by email provider', { status: 'sent' }),
      row('retry', 'retry', 'Retry scheduled', { nextAttemptAt: now + 120000 }),
      row('sms', 'unsupported', 'SMS not connected', { channel: 'sms', attempts: 0 }),
    ] };
  const filters = [];
  let fail = false;
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { user } });
    if (url.pathname === '/api/admin/settings') return route.fulfill({ json: settings });
    if (url.pathname === '/api/admin/storage-health') return route.fulfill({ json: {
      expiredUploads: 1, cleanupPending: 2, deleteFailures: 1, needsReview: 1, oldestPendingAt: now - 86400000, legacyScanEnabled: false,
    } });
    if (url.pathname === '/api/admin/outbox') {
      filters.push(url.searchParams.get('state'));
      if (fail) return route.fulfill({ status: 503, json: { error: { message: 'Synthetic refresh failure', code: 'TEST_FAILURE' } } });
      return route.fulfill({ json: url.searchParams.get('state') === 'needs_review' ? { ...delivery, items: [review] } : delivery });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/admin/settings`);
  const view = page.locator('[data-delivery]');
  await view.getByText('Accepted by email provider', { exact: true }).waitFor();
  assert.match(await view.innerText(), /Retry scheduled/i);
  assert.match(await view.innerText(), /SMS not connected/i);
  assert.match(await view.innerText(), /1 need review.*1 waiting to retry.*1 unsent SMS/);
  assert.match(await view.innerText(), /Email sending is not configured/);
  assert.match(await view.innerText(), /Email sending is paused until/);
  assert.match(await page.locator('#outbox').innerText(), /Provider acceptance does not confirm arrival/);
  assert.match(await page.locator('#storage').innerText(), /1 uploads waiting for recovery.*2 waiting for cleanup.*1 cleanup retries.*1 need review/);
  assert.match(await page.locator('#storage').innerText(), /Historical file scanning is disabled/);
  await page.locator('[data-delivery-filter]').selectOption('needs_review');
  await view.getByText('old-review@example.invalid', { exact: true }).waitFor();
  assert.match(await view.innerText(), /Delivery unconfirmed — review required/i);
  assert.match(await view.innerText(), /REPLAY_WINDOW_CLOSED/);
  assert.deepEqual(filters, [null, 'needs_review']);
  fail = true;
  await page.locator('[data-act="delivery-refresh"]').click();
  await page.locator('.toast.error').waitFor();
  assert.equal(await page.locator('[data-delivery-filter]').isEnabled(), true);
  assert.equal(await page.locator('[data-act="delivery-refresh"]').isEnabled(), true);
  assert.match(await view.innerText(), /old-review@example.invalid/);
  assert.deepEqual(errors, []);
  console.log('Outbox browser checks passed: truthful status/configuration, review filter, failed refresh and no page errors.');
} finally { await browser.close(); }
