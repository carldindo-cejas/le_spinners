import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL||'http://127.0.0.1:8805';assert.match(base,/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined});let pass=0,fail=0;
const now=Date.now(),startsAt=now-2*3600000;
const booking={id:'test_booking',ref:'MULTI-HOUR-ONGOING',status:'CONFIRMED',activity:'pickleball',activityLabel:'Pickleball',resource:{id:'court-1',name:'Synthetic court'},date:'2026-10-07',dateLabel:'Oct 7',start:600,end:780,segments:[{start:600,end:780}],startsAt,endsAt:now+3600000,createdAt:now,durationMin:180,amountDue:50000,amountLabel:'PHP 500',rate:'member',user:{id:'synthetic-player',name:'Synthetic player',email:'player@example.invalid'},canSubmitProof:false};
const facility={now,today:'2026-10-07',tzOffsetMinutes:480,facility:{name:'Synthetic hub',address:''},rules:{slotMinutes:60,bookingWindowDays:14},hours:[],activities:[]};
const credit={id:'credit-latest',state:'available',stateLabel:'Available',origin:'manual',reason:'LATEST-RECORD',spendable:true,remaining:100,amount:100,remainingLabel:'PHP 1',amountLabel:'PHP 1',issuedAt:now,user:{name:'Synthetic player'}};
const notice={id:'notice-latest',type:'new_message',title:'LATEST-RECORD',body:'Synthetic',link:'/bookings/test_booking',createdAt:now,read:false,resolved:false};
async function scenario(name,role,path,run){const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource:'))errors.push(m.text());});
await context.route('**/*',async route=>{if(new URL(route.request().url()).origin!==base)return route.fulfill({contentType:'text/css',body:''});return route.fallback();});
await context.route('**/api/**',async route=>{const url=new URL(route.request().url()),p=url.pathname,old=url.searchParams.has('cursor'),pagination={limit:1,hasMore:!old,nextCursor:old?null:'synthetic-older'},word=old?'OLDER-RECORD':'LATEST-RECORD';
if(p==='/api/auth/session')return route.fulfill({json:{user:{id:'synthetic-'+role,role,name:'Synthetic '+role,email:role+'@example.invalid',membership:'none'}}});
if(p==='/api/facility')return route.fulfill({json:facility});
if(p.endsWith('/badges'))return route.fulfill({json:{notifications:0,chats:0,holds:[],unresolved:0,pendingVerification:0}});
if(p==='/api/bookings')return route.fulfill({json:{now,bookings:url.searchParams.get('group')==='past'?[]:[{...booking,ref:word,resource:{...booking.resource,name:word}}],credits:{available:0,availableLabel:'0'},page:pagination}});
if(/^\/api\/(staff|admin)\/bookings$/.test(p))return route.fulfill({json:{now,today:'2026-10-07',counts:{},bookings:[{...booking,ref:word}],page:pagination}});
if(p.endsWith('/notifications'))return route.fulfill({json:{now,unread:1,unresolved:0,notifications:[{...notice,title:word}],page:pagination}});
if(p.endsWith('/credits'))return route.fulfill({json:{now,summary:{available:0,availableLabel:'0'},credits:[{...credit,reason:word}],page:pagination}});
if(p.endsWith('/messages')&&p.includes('/bookings/'))return route.fulfill({json:{now,booking,messages:[{id:word,kind:'text',body:word,sender:'player',senderName:'Synthetic player',createdAt:now}],page:pagination}});
if(p.endsWith('/messages'))return route.fulfill({json:{now,conversations:[{bookingId:'test_booking',ref:word,status:'CONFIRMED',resourceName:'Court',activity:'pickleball',userName:word,dateLabel:'Oct 7',timeLabel:'10 AM',last:{body:word,at:now,sender:'player'},unread:0}],page:pagination}});
if(p.endsWith('/bookings/test_booking'))return route.fulfill({json:{now,booking,actions:{},proofs:[],timeline:[],credit:null}});
return route.fulfill({json:{}});});
try{await page.goto(base+path);await run(page);assert.deepEqual(errors,[]);pass++;console.log('PASS '+name);}catch(e){fail++;console.log('FAIL '+name+': '+e.stack+'\n'+errors.join('\n')+'\n'+await page.locator('#main').innerText());}finally{await context.close();}}
try{
 await scenario('M12 baseline probe: list retains an active multi-hour booking','player','/bookings',async page=>{await page.locator('[data-list]').waitFor();await page.waitForFunction(()=>document.querySelector('[data-list]').textContent.includes('LATEST-RECORD'));});
 await scenario('M12 baseline probe: home retains an active multi-hour booking','player','/',async page=>{await page.waitForFunction(()=>document.querySelector('[data-upcoming]')?.textContent.includes('LATEST-RECORD'));});
 if(process.env.BASELINE_ONLY!=='1'){
  for(const role of ['player','admin','staff'])for(const name of ['bookings','credits','notifications'])await scenario(`L02 ${role} ${name}: older/newer replace a bounded page`,role,role==='player'?'/'+name:`/${role}/${name}`,async page=>{
   const nav=page.getByRole('navigation',{name:'History',exact:true});await nav.getByRole('button',{name:'Older',exact:true}).waitFor();await nav.getByRole('button',{name:'Older',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#main').textContent.includes('OLDER-RECORD'));
   assert.equal((await page.locator('#main').innerText()).includes('LATEST-RECORD'),false);
   await nav.getByRole('button',{name:'Newer',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#main').textContent.includes('LATEST-RECORD'));
   assert.equal((await page.locator('#main').innerText()).includes('OLDER-RECORD'),false);
  });
  await scenario('L02 player chat retrieves earlier messages','player','/bookings/test_booking/chat',async page=>{const nav=page.getByRole('navigation',{name:'Earlier messages',exact:true});await nav.getByRole('button',{name:'Older',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-log]').textContent.includes('OLDER-RECORD'));});
  for(const role of ['staff','admin'])await scenario(`L02 ${role} inbox retrieves older conversations`,role,`/${role}/messages`,async page=>{const nav=page.getByRole('navigation',{name:'Conversations',exact:true});await nav.getByRole('button',{name:'Older',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-convs]').textContent.includes('OLDER-RECORD'));});
  for(const role of ['staff','admin'])await scenario(`L02 regression: ${role} active conversation retrieves earlier messages`,role,`/${role}/messages/test_booking`,async page=>{
   const nav=page.getByRole('navigation',{name:'Earlier messages',exact:true});
   await nav.getByRole('button',{name:'Older',exact:true}).waitFor({timeout:3000});
   await page.waitForFunction(()=>document.querySelector('[data-log]')?.textContent.includes('LATEST-RECORD'));
   await nav.getByRole('button',{name:'Older',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('[data-log]')?.textContent.includes('OLDER-RECORD'));
   await nav.getByRole('button',{name:'Newer',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('[data-log]')?.textContent.includes('LATEST-RECORD'));
   await page.locator('#reply').fill('Synthetic reply');await page.locator('form .send-btn').click();
   await page.waitForFunction(()=>document.querySelector('#reply').value===''&&!document.querySelector('.send-btn').disabled);
  });
  for(const role of ['player','staff','admin'])await scenario(`L02 ${role} notification filter restarts full-history traversal`,role,role==='player'?'/notifications':`/${role}/notifications`,async page=>{
   const nav=page.getByRole('navigation',{name:'History',exact:true});await nav.getByRole('button',{name:'Older',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#main').textContent.includes('OLDER-RECORD'));
   const request=page.waitForRequest(r=>{const u=new URL(r.url());return u.pathname.endsWith('/notifications')&&u.searchParams.get('filter')==='messages'&&!u.searchParams.has('cursor');});
   await page.locator('[data-filter="messages"]').click();await request;
   await page.waitForFunction(()=>document.querySelector('#main').textContent.includes('LATEST-RECORD'));
   assert.equal(await nav.locator('[role="status"]').innerText(),'Page 1');
   if(role!=='player'){const text=await page.locator('#main').innerText();assert.ok(text.includes('SMS delivery is unsupported.'));assert.equal(text.includes('will send once'),false);}
  });
  for(const role of ['staff','admin'])await scenario(`L02 ${role} inbox filter and literal search restart traversal`,role,`/${role}/messages`,async page=>{
   const nav=page.getByRole('navigation',{name:'Conversations',exact:true});await nav.getByRole('button',{name:'Older',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('[data-convs]').textContent.includes('OLDER-RECORD'));
   const filtered=page.waitForRequest(r=>{const u=new URL(r.url());return u.pathname.endsWith('/messages')&&u.searchParams.get('filter')==='unread'&&!u.searchParams.has('cursor');});
   await page.locator('[data-filter="unread"]').click();await filtered;
   await page.waitForFunction(()=>document.querySelector('[data-convs]').textContent.includes('LATEST-RECORD'));
   assert.equal(await nav.locator('[role="status"]').innerText(),'Page 1');
   await nav.getByRole('button',{name:'Older',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-convs]').textContent.includes('OLDER-RECORD'));
   const searched=page.waitForRequest(r=>{const u=new URL(r.url());return u.pathname.endsWith('/messages')&&u.searchParams.get('q')==='OLDER_LITERAL_%_'&&!u.searchParams.has('cursor');});
   await page.locator('[data-search]').fill('OLDER_LITERAL_%_');await searched;
   await page.waitForFunction(()=>document.querySelector('[data-convs]').textContent.includes('LATEST-RECORD'));
   assert.equal(await nav.locator('[role="status"]').innerText(),'Page 1');
  });
  await scenario('L02 pager filter change cannot restore another filter cursor after failed reload','player','/profile',async page=>{
   await page.locator('[data-act="password"]').waitFor();
   const result=await page.evaluate(async()=>{
    const {historyPager}=await import('/js/core/history.js');const parent=document.createElement('div');document.body.append(parent);
    let calls=0,releaseOlder,latestPath,firstNew=true;
    const fakeApi={async get(path){latestPath=path;const parsed=new URL(path,location.origin);
     if(parsed.searchParams.get('filter')==='new'){if(firstNew){firstNew=false;throw new Error('Synthetic failed filter reload');}return {page:{hasMore:false,nextCursor:null}};}
     calls++;if(calls===3)return new Promise(resolve=>{releaseOlder=()=>resolve({page:{hasMore:false,nextCursor:null}});});
     return {page:{hasMore:true,nextCursor:'old-cursor-'+calls}};
    }};
    let pager;pager=historyPager(fakeApi,parent,()=>pager.get('/api/pager?filter=old'),{label:'Race history'});
    const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('Synthetic pager did not reach expected request');};
    try{
     await pager.get('/api/pager?filter=old');const older=parent.querySelector('button:last-child');older.click();await wait(()=>calls===2&&!older.disabled);
     older.click();await wait(()=>Boolean(releaseOlder));pager.reset();await pager.get('/api/pager?filter=new').catch(()=>{});
     const pageAfterFailure=parent.querySelector('[role="status"]').textContent;
     await pager.get('/api/pager?filter=new');const requestedCursor=new URL(latestPath,location.origin).searchParams.get('cursor');
     releaseOlder();await new Promise(r=>setTimeout(r,20));return {pageAfterFailure,requestedCursor};
    }finally{parent.remove();}
   });
   assert.deepEqual(result,{pageAfterFailure:'Page 1',requestedCursor:null});
  });
 }
}finally{await browser.close();}
console.log(`${pass} remaining browser scenarios passed, ${fail} failed`);if(fail)process.exitCode=1;
