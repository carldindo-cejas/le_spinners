import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8799';
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
let passed = 0, failed = 0;
const now = Date.now();
const facility = { now, today:'2026-10-07', tzOffsetMinutes:480, facility:{name:'Synthetic hub',address:''},
  rules:{slotMinutes:60,holdMinutes:10,resubmitMinutes:15,bookingWindowDays:14}, hours:[], activities:[] };
const shell = role => role === 'player' ? '/js/player/shell.js' : '/js/admin/shell.js';
const home = role => role === 'player' ? '/' : `/${role}/`;
const profile = role => role === 'player' ? '/profile' : `/${role}/profile`;
const login = role => role === 'player' ? '/login' : `/${role}/login`;

async function scenario(name, run) {
  const context = await browser.newContext({ serviceWorkers:'block' }), page = await context.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.type()==='error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()); });
  await context.route('**/*', async route => {
    if(new URL(route.request().url()).origin === base) return route.fallback();
    if (!route.request().isNavigationRequest()) return route.fulfill({ contentType:route.request().resourceType()==='stylesheet' ? 'text/css' : 'application/octet-stream', body:'' });
    external.push(route.request().url());
    return route.fulfill({ contentType:'text/html', body:'<p>Intercepted external destination</p>' });
  });
  try { await run({context,page,external}); assert.deepEqual(errors,[]); passed++; console.log('PASS ' + name); }
  catch(error) { failed++; console.log('FAIL ' + name + ': ' + error.stack); console.log('URL: ' + page.url()); }
  finally { await context.close(); }
}

async function fixture(context, role, active = false) {
  const user = { id:'synthetic-' + role, role, name:'Synthetic test account', email:role + '@example.invalid', membership:'none' };
  const f = { active, logins:0 };
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if(path==='/api/auth/session') return route.fulfill({json:{user:f.active ? user : null}});
    if(path==='/api/facility') return route.fulfill({json:facility});
    if(path==='/api/auth/salt') return route.fulfill({json:{scheme:'client_pbkdf2_hmac_v1',salt:'AAAAAAAAAAAAAAAAAAAAAA',iterations:600000}});
    if(path==='/api/auth/register' || (path.startsWith('/api/auth/') && path.endsWith('/login'))) {
      f.active=true; f.logins++; return route.fulfill({json:{user}});
    }
    if(path.endsWith('/badges')) return route.fulfill({json:{notifications:0,chats:0,holds:[],unresolved:0,pendingVerification:0}});
    if(path==='/api/bookings') return route.fulfill({json:{bookings:[],credits:{availableLabel:'0'},now}});
    if(/^\/api\/(?:admin|staff)\/summary$/.test(path)) return route.fulfill({json:{now,verification:[],holds:[],todaySchedule:[],counts:{pendingVerification:0,unreadChats:0,activeHolds:0,confirmedToday:0,unresolved:0},verifiedRevenueToday:0}});
    if(/^\/api\/(?:admin|staff)\/messages$/.test(path)) return route.fulfill({json:{conversations:[]}});
    if(path==='/api/admin/revenue/summary') return route.fulfill({json:{today:'2026-10-07',resources:[],periods:[],pendingVerification:{count:0,amount:0}}});
    if(path==='/api/admin/revenue/ledger') return route.fulfill({status:503,json:{error:{message:'Synthetic ledger unavailable'}}});
    return route.fulfill({json:{}});
  });
  return f;
}

async function signIn(page, role, target, { register = false, expected = home(role) } = {}) {
  const route = register ? '/register' : login(role);
  await page.goto(base + route + '?next=' + encodeURIComponent(target));
  await page.locator('input[name="email"]').fill(role + '@example.invalid');
  await page.locator('input[name="password"]').fill('Synthetic-Password-123');
  if(register) {
    await page.locator('input[name="name"]').fill('Synthetic test account');
    await page.locator('input[name="agree"]').check();
  }
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(url => url.pathname !== route, {timeout:15000});
  // Check after the real authentication continuation, including its router handoff.
  assert.equal(page.url(), base + expected);
}

