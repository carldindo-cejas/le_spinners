import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL||'http://127.0.0.1:8799';
assert.match(base,/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined});
let passed=0,failed=0;
const now=Date.now(),today=new Date(now).toISOString().slice(0,10);
const facility={now,today,tzOffsetMinutes:480,facility:{name:'Synthetic hub',address:''},rules:{slotMinutes:60,holdMinutes:10,resubmitMinutes:15,bookingWindowDays:14},hours:Array.from({length:7},(_,weekday)=>({weekday,isOpen:true,label:'8 AM - 10 PM'})),activities:[]};
const path=(role,name)=>role==='player'?`/${name}`:`/${role}/${name}`;
const shell=role=>role==='player'?'/js/player/shell.js':'/js/admin/shell.js';
async function scenario(name,run){if(process.env.LOGOUT_FILTER&&!name.includes(process.env.LOGOUT_FILTER))return;const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  context.on('page',p=>watch(p));watch(page);function watch(p){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource:'))errors.push(m.text());});}
  try{await run({context,page,errors});assert.deepEqual(errors,[]);passed++;console.log('PASS '+name);}catch(error){failed++;console.log('FAIL '+name+': '+error.stack);console.log('Failure URL: '+page.url());}finally{await context.close();}}
async function fixture(context,role){
  await context.route('**/*',route=>new URL(route.request().url()).origin===base ? route.fallback() : route.fulfill({contentType:'text/css',body:''}));
  const user={id:'synthetic-'+role,role,name:'PRIVATE SYNTHETIC NAME',email:role+'@example.invalid',membership:'none'};
  const f={user,mode:'hold',logoutCalls:0,loginCalls:0,sessionCalls:0,active:true,pending:[]};
  await context.addCookies([{name:'ls_session',value:'old-synthetic',httpOnly:true,sameSite:'Lax',url:base}]);
  await context.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),p=url.pathname;
    if(p==='/api/auth/session'){f.sessionCalls++;return route.fulfill({json:{user:f.active?user:null}});}
    if(p==='/api/facility')return route.fulfill({json:facility});
    if(p==='/api/bookings')return route.fulfill({json:{bookings:[],credits:{availableLabel:'0'},now}});
    if(p.endsWith('/badges'))return route.fulfill({json:{notifications:0,chats:0,holds:[],unresolved:0,pendingVerification:0}});
    if(p==='/api/auth/salt')return route.fulfill({json:{scheme:'client_pbkdf2_hmac_v1',salt:'AAAAAAAAAAAAAAAAAAAAAA',iterations:600000}});
    if(p.startsWith('/api/auth/')&&p.endsWith('/login')){f.loginCalls++;f.active=true;return route.fulfill({headers:{'set-cookie':'ls_session=new-synthetic; Path=/; HttpOnly; SameSite=Lax'},json:{user}});}
    if(p==='/api/auth/logout'){
      f.logoutCalls++;
      if(f.mode==='hold'){f.pending.push(route);return;}
      if(f.mode==='offline')return route.abort('internetdisconnected');
      if(f.mode==='lost'){f.active=false;return route.abort('failed');}
      if(f.mode==='500')return route.fulfill({status:500,json:{error:{code:'TEST',message:'Synthetic unavailable'}}});
      if(f.mode==='malformed')return route.fulfill({json:{}});
      f.active=false;return route.fulfill({headers:{'set-cookie':'ls_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'},json:{ok:true}});
    }
    return route.fulfill({json:{}});
  });return f;
}
async function privatePage(page,role){await page.goto(base+path(role,'profile'));await page.locator('#main [data-act="logout"]').waitFor();}
async function pending(page){await page.locator('[data-logout-status]').waitFor({timeout:1800});assert.equal(await page.locator('input[name="password"]').count(),0);assert.equal((await page.locator('#main').innerText()).includes('PRIVATE SYNTHETIC NAME'),false);}
async function retryReady(page){await page.waitForFunction(()=>{const b=document.querySelector('[data-logout-retry]');return b&&!b.disabled;});}
async function confirmed(page){await page.locator('[data-logout-confirmed]').waitFor();assert.equal(await page.locator('[data-logout-status]').count(),0);await page.locator('input[name="password"]').waitFor();}
async function state(page,role){return page.evaluate(async module=>(await import(module)).state.user,shell(role));}
async function navigate(page,role,name){await page.evaluate(async({module,to})=>(await import(module)).state.router.navigate(to),{module:shell(role),to:path(role,name)});}
try{
  for(const role of ['player','admin','staff'])await scenario(`M02 baseline probe ${role}: pending logout immediately hides private content`,async({context,page})=>{
    const f=await fixture(context,role);await privatePage(page,role);
    if(process.env.BASELINE_ONLY!=='1')await page.evaluate(async()=>{const {toast,announce}=await import('/js/core/ui.js');toast('PRIVATE-TOAST-BOOKING',{timeout:0});announce('PRIVATE-LIVE-BOOKING');});
    await page.locator('#main [data-act="logout"]').click();await pending(page);
    assert.equal(await state(page,role),null);assert.equal(await page.locator('.scrim').count(),0);assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
    if(process.env.BASELINE_ONLY!=='1'){await page.waitForTimeout(60);const text=await page.evaluate(()=>document.body.textContent);for(const privateText of ['PRIVATE SYNTHETIC NAME','PRIVATE-TOAST-BOOKING','PRIVATE-LIVE-BOOKING'])assert.equal(text.includes(privateText),false,'Hidden chrome/toasts/announcements must also be cleared');}
    if(process.env.BASELINE_ONLY!=='1'){for(let n=0;n<100&&!f.pending.length;n++)await page.waitForTimeout(10);assert.equal(f.logoutCalls,1);f.active=false;await f.pending[0].fulfill({json:{ok:true},headers:{'set-cookie':'ls_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'}});await confirmed(page);}
  });
  if(process.env.BASELINE_ONLY!=='1'){
    for(const role of ['player','admin','staff'])await scenario(`M02 ${role}: offline failure survives reload/back and retries before fresh login`,async({context,page})=>{
      const f=await fixture(context,role);f.mode='offline';await privatePage(page,role);await navigate(page,role,'profile');await page.locator('#main [data-act="logout"]').click();await pending(page);await retryReady(page);
      assert.equal(f.active,true);assert.equal(await page.locator('[data-logout-confirmed]').count(),0);const sessions=f.sessionCalls;
      await page.reload();await pending(page);assert.equal(f.sessionCalls,sessions);await page.goBack();await pending(page);assert.equal(f.active,true);
      f.mode='success';await page.locator('[data-logout-retry]').click();await confirmed(page);assert.equal(f.active,false);assert.equal((await context.cookies()).some(c=>c.name==='ls_session'),false);
      await page.locator('input[name="email"]').fill(f.user.email);await page.locator('input[name="password"]').fill('Synthetic-password-for-test');await page.locator('form [type="submit"]').click();
      for(let n=0;n<200&&!f.loginCalls;n++)await page.waitForTimeout(10);assert.equal(f.loginCalls,1,'A fresh login request must be issued');
      assert.equal(await page.evaluate(async()=>(await import('/js/core/logout.js')).getLogout().read()),null,'Acknowledged fresh login must retire the previous privacy marker');
      await page.waitForFunction(async module=>(await import(module)).state.user?.id,shell(role));
      await navigate(page,role,'profile');await page.locator('#main [data-act="logout"]').waitFor();assert.equal((await state(page,role)).id,f.user.id);assert.equal((await context.cookies()).find(c=>c.name==='ls_session')?.value,'new-synthetic');
    });
    for(const role of ['player','admin','staff'])for(const mode of ['500','lost','malformed'])await scenario(`M02 ${role}: ${mode} response stays unconfirmed until acknowledged retry`,async({context,page})=>{
      const f=await fixture(context,role);f.mode=mode;await privatePage(page,role);await page.locator('#main [data-act="logout"]').click();await pending(page);await retryReady(page);
      assert.equal(f.active,mode!=='lost');assert.equal(await state(page,role),null);assert.equal(await page.locator('[data-logout-confirmed]').count(),0);
      f.mode='success';await page.locator('[data-logout-retry]').click();await confirmed(page);assert.equal(f.logoutCalls,2);await page.reload();await confirmed(page);assert.equal(await state(page,role),null);
    });
    for(const role of ['player','admin','staff'])await scenario(`M02 ${role}: actual offline/reconnect automatically retries revocation`,async({context,page})=>{
      const f=await fixture(context,role);f.mode='offline';await privatePage(page,role);await context.setOffline(true);
      await page.locator('#main [data-act="logout"]').click();await pending(page);await retryReady(page);assert.equal(await page.evaluate(()=>navigator.onLine),false);
      f.mode='success';await context.setOffline(false);await confirmed(page);assert.equal(f.active,false);assert.equal(await state(page,role),null);
    });
    for(const role of ['player','admin','staff'])await scenario(`M02 ${role}: actual request timeout leaves a retryable privacy barrier`,async({context,page})=>{
      await fixture(context,role);await privatePage(page,role);await page.locator('#main [data-act="logout"]').click();await pending(page);await retryReady(page);
      assert.equal(await page.evaluate(async()=>(await import('/js/core/logout.js')).getLogout().read().error),'timeout');assert.equal(await state(page,role),null);assert.equal(await page.locator('[data-logout-confirmed]').count(),0);
    });
    for(const role of ['player','admin','staff'])await scenario(`M02 ${role}: cross-tab hiding and concurrent retries revoke once`,async({context,page})=>{
      const f=await fixture(context,role);f.mode='500';await privatePage(page,role);const second=await context.newPage();await privatePage(second,role);
      const other=await context.newPage();await other.goto(base+(role==='player'?'/admin/profile':'/profile'));await other.locator('#main').waitFor();
      await page.locator('#main [data-act="logout"]').click();await pending(page);await pending(second);await pending(other);await retryReady(page);assert.equal(await state(second,role),null);
      f.mode='hold';await Promise.all([page.locator('[data-logout-retry]').click(),second.locator('[data-logout-retry]').click()]);
      for(let n=0;n<100&&!f.pending.length;n++)await page.waitForTimeout(10);assert.equal(f.logoutCalls,2);assert.equal(f.pending.length,1);
      f.active=false;await f.pending[0].fulfill({json:{ok:true},headers:{'set-cookie':'ls_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'}});
      await confirmed(page);await confirmed(second);await confirmed(other);assert.equal(f.logoutCalls,2);
    });
    await scenario('M02 denied shared storage: tab persistence and BroadcastChannel still hide both tabs',async({context,page})=>{
      await context.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new Error('Synthetic denied shared storage');}}));
      const f=await fixture(context,'player');f.mode='offline';await privatePage(page,'player');const other=await context.newPage();await privatePage(other,'player');
      await page.locator('#main [data-act="logout"]').click();await pending(page);await pending(other);await other.reload();await pending(other);assert.equal(await state(other,'player'),null);
    });
    await scenario('M02 denied all storage: retain the current-page barrier and explain reload limitation',async({context,page})=>{
      await context.addInitScript(()=>{for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{get(){throw new Error('Synthetic denied storage');}});});
      const f=await fixture(context,'player');f.mode='offline';await privatePage(page,'player');await page.locator('#main [data-act="logout"]').click();await pending(page);await retryReady(page);
      assert.ok((await page.locator('[data-logout-status]').innerText()).includes('Keep this page open'));assert.equal(await state(page,'player'),null);
    });
  }
}finally{await browser.close();}
console.log(`${passed} logout browser scenarios passed, ${failed} failed`);process.exitCode=failed?1:0;
