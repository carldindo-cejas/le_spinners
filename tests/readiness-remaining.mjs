import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, NOW, seedBooking } from './helpers/readiness.mjs';
import { bookingEndsAt, bookingGroup, splitBookings } from '../public/js/core/booking-time.js';

for (const [name,start,end,segments] of [['short',600,630],['hour',600,660],['multi',600,780],['gapped',600,900,[{start:600,end:630},{start:840,end:900}]],['midnight',1380,1440]]) {
  test(`M12 ${name}: final-end grouping has exact boundaries and no client clock dependency`,()=>{
    const startsAt=Date.parse('2026-10-07T00:00:00Z')+start*60000,endsAt=startsAt+(end-start)*60000;
    const b={id:name,status:'CONFIRMED',start,end,segments,startsAt,endsAt};
    assert.equal(bookingGroup(b,startsAt-1),'upcoming');assert.equal(bookingGroup(b,startsAt),'upcoming');
    assert.equal(bookingGroup(b,endsAt-1),'upcoming');assert.equal(bookingGroup(b,endsAt),'past');
    assert.equal(bookingEndsAt({...b,endsAt:undefined}),endsAt);assert.equal(splitBookings([b],endsAt-1).upcoming[0],b);
  });
}
test('M12 unresolved payments remain actionable independently of play dates',()=>{
  for(const status of ['TEMPORARY','REJECTED','PAYMENT_SUBMITTED'])assert.equal(bookingGroup({status,canSubmitProof:true,endsAt:NOW-1},NOW),'upcoming');
  for(const status of ['TEMPORARY','REJECTED','EXPIRED','COMPLETED'])assert.equal(bookingGroup({status,canSubmitProof:false,endsAt:NOW+1},NOW),'past');
  assert.equal(bookingGroup({status:'CANCELLED',canSubmitProof:true},NOW),'cancelled');
});
test('M12 DTO exposes the same final end used by maintenance',async t=>{
  const f=fixture(t);seedBooking(f.DB,'CONFIRMED');f.DB.sqlite.exec("UPDATE bookings SET end_min=900 WHERE id='test_booking'");
  const b=await app.getBooking(f.DB,'test_booking'),settings=await app.loadSettings(f.DB),dto=app.bookingDTO(b,NOW,settings,480);
  assert.equal(dto.endsAt,app.localToMs(b.date,900,480));
});