try {
  await scenario('M05 baseline probe: player slash-backslash login stays local', async ({context,page,external}) => {
    await fixture(context,'player'); await signIn(page,'player','/\\audit-redirect.invalid'); assert.deepEqual(external,[]);
  });
  await scenario('M05 baseline probe: registration slash-backslash return stays local', async ({context,page,external}) => {
    await fixture(context,'player'); await signIn(page,'player','/\\audit-redirect.invalid',{register:true}); assert.deepEqual(external,[]);
  });
  await scenario('M05 baseline probe: router cannot navigate off origin', async ({context,page,external}) => {
    await fixture(context,'player',true); await page.goto(base + '/profile'); await page.locator('#main [data-act="logout"]').waitFor();
    await page.evaluate(async module => { (await import(module)).state.router.navigate('http://audit-redirect.invalid'); }, shell('player'));
    await page.waitForURL(url => url.pathname !== '/profile'); assert.equal(page.url(),base + '/'); assert.deepEqual(external,[]);
  });
  if(process.env.BASELINE_ONLY !== '1') {
    const unsafe = ['/%5caudit-redirect.invalid', '/%255caudit-redirect.invalid', '//audit-redirect.invalid',
      'https://audit-redirect.invalid/profile', base.replace('127.0.0.1','localhost') + '/profile',
      base.replace(/:\d+$/,':1') + '/profile', base.replace('://','://user:password@') + '/profile',
      '/profile/../admin/', '/%2e%2e/profile', '/profile?x=%250a', '/profile\t',
      '/admin/login', '/staff/login', '/revenue/../staff/', '/api/auth/logout', '/profile//'];
    for(const role of ['player','admin','staff']) {
      await scenario(`M05 ${role}: malicious login return matrix`, async ({context,page,external}) => {
        const f=await fixture(context,role);
        for(const target of unsafe) { f.active=false; await signIn(page,role,target); }
        assert.equal(f.logins,unsafe.length); assert.deepEqual(external,[]);
      });
      await scenario(`M05 ${role}: local and exact-origin deep links retain query/fragment`, async ({context,page,external}) => {
        const f=await fixture(context,role);
        const target=profile(role) + '?tab=account&label=court%20one#profile-details';
        await signIn(page,role,target,{expected:target});
        f.active=false; await signIn(page,role,base + target,{expected:target});
        assert.equal(f.logins,2); assert.deepEqual(external,[]);
      });
      await scenario(`M05 ${role}: already signed-in login honors a safe deep link`, async ({context,page,external}) => {
        await fixture(context,role,true);
        const target=profile(role) + '?tab=account#profile-details';
        await page.goto(base + login(role) + '?next=' + encodeURIComponent(target));
        await page.waitForURL(base + target); assert.deepEqual(external,[]);
      });
      await scenario(`M05 ${role}: already signed-in login rejects a hostile return`, async ({context,page,external}) => {
        await fixture(context,role,true);
        await page.goto(base + login(role) + '?next=' + encodeURIComponent('/\\audit-redirect.invalid'));
        await page.waitForURL(base + home(role)); assert.deepEqual(external,[]);
      });
      await scenario(`M05 ${role}: guarded deep link retains search/fragment through login`, async ({context,page,external}) => {
        await fixture(context,role);
        const target=profile(role) + '?tab=account#profile-details';
        await page.goto(base + target); await page.locator('input[name="email"]').waitFor();
        assert.equal(new URL(page.url()).searchParams.get('next'),target);
        await page.locator('input[name="email"]').fill(role + '@example.invalid');
        await page.locator('input[name="password"]').fill('Synthetic-Password-123');
        await page.locator('form button[type="submit"]').click();
        await page.waitForURL(base + target); assert.deepEqual(external,[]);
      });
      await scenario(`M05 ${role}: router rejects raw/encoded hostile forms`, async ({context,page,external}) => {
        await fixture(context,role,true); await page.goto(base + profile(role));
        await page.locator('#main [data-act="logout"]').waitFor();
        for(const target of ['/\\audit-redirect.invalid','/%5caudit-redirect.invalid','//audit-redirect.invalid',
          'http://audit-redirect.invalid', '/profile/../admin/', '/profile\n']) {
          await page.evaluate(async ({module,target}) => (await import(module)).state.router.navigate(target), {module:shell(role),target});
          assert.equal(page.url(),base + home(role));
        }
        assert.deepEqual(external,[]);
      });
      await scenario(`M05 ${role}: session-expiry return retains query/fragment`, async ({context,page}) => {
        await fixture(context,role,true);
        const target=profile(role) + '?tab=account#profile-details';
        await page.goto(base + target); await page.locator('#main [data-act="logout"]').waitFor();
        await page.evaluate(async module => (await import(module)).showSessionExpired(),shell(role));
        await page.waitForURL(url=>url.pathname===login(role));
        assert.equal(new URL(page.url()).searchParams.get('next'),target);
      });
    }
    await scenario('M05 player: registration and login links carry the validated target', async ({context,page,external}) => {
      await fixture(context,'player');
      const target='/profile?tab=account#profile-details';
      await page.goto(base + '/login?next=' + encodeURIComponent(target));
      const link=page.locator('a[href^="/register"]');
      assert.equal(new URL(await link.getAttribute('href'),base).searchParams.get('next'),target);
      await link.click(); await page.locator('input[name="name"]').waitFor();
      assert.equal(new URL(await page.locator('a[href^="/login"]').first().getAttribute('href'),base).searchParams.get('next'),target);
      await signIn(page,'player',target,{register:true,expected:target}); assert.deepEqual(external,[]);
    });
    await scenario('M05 player: registration rejects encoded backslashes and foreign origins', async ({context,page,external}) => {
      const f=await fixture(context,'player');
      for(const target of ['/%5caudit-redirect.invalid','/%255caudit-redirect.invalid','//audit-redirect.invalid',
        'https://audit-redirect.invalid/profile','/profile/../admin/']) {
        f.active=false; await signIn(page,'player',target,{register:true});
      }
      assert.deepEqual(external,[]);
    });
    await scenario('M05 admin: revenue returns stay in the authorized console', async ({context,page,external}) => {
      await fixture(context,'admin');
      await signIn(page,'admin','/revenue/?from=2026-01-01#totals',{expected:'/revenue/?from=2026-01-01#totals'}); assert.deepEqual(external,[]);
    });
  }
} finally { await browser.close(); }
console.log(`Redirect browser scenarios: ${passed} passed, ${failed} failed`);
if(failed) process.exitCode=1;
