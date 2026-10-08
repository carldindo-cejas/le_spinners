// Real Chromium service-worker lifecycle on a disposable localhost origin.
// Synthetic anonymous APIs; this does not establish Android/iOS installation.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('public');
let generation = 1, apiRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    apiRequests++;
    const data = url.pathname === '/api/auth/session' ? { user: null } : url.pathname === '/api/facility' ? { now: Date.now(), today: '2026-10-07', tzOffsetMinutes: 480, facility: { name: 'Synthetic PWA hub' }, activities: [], hours: [] } : { generation, sequence: apiRequests };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); return;
  }
  let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && !path.extname(url.pathname)) file = path.join(root, /^(\/admin|\/revenue)/.test(url.pathname) ? 'admin/index.html' : url.pathname.startsWith('/staff') ? 'staff/index.html' : 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  const content = fs.readFileSync(file);
  res.end(url.pathname === '/sw.js' ? content.toString().replace(/const VERSION = '[^']+';/, `const VERSION = 'audit-pwa-${generation}';`) : content);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const evidence = { timestamp: new Date().toISOString(), context: 'Chromium localhost; anonymous synthetic API, actual service worker', checks: [] };
function check(name) { evidence.checks.push(name); console.log('PASS PWA ' + name); }
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  await page.goto(base + '/login');
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  check('install, activate and control');
  for (const route of ['/admin/login', '/staff/login', '/login']) await page.goto(base + route);
  await page.evaluate(async () => { await fetch('/js/core/booking-time.js'); await fetch('/api/pwa-probe'); });
  const cachedApi = () => page.evaluate(async () => { const keys = await caches.keys(); const urls = (await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(r => new URL(r.url).pathname)))).flat(); return urls.filter(url => url.startsWith('/api/')); });
  assert.deepEqual(await cachedApi(), []); check('API responses excluded from every cache');
  await context.setOffline(true);
  assert.equal(await page.evaluate(async () => { try { await fetch('/api/pwa-probe'); return 'cached'; } catch { return 'network-failure'; } }), 'network-failure');
  check('offline API fails without cached private data');
  for (const [route, marker] of [['/admin/uncached-pwa-route', '/js/admin/app.js'], ['/staff/uncached-pwa-route', '/js/admin/app.js'], ['/uncached-pwa-route', '/js/player/app.js']]) {
    const response = await page.goto(base + route);
    assert.equal(response.status(), 200); assert.ok((await page.content()).includes(marker));
    check('offline shell fallback ' + route);
  }
  await context.setOffline(false);
  await page.goto(base + '/login');
  generation = 2;
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration(); await registration.update();
    for (let n = 0; n < 100 && !registration.waiting; n++) await new Promise(resolve => setTimeout(resolve, 50));
    if (!registration.waiting) throw Error('Updated worker did not reach waiting state');
    await new Promise(resolve => { navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }); registration.waiting.postMessage('skipWaiting'); });
  });
  await page.waitForFunction(async () => { const keys = await caches.keys(); return keys.includes('audit-pwa-2') && !keys.includes('audit-pwa-1'); });
  check('waiting update, skipWaiting, controller change and old cache removal');
  const cdp = await context.newCDPSession(page); await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
  const before = apiRequests;
  assert.equal(await page.evaluate(async () => (await fetch('/api/pwa-probe')).status), 200);
  assert.ok(apiRequests > before); assert.deepEqual(await cachedApi(), []);
  check('worker termination/restart preserves live API behavior');
  await context.close();
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  fs.mkdirSync('.wrangler', { recursive: true }); fs.writeFileSync('.wrangler/audit-pwa.json', JSON.stringify(evidence, null, 2) + '\n');
}