async function apiFixture(t) {
  const f=fixture(t);f.env.PASSWORD_PEPPER='remaining-synthetic-pepper-for-isolated-tests-only';
  const hash=await app.pepperHash(f.env.PASSWORD_PEPPER,'A'.repeat(43));
  const insert=f.DB.sqlite.prepare("INSERT INTO users(id,email,name,password_hash,password_salt,password_scheme,password_iterations,role,membership,created_at,updated_at) VALUES(?,?,?,?,'S'.repeat(22),?,?,?,'none',?,?)".replace("'S'.repeat(22)","'SSSSSSSSSSSSSSSSSSSSSS'"));
  for(let i=0;i<60;i++)insert.run('nat-'+i,'nat-'+i+'@example.invalid','Synthetic NAT '+i,hash,app.PASSWORD_SCHEME,app.PASSWORD_ITERATIONS,'player',NOW,NOW);
  const api=new Hono(),pending=[];const error=(e,c)=>c.json({code:e.code??'INTERNAL',message:e.message},e.status??500);
  api.onError(error);for(const router of [app.authRoutes,app.bookingRoutes,app.creditRoutes,app.notificationRoutes,app.operationsRoutes,app.revenueRoutes])router.onError(error);
  api.use('*',app.loadSession);api.route('/auth',app.authRoutes);api.route('/bookings',app.bookingRoutes);api.route('/credits',app.creditRoutes);api.route('/notifications',app.notificationRoutes);
  api.route('/staff',app.operationsRoutes);api.route('/revenue',app.revenueRoutes);
  const request=(url,body,options={})=>api.fetch(new Request('http://localhost'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','CF-Connecting-IP':options.ip??'192.0.2.50',...(options.cookie?{Cookie:options.cookie}:{})},body:body?JSON.stringify(body):undefined}),f.env,{waitUntil(p){pending.push(p)},passThroughOnException(){}});
  t.after(async()=>Promise.all(pending));
  const login=(i,valid=true,ip)=>request('/auth/user/login',{email:'nat-'+i+'@example.invalid',clientHash:(valid?'A':'B').repeat(43)},{ip});
  const session=async id=>{const token='synthetic-history-session-'+id+'-'.repeat(40),key=await app.sha256Hex(token);f.DB.sqlite.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at,auth_version) SELECT ?,id,?,?,?,auth_version FROM users WHERE id=?').run(key,NOW,Date.now()+86400000,NOW,id);return 'ls_session='+token;};
  return {...f,request,login,session};
}
test('M13 baseline probe: 50 legitimate accounts share one IP without 429',async t=>{
  const f=await apiFixture(t);
  const salts=await Promise.all(Array.from({length:50},(_,i)=>f.request('/auth/salt',{email:'nat-'+i+'@example.invalid'})));
  assert.equal(salts.filter(r=>r.status===200).length,50);
  const results=await Promise.all(Array.from({length:50},(_,i)=>f.login(i)));assert.equal(results.filter(r=>r.status===200).length,50);
});
if(process.env.BASELINE_ONLY!=='1') {
  test('L02 review regression: notification filters query full history before pagination and scope cursors',async t=>{
    const f=await apiFixture(t),player=await f.session('test_player'),staff=await f.session('test_staff');
    const insert=f.DB.sqlite.prepare("INSERT INTO notifications(id,audience,user_id,type,title,body,created_at,resolved_at) VALUES(?,?,? ,?,'Synthetic','Synthetic',?,?)");
    for(let i=0;i<125;i++){
      insert.run('player-new-'+i,'user','test_player','booking_cancelled',NOW,null);
      insert.run('staff-resolved-'+i,'staff',null,'booking_cancelled',NOW,NOW);
    }
    for(let i=0;i<3;i++){
      insert.run('player-message-'+i,'user','test_player','new_message',NOW-1,null);
      insert.run('staff-proof-'+i,'staff',null,'proof_submitted',NOW-1,null);
      insert.run('staff-message-'+i,'staff',null,'new_message',NOW-1,null);
    }
    for(const [url,key,cookie] of [['/notifications?filter=messages','player-message-',player],['/staff/notifications?filter=verification','staff-proof-',staff],['/staff/notifications?filter=messages','staff-message-',staff]]){
      const response=await f.request(url+'&limit=2',null,{cookie});assert.equal(response.status,200);
      const first=await response.json();assert.equal(first.notifications.length,2);assert.ok(first.notifications.every(n=>n.id.startsWith(key)));assert.equal(first.page.hasMore,true);
      const second=await (await f.request(url+'&limit=2&cursor='+first.page.nextCursor,null,{cookie})).json();assert.equal(second.notifications.length,1);
      assert.equal((await f.request(url.replace(/filter=[^&]+/,'filter=all')+'&cursor='+first.page.nextCursor,null,{cookie})).status,400);
    }
    const unresolved=await (await f.request('/staff/notifications?filter=unresolved',null,{cookie:staff})).json();assert.equal(unresolved.notifications.length,6);
  });
  test('L02 review regression: inbox search/unread/verifying filters apply before the page cap',async t=>{
    const f=await apiFixture(t),staff=await f.session('test_staff');
    const booking=f.DB.sqlite.prepare("INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,created_at,updated_at) VALUES(?,?,'test_player','court-1','2026-10-08',?,?,?,0,'non_member',?,?)");
    const msg=f.DB.sqlite.prepare("INSERT INTO messages(id,booking_id,sender_id,sender_role,kind,body,created_at) VALUES(?,?,'test_player','player','text','Synthetic',?)");
    for(let i=0;i<125;i++){const id='inbox-latest-'+i;booking.run(id,id,600,660,'COMPLETED',NOW,NOW);msg.run('m-'+id,id,NOW);f.DB.sqlite.prepare("INSERT INTO message_reads(booking_id,reader,last_read_at) VALUES(?,'staff',?)").run(id,NOW);}
    for(let i=0;i<3;i++){const id='OLDER_LITERAL_%_'+i;booking.run(id,id,600+i*60,660+i*60,'PAYMENT_SUBMITTED',NOW-1,NOW-1);msg.run('m-'+id,id,NOW-1);}
    for(const filter of ['filter=unread','filter=verifying','q='+encodeURIComponent('OLDER_LITERAL_%_')]){
      const first=await (await f.request('/staff/messages?'+filter+'&limit=2',null,{cookie:staff})).json();assert.equal(first.conversations.length,2);assert.ok(first.conversations.every(c=>c.ref.startsWith('OLDER_LITERAL_%_')));
      const second=await (await f.request('/staff/messages?'+filter+'&limit=2&cursor='+first.page.nextCursor,null,{cookie:staff})).json();assert.equal(second.conversations.length,1);
      assert.equal((await f.request('/staff/messages?filter=all&cursor='+first.page.nextCursor,null,{cookie:staff})).status,400);
    }
    const literal=await (await f.request('/staff/messages?q='+encodeURIComponent('%_'),null,{cookie:staff})).json();assert.equal(literal.conversations.length,3);
  });
  test('I03 accounting separates cancelled verified cash, spent credit, liabilities and refunds; admins only',async t=>{
    const f=await apiFixture(t);seedBooking(f.DB,'CANCELLED');
    f.DB.sqlite.exec(`UPDATE bookings SET amount_due=50000,confirmed_at=${NOW},credit_applied=0 WHERE id='test_booking';
      INSERT INTO booking_credits(id,user_id,origin,source_booking_id,amount,remaining,state,reason,created_at,updated_at) VALUES('accounting-credit','test_player','manual','test_booking',50000,20000,'active','Synthetic cancellation',${NOW},${NOW});
      INSERT INTO credit_transactions(id,credit_id,user_id,kind,amount,actor_role,created_at) VALUES('accounting-issue','accounting-credit','test_player','issue',50000,'staff',${NOW}),('accounting-refund','accounting-credit','test_player','refund',-10000,'staff',${NOW}),('accounting-redeem','accounting-credit','test_player','redeem',-20000,'player',${NOW});
      INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,credit_applied,rate,confirmed_at,created_at,updated_at) VALUES('replacement','REPLACEMENT','test_player','court-1','2026-10-08',660,720,'CONFIRMED',0,20000,'non_member',${NOW},${NOW},${NOW});`);
    const player=await f.session('test_player'),staff=await f.session('test_staff'),admin=await f.session('test_admin');
    for(const cookie of [player,staff])assert.equal((await f.request('/revenue/accounting',null,{cookie})).status,403);
    const r=await f.request('/revenue/accounting',null,{cookie:admin});assert.equal(r.status,200);const d=await r.json();
    assert.deepEqual([d.verifiedCash,d.recordedRefunds,d.activeCreditBalances,d.unexpiredCreditBalances,d.creditFundedValue],[50000,10000,20000,20000,20000]);
    f.DB.sqlite.exec(`UPDATE booking_credits SET expires_at=${NOW} WHERE id='accounting-credit'`);const expired=await app.creditAccounting(f.DB,NOW);assert.equal(expired.activeCreditBalances,20000);assert.equal(expired.unexpiredCreditBalances,0);
  });
  test('L02 frozen conversation pages survive new activity; filtered/role cursors remain scoped',async t=>{
    const f=await apiFixture(t),staff=await f.session('test_staff'),admin=await f.session('test_admin');
    const insert=f.DB.sqlite.prepare("INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,created_at,updated_at) VALUES(?,?,'test_player','court-1','2026-10-08',600,660,'COMPLETED',0,'non_member',?,?)");
    const msg=f.DB.sqlite.prepare("INSERT INTO messages(id,booking_id,sender_id,sender_role,kind,body,created_at) VALUES(?,?,'test_player','player','text','Synthetic',?)");
    for(let i=0;i<125;i++){const id='inbox-'+String(i).padStart(3,'0');insert.run(id,id,NOW,NOW);msg.run('m-'+id,id,NOW);}
    const first=await (await f.request('/staff/messages?limit=25',null,{cookie:staff})).json();assert.equal(first.conversations.length,25);
    msg.run('new-activity','inbox-000',NOW+1);
    let cursor=first.page.nextCursor,ids=first.conversations.map(r=>r.bookingId);while(cursor){const r=await f.request('/staff/messages?limit=25&cursor='+cursor,null,{cookie:staff});assert.equal(r.status,200);const d=await r.json();ids.push(...d.conversations.map(r=>r.bookingId));cursor=d.page.nextCursor;}
    assert.equal(ids.length,125);assert.equal(new Set(ids).size,125);
    assert.equal((await f.request('/staff/messages?cursor='+first.page.nextCursor,null,{cookie:admin})).status,400);
    const player=await f.session('test_player');const initial=await (await f.request('/bookings?group=past&limit=1',null,{cookie:player})).json();
    assert.equal((await f.request('/bookings?group=upcoming&cursor='+initial.page.nextCursor,null,{cookie:player})).status,400);
  });
  test('M13 account failures persist through unrelated and same-account successes',async t=>{
    const f=await apiFixture(t);for(let n=0;n<8;n++)assert.equal((await f.login(0,false)).status,401);
    assert.equal((await f.login(1)).status,200);assert.equal((await f.login(0)).status,200);assert.equal((await f.login(0,false)).status,429);
    assert.equal(f.DB.one("SELECT count FROM rate_limits WHERE key='login:failed:email:nat-0@example.invalid'").count,9);
  });
  test('M13 mixed multi-account abuse is bounded and does not erase failures',async t=>{
    const f=await apiFixture(t);for(let n=0;n<61;n++)assert.equal((await f.login(n%60,false)).status,n<60?401:429);
    assert.equal((await f.login(59)).status,200);
    for(let n=62;n<120;n++)await f.login(n%60,false);
    assert.equal((await f.login(58)).status,429);assert.ok(f.DB.count('sessions')<=1);
  });
  test('M13 limiter recovers at exact windows, canonicalizes IPv6 and ignores untrusted proxies',async t=>{
    const f=await apiFixture(t);for(let n=0;n<9;n++)await f.login(0,false,'2001:db8::1');
    assert.equal((await f.login(0,false,'2001:0db8:0:0:0:0:0:1')).status,429);
    f.DB.sqlite.exec('UPDATE rate_limits SET window_start=window_start-900000');assert.equal((await f.login(0,false,'2001:db8::1')).status,401);
    assert.equal(app.clientIp({req:{header:name=>name==='X-Forwarded-For'?'1.2.3.4':undefined}}),'local');
  });
  test('L02 player booking and notification history traverses beyond prior caps without ties/ownership leaks',async t=>{
    const f=await apiFixture(t),cookie=await f.session('test_player'),other=await f.session('test_other');
    const booking=f.DB.sqlite.prepare("INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,created_at,updated_at) VALUES(?,?,?,'court-1','2026-10-08',600,660,'COMPLETED',0,'non_member',?,?)");
    const notice=f.DB.sqlite.prepare("INSERT INTO notifications(id,audience,user_id,type,title,body,created_at) VALUES(?,'user',?,'test','Synthetic','Synthetic',?)");
    for(let i=0;i<225;i++){const id=String(i).padStart(4,'0');booking.run('history-'+id,'H-'+id,'test_player',NOW,NOW);notice.run('notice-'+id,'test_player',NOW);}
    notice.run('private-other','test_other',NOW+1);
    for(const [url,key] of [['/bookings','bookings'],['/notifications','notifications']]) {
      const ids=[],pages=[];let cursor='';do {const r=await f.request(url+'?limit=31'+(cursor?'&cursor='+encodeURIComponent(cursor):''),null,{cookie});assert.equal(r.status,200);const data=await r.json();ids.push(...data[key].map(row=>row.id));pages.push(data.page);cursor=data.page.nextCursor??'';}while(cursor);
      assert.equal(ids.length,225);assert.equal(new Set(ids).size,225);assert.equal(pages.at(-1).hasMore,false);
      const crossed=await f.request(url+'?cursor='+pages[0].nextCursor,null,{cookie:other});assert.equal(crossed.status,400);
    }
  });
  test('L02 credit and chat pages traverse all tied records and reject changed scopes',async t=>{
    const f=await apiFixture(t),cookie=await f.session('test_player');seedBooking(f.DB,'COMPLETED');
    const credit=f.DB.sqlite.prepare("INSERT INTO booking_credits(id,user_id,origin,amount,remaining,state,reason,created_at,updated_at) VALUES(?,'test_player','manual',100,100,'active','Synthetic',?,?)");
    const message=f.DB.sqlite.prepare("INSERT INTO messages(id,booking_id,sender_id,sender_role,kind,body,created_at) VALUES(?,'test_booking','test_staff','staff','text','Synthetic',?)");
    for(let i=0;i<225;i++){credit.run('credit-'+String(i).padStart(4,'0'),NOW,NOW);message.run('message-'+String(i).padStart(4,'0'),NOW);}
    for(const [url,key] of [['/credits','credits'],['/bookings/test_booking/messages','messages']]) {
      let cursor='',ids=[];do {const r=await f.request(url+'?limit=37'+(cursor?'&cursor='+encodeURIComponent(cursor):''),null,{cookie});assert.equal(r.status,200,await r.clone().text());const d=await r.json();ids.push(...d[key].map(row=>row.id));cursor=d.page.nextCursor??'';}while(cursor);
      assert.equal(ids.length,225);assert.equal(new Set(ids).size,225);
    }
  });
  test('L02 invalid cursors/page sizes fail before history queries',()=>{
    for(const limit of ['0','101','-1','1.5','a'])assert.throws(()=>app.pageRequest({limit},'test',['number','string']));
    for(const cursor of ['%%%','a'.repeat(2049),btoa(JSON.stringify({v:1,scope:'other',values:[1,'x']}))])assert.throws(()=>app.pageRequest({cursor},'test',['number','string']));
    const first=app.pageRequest({limit:'1'},'owner',['number','string']),result=app.pageResult([{t:1,id:'b'},{t:1,id:'a'}],first,r=>[r.t,r.id]);
    assert.equal(app.pageRequest({cursor:result.page.nextCursor},'owner',['number','string']).values[1],'b');
    assert.throws(()=>app.pageRequest({cursor:result.page.nextCursor},'other',['number','string']));
  });
}
