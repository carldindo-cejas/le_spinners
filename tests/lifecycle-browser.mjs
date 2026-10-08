// Actual player/admin/staff modules, synthetic APIs, delayed responses and repeated navigation.
import assert from 'node:assert/strict';
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL||'http://127.0.0.1:8799';
assert.match(base,/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined});
let failed=0,passed=0;
const now=Date.now(),date=new Date(now).toISOString().slice(0,10);
const facility={now,today:date,tzOffsetMinutes:480,facility:{name:'Synthetic hub',address:''},rules:{slotMinutes:60,holdMinutes:10,resubmitMinutes:15,bookingWindowDays:14},activities:[]};
const player={id:'synthetic-player',role:'player',name:'Synthetic player',email:'player@example.invalid',membership:'none'};
const booking={id:'fixture',ref:'SYNTHETIC-BOOKING',status:'TEMPORARY',activity:'pickleball',activityLabel:'Pickleball',resource:{id:'court',name:'Synthetic court'},user:player,date,startMin:600,endMin:660,startsAt:now,endsAt:now+3600000,amountDue:50000,amountLabel:'500',durationLabel:'1 hour',holdExpiresAt:now+600000,createdAt:now,canSubmitProof:true};
async function scenario(name,run){const page=await browser.newPage({serviceWorkers:'block'});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error'&&!msg.text().startsWith('Failed to load resource:'))errors.push(msg.text());});try{await run(page,errors);passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}finally{await page.close();}}
async function mocks(page,user,{intercept}={}){
  // Synthetic flow checks must not depend on remote fonts or contact external hosts.
  await page.route('**/*',route=>new URL(route.request().url()).origin===base ? route.fallback() : route.fulfill({contentType:'text/css',body:''}));
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(intercept&&await intercept(path,route))return;
    if(path==='/api/auth/session')return route.fulfill({json:{user}});
    if(path==='/api/facility')return route.fulfill({json:facility});
    if(path==='/api/bookings')return route.fulfill({json:{bookings:[],credits:{availableLabel:'0'},now}});
    if(path.endsWith('/badges'))return route.fulfill({json:{notifications:0,chats:0,holds:[],pendingVerification:0,unresolved:0}});
    return route.fulfill({json:{}});
  });
}
const shell=role=>role==='player'?'/js/player/shell.js':'/js/admin/shell.js';
async function navigate(page,role,path){await page.evaluate(async({module,path})=>{const {state}=await import(module);await state.router.navigate(path);},{module:shell(role),path});}
try {
  await scenario('M03 regression: delayed private booking cannot replace expired-session login',async(page,errors)=>{
    let slow;
    await mocks(page,player,{intercept:async(path,route)=>{
      if(path==='/api/bookings/slow'){slow=route;return true;}
      if(path==='/api/credits'){await route.fulfill({status:401,json:{error:{code:'UNAUTHORIZED',message:'Expired fixture'}}});return true;}
    }});
    await page.goto(base+'/bookings/slow');await page.waitForFunction(()=>document.querySelector('#main'));
    for(let n=0;n<100&&!slow;n++)await new Promise(r=>setTimeout(r,20));assert.ok(slow);
    await navigate(page,'player','/credits');await page.locator('h1').filter({hasText:'Welcome back'}).waitFor({timeout:2000}).catch(()=>{});
    // Baseline leaves the old private view mounted behind the expired-session dialog.
    await page.locator('[data-session-signin]').first().click();await page.locator('h1').filter({hasText:'Welcome back'}).waitFor();
    await slow.fulfill({json:{now,booking:{id:'slow',ref:'PRIVATE-OLD-BOOKING',status:'PAYMENT_SUBMITTED',activity:'pickleball',activityLabel:'Pickleball',resource:{name:'Private old court'},date,startMin:600,endMin:660,startsAt:now,endsAt:now+3600000,amountDue:50000,amountLabel:'500',canSubmitProof:false},timeline:[],proofs:[]}}).catch(()=>{});
    await page.waitForTimeout(100);assert.equal((await page.locator('#main').innerText()).includes('PRIVATE-OLD-BOOKING'),false,'Late response must not restore the private booking');assert.equal(await page.locator('h1').innerText(),'Welcome back');assert.deepEqual(errors,[]);
  });
  for(const role of ['player','admin','staff'])await scenario(`M04 regression: twenty ${role} profile visits produce one password dialog`,async(page,errors)=>{
    const user={...player,role};await mocks(page,user);const profile=role==='player'?'/profile':`/${role}/profile`,other=role==='player'?'/welcome':`/${role}/more`;
    await page.goto(base+profile);await page.locator('[data-act="password"]').waitFor();
    for(let n=0;n<20;n++){await navigate(page,role,other);await navigate(page,role,profile);}
    await page.locator('[data-act="password"]').click();assert.equal(await page.locator('.scrim').count(),1);assert.deepEqual(errors,[]);
    await navigate(page,role,other);assert.equal(await page.locator('.scrim').count(),0);assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
  });
  // These checks use the new lifecycle contract; the four regression probes above
  // are also runnable against the preserved pre-fix browser source.
  if(process.env.BASELINE_ONLY!=='1') {
    for(const role of ['player','admin','staff'])await scenario(`M03 ${role}: confirmed sign-in and logout create fresh routes after identity disposal`,async(page,errors)=>{
      let logins=0,logouts=0;
      const user={...player,role},login=role==='player'?'/login':`/${role}/login`,profile=role==='player'?'/profile':`/${role}/profile`;
      await mocks(page,null,{intercept:async(path,route)=>{
        if(path==='/api/auth/salt'){await route.fulfill({json:{scheme:'client_pbkdf2_hmac_v1',salt:'AAAAAAAAAAAAAAAAAAAAAA',iterations:600000}});return true;}
        if(path.startsWith('/api/auth/')&&path.endsWith('/login')){logins++;await route.fulfill({json:{user}});return true;}
        if(path==='/api/auth/logout'){logouts++;await route.fulfill({json:{ok:true}});return true;}
      }});
      await page.goto(base+login+'?next='+encodeURIComponent(profile));await page.locator('input[name="email"]').fill(user.email);
      await page.locator('input[name="password"]').fill('Synthetic-password-for-test');await page.locator('form [type="submit"]').click();
      await page.locator('[data-act="password"]').waitFor();assert.equal(new URL(page.url()).pathname,profile);assert.equal(logins,1);
      await page.locator('#main [data-act="logout"]').click();await page.waitForURL(url=>url.pathname===login);
      await page.locator('[data-logout-confirmed]').waitFor();
      assert.equal(logouts,1);assert.equal(await page.evaluate(async module=>(await import(module)).state.user,shell(role)),null);assert.equal(await page.locator('[data-act="password"]').count(),0);assert.deepEqual(errors,[]);
    });
    await scenario('M03 rapid back/forward cannot revive either delayed booking response',async(page,errors)=>{
      const pending=[];
      await mocks(page,player,{intercept:async(path,route)=>{if(path==='/api/bookings/slow'){pending.push(route);return true;}}});
      await page.goto(base+'/bookings/slow');for(let n=0;n<100&&!pending.length;n++)await page.waitForTimeout(10);assert.equal(pending.length,1);
      await navigate(page,'player','/profile');await page.goBack();
      for(let n=0;n<100&&pending.length<2;n++)await page.waitForTimeout(10);assert.equal(pending.length,2);
      await page.goForward();await page.locator('[data-act="password"]').waitFor();
      for(const response of pending.reverse())await response.fulfill({json:{now,booking:{...booking,id:'slow',ref:'PRIVATE-REVERSED',status:'PAYMENT_SUBMITTED'},timeline:[],proofs:[]}}).catch(()=>{});
      await page.waitForTimeout(50);assert.equal(new URL(page.url()).pathname,'/profile');assert.equal((await page.locator('#main').innerText()).includes('PRIVATE-REVERSED'),false);assert.deepEqual(errors,[]);
    });
    await scenario('M04 route exceptions dispose early dialogs, listeners and polling',async(page,errors)=>{
      await mocks(page,player);await page.goto(base+'/profile');await page.locator('[data-act="password"]').waitFor();
      const result=await page.evaluate(async()=>{
        const {state}=await import('/js/player/shell.js'),{createRouter}=await import('/js/core/router.js'),{listen,html}=await import('/js/core/dom.js'),{openModal,poll}=await import('/js/core/ui.js');
        state.router.dispose();let signal,calls=0,stopped=0,reports=0;const target=new EventTarget(),old=console.error;
        console.error=()=>reports++;
        const router=createRouter({routes:[{path:'/profile',view(ctx){signal=ctx.signal;listen(target,'action',()=>calls++);openModal({content:()=>html`<button data-close>Close</button>`});const stop=poll(()=>calls++,10000);ctx.own(()=>{stop();stopped++;});throw new Error('Synthetic view error');}}],notFound(){}});
        try {await router.resolve();target.dispatchEvent(new Event('action'));return {aborted:signal.aborted,calls,stopped,reports,dialogs:document.querySelectorAll('.scrim').length,overflow:document.body.style.overflow};}
        finally {router.dispose();console.error=old;}
      });
      assert.deepEqual(result,{aborted:true,calls:0,stopped:1,reports:1,dialogs:0,overflow:''});assert.deepEqual(errors,[]);
    });
    for(const role of ['player','admin','staff'])await scenario(`M03 ${role}: old-session 401 cannot expire a new identity`,async(page,errors)=>{
      await mocks(page,{...player,role}); const profile=role==='player'?'/profile':`/${role}/profile`;
      await page.goto(base+profile); await page.locator('[data-act="password"]').waitFor();
      const result=await page.evaluate(async({module,role,profile})=>{
        const {state}=await import(module),{api}=await import('/js/core/api.js');
        const fetchOriginal=window.fetch;let resolve;
        window.fetch=()=>new Promise(r=>{resolve=r;});
        const old=api.get('/api/synthetic-stale',{scope:null}).catch(e=>e.name);
        state.user={...state.user,id:'new-identity',name:'New synthetic identity',role};
        resolve(Response.json({error:{code:'UNAUTHORIZED'}},{status:401}));
        const name=await old; window.fetch=fetchOriginal; await state.router.navigate(profile);
        return {name,id:state.user?.id};
      },{module:shell(role),role,profile});
      assert.deepEqual(result,{name:'AbortError',id:'new-identity'}); assert.equal(await page.locator('.scrim').count(),0);
      assert.ok((await page.locator('#main').innerText()).includes('New synthetic identity')); assert.deepEqual(errors,[]);
    });
    for(const role of ['player','admin','staff'])await scenario(`M03/M04 ${role}: manual profile-dialog close cancels its pending save`,async(page,errors)=>{
      let pending,requests=0;
      await mocks(page,{...player,role},{intercept:async(path,route)=>{
        if(path==='/api/me'){requests++;pending=route;return true;}
      }});
      const profile=role==='player'?'/profile':`/${role}/profile`;
      await page.goto(base+profile);await page.locator('[data-act="edit"]').click();
      await page.locator('#p-name').fill('Canceled synthetic change'); await page.locator('.scrim [type="submit"]').click();
      await page.waitForFunction(()=>document.querySelector('.scrim [type="submit"]').disabled);
      for(let n=0;n<100&&!pending;n++)await page.waitForTimeout(10); assert.ok(pending);assert.equal(requests,1);
      await page.locator('.scrim [data-close]').click();
      await pending.fulfill({json:{user:{...player,role,name:'Canceled synthetic change'}}}).catch(()=>{});
      await page.waitForTimeout(50);
      const name=await page.evaluate(async module=>(await import(module)).state.user.name,shell(role));
      assert.equal(name,player.name);assert.equal(await page.locator('.scrim').count(),0);assert.equal(await page.evaluate(()=>document.body.style.overflow),'');assert.deepEqual(errors,[]);
    });
    await scenario('M03/M04 twenty held/payment visits: one release request, no stale action after leaving',async(page,errors)=>{
      let releases=0,pending;
      await mocks(page,player,{intercept:async(path,route)=>{
        if(path==='/api/bookings/fixture/release'){releases++;pending=route;return true;}
        if(path==='/api/bookings/fixture'){await route.fulfill({json:{now,booking,timeline:[],proofs:[],payment:{gcashNumber:'00000000000',gcashName:'Synthetic account'}}});return true;}
      }});
      await page.goto(base+'/bookings/fixture/held');await page.locator('[data-act="release"]').waitFor();
      for(let n=0;n<20;n++){await navigate(page,'player','/bookings/fixture/pay');await page.locator('#upload').waitFor();await navigate(page,'player','/bookings/fixture/held');}
      await page.locator('[data-act="release"]').click();assert.equal(await page.locator('.scrim').count(),1);
      await page.locator('.scrim [data-act="confirm"]').click();
      for(let n=0;n<100&&!pending;n++)await page.waitForTimeout(10);assert.equal(releases,1);
      await navigate(page,'player','/profile');await pending.fulfill({json:{}}).catch(()=>{});await page.waitForTimeout(50);
      assert.equal(new URL(page.url()).pathname,'/profile');assert.equal(await page.locator('.scrim').count(),0);assert.deepEqual(errors,[]);
    });
    for(const role of ['admin','staff'])await scenario(`M04 ${role}: repeated proof viewers release listeners and preserve other dialog scroll locks`,async(page,errors)=>{
      await mocks(page,{...player,role});await page.goto(base+`/${role}/profile`);await page.locator('[data-act="password"]').waitFor();
      await page.evaluate(async booking=>{
        const {openViewer}=await import('/js/admin/screens/verify.js'),{openModal}=await import('/js/core/ui.js'),{html}=await import('/js/core/dom.js');
        for(let n=0;n<20;n++) {const close=openViewer({url:'/icons/icon.svg',booking,canDecide:false});close();close();}
        const close=openViewer({url:'/icons/icon.svg',booking,canDecide:false});
        const dialog=openModal({content:()=>html`<button data-close>Close synthetic dialog</button>`});close();
        if(document.body.style.overflow!=='hidden')throw new Error('Closing viewer released another dialog scroll lock');
        dialog.close();
        openViewer({url:'/icons/icon.svg',booking,canDecide:false});
      },{...booking,status:'CONFIRMED'});
      assert.equal(await page.locator('.viewer').count(),1);await navigate(page,role,`/${role}/more`);
      assert.equal(await page.locator('.viewer').count(),0);assert.equal(await page.evaluate(()=>document.body.style.overflow),'');assert.deepEqual(errors,[]);
    });
    await scenario('M03 CSV export cannot download or expire a session after navigation',async(page,errors)=>{
      let pending,downloads=0;page.on('download',()=>downloads++);
      await mocks(page,{...player,role:'admin'},{intercept:async(path,route)=>{
        if(path==='/api/admin/revenue/export'){pending=route;return true;}
        if(path==='/api/admin/revenue/summary'){await route.fulfill({json:{today:date,resources:[],periods:[],pendingVerification:{count:0,amount:0}}});return true;}
        if(path==='/api/admin/revenue/ledger'){await route.fulfill({status:503,json:{error:{message:'Synthetic ledger unavailable'}}});return true;}
      }});
      await page.goto(base+'/revenue/');await page.locator('[data-act="export"]').click();
      await page.getByRole('dialog', { name: 'Export booking ledger' }).locator('[data-confirm-export]').click();
      for(let n=0;n<100&&!pending;n++)await page.waitForTimeout(10);assert.ok(pending);
      await navigate(page,'admin','/admin/profile');await pending.fulfill({status:401,json:{error:{code:'UNAUTHORIZED'}}}).catch(()=>{});await page.waitForTimeout(50);
      assert.equal(downloads,0);assert.equal(new URL(page.url()).pathname,'/admin/profile');assert.equal(await page.locator('.scrim').count(),0);assert.deepEqual(errors,[]);
    });
  }
} finally {await browser.close();}
console.log(`${passed} lifecycle scenarios passed, ${failed} failed`);process.exitCode=failed?1:0;
