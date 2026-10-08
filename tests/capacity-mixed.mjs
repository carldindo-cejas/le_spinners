// Disposable localhost mixed workload. Never targets a deployed Worker or real provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import net from 'node:net';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { deriveClientHash } from '../public/js/core/password.js';
import { capacityInvariantSql, assertCapacityInvariants } from './capacity-invariants.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const seconds=Number(process.env.CAPACITY_SECONDS||1800),port=Number(process.env.CAPACITY_PORT||8820),validateOnly=process.env.CAPACITY_VALIDATE_ONLY==='1';
assert.ok(Number.isFinite(seconds)&&seconds>=1&&seconds<=3600);
assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535);
const base=`http://127.0.0.1:${port}`;
const scratch=fs.mkdtempSync(path.join(root,'.wrangler','capacity-mixed-'));
const cli=path.join(root,'node_modules/wrangler/bin/wrangler.js');
for(const dir of ['src','public','migrations','scripts','tests','db'])fs.cpSync(path.join(root,dir),path.join(scratch,dir),{recursive:true});
for(const file of ['package.json','package-lock.json','tsconfig.json','worker-configuration.d.ts','.dev.vars.example'])fs.copyFileSync(path.join(root,file),path.join(scratch,file));
fs.symlinkSync(path.join(root,'node_modules'),path.join(scratch,'node_modules'),process.platform==='win32'?'junction':'dir');
const config=ts.parseConfigFileTextToJson('wrangler.jsonc',fs.readFileSync(path.join(root,'wrangler.jsonc'),'utf8')).config;
assert.ok(!config.d1_databases.some(v=>v.remote)&&!config.r2_buckets.some(v=>v.remote),'Remote bindings prohibited');
config.name='le-spinners-local-capacity';config.vars.APP_ORIGIN=base;
config.d1_databases[0].database_name='capacity-local-only';config.d1_databases[0].database_id='00000000-0000-0000-0000-000000000000';
config.r2_buckets[0].bucket_name='capacity-local-only';
config.assets.run_worker_first.push('/__scheduled');
fs.writeFileSync(path.join(scratch,'wrangler.jsonc'),JSON.stringify(config,null,2)+'\n');
const secrets=fs.readFileSync(path.join(root,'.dev.vars.example'),'utf8');
assert.ok(!/^RESEND_API_KEY\s*=/m.test(secrets),'Provider key prohibited');
fs.writeFileSync(path.join(scratch,'.dev.vars'),secrets);
fs.mkdirSync(path.join(scratch,'.wrangler'),{recursive:true});
const log=fs.openSync(path.join(scratch,'.wrangler','server.log'),'a');
function wrangler(args){assert.ok(!args.includes('--remote'),'Remote commands prohibited');const r=spawnSync(process.execPath,[cli,...args],{cwd:scratch,encoding:'utf8',windowsHide:true,env:{...process.env,CI:'true'}});fs.appendFileSync(path.join(scratch,'.wrangler','setup.log'),r.stdout+r.stderr);assert.equal(r.status,0,`Local Wrangler failed: ${args.slice(0,4).join(' ')}; inspect setup.log`);return r.stdout;}
function sql(query){const file='.wrangler/query.sql';fs.writeFileSync(path.join(scratch,file),query);return JSON.parse(wrangler(['d1','execute','DB','--local','--file',file,'--json']));}
wrangler(['d1','migrations','apply','DB','--local']);
wrangler(['d1','execute','DB','--local','--file','db/facility.sql']);
// Synthetic accounts reuse the committed dev credential contract; 50 identities still sign in independently.
sql(fs.readFileSync(path.join(root,'db/seed.dev.sql'),'utf8').split('-- END GENERATED USERS')[0].split(/-- BEGIN GENERATED USERS[^\r\n]*\r?\n/)[1]);
const fixtures=[];
for(let i=0;i<50;i++)fixtures.push(`INSERT INTO users(id,email,name,password_hash,password_salt,password_iterations,password_scheme,role,membership,status,created_at,updated_at) SELECT 'capacity-user-${i}','capacity-${i}@example.invalid','Synthetic Capacity ${i}',password_hash,password_salt,password_iterations,password_scheme,'player','member','active',created_at,updated_at FROM users WHERE id='u_juan'; INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,created_at,updated_at) VALUES('capacity-history-${i}','CAPACITY-HISTORY-${i}','capacity-user-${i}','court-1','2025-01-01',600,660,'COMPLETED',0,'member',1,1); INSERT INTO booking_events(booking_id,type,actor_role,created_at) VALUES('capacity-history-${i}','created','player',1),('capacity-history-${i}','completed','system',2);`);
for(const [group,burst] of [1,10,12,50].entries())for(let i=0;i<burst;i++)fixtures.push(`INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,hold_expires_at,created_at,updated_at) VALUES('capacity-expiry-${burst}-${i}','CAPACITY-EXPIRY-${burst}-${i}','capacity-user-${i%50}','court-1','2025-01-0${group+2}',${i*15},${i*15+60},'TEMPORARY',50000,'member',1,1,1); INSERT INTO booking_events(booking_id,type,actor_role,created_at) VALUES('capacity-expiry-${burst}-${i}','created','player',1);`);
fixtures.push("UPDATE opening_hours SET is_open=1,open_min=0,close_min=1440; UPDATE settings SET value='' WHERE key IN ('staff_alert_emails','staff_alert_sms');");
fixtures.push("WITH RECURSIVE n(v) AS (VALUES(0) UNION ALL SELECT v+1 FROM n WHERE v<35999) INSERT INTO messages(id,booking_id,sender_id,sender_role,kind,body,created_at) SELECT 'capacity-message-'||v,'capacity-history-'||(v%50),'capacity-user-'||(v%50),'player',CASE WHEN v%10=0 THEN 'text' ELSE 'system' END,'Synthetic twelve-month history',unixepoch('now')*1000-31536000000+v*60000 FROM n;");
sql(fixtures.join('\n'));
await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(resolve));});
const server=spawn(process.execPath,[cli,'dev','--local','--test-scheduled','--port',String(port),'--inspector-port','0'],{cwd:scratch,stdio:['ignore',log,log],windowsHide:true,detached:process.platform!=='win32',env:{...process.env,CI:'true'}});
const samples={},errors=[],unexpected=[],cycles=[];let counter=0,cronRuns=0,soakStart;
const hashes={};for(const dir of ['src','public','migrations']){const visit=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const file=path.join(d,e.name);if(e.isDirectory())visit(file);else hashes[path.relative(scratch,file).replaceAll('\\','/')]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');}};visit(path.join(scratch,dir));}
const runId=Date.now().toString(36);
const key=()=>`capacity-${runId}-${++counter}`;
async function settled(promises){const results=await Promise.allSettled(promises),failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;return results.map(r=>r.value);}
async function request(label,method,url,body,cookie='',headers={},expected=[200]){
  const start=performance.now();let status=0;
  try{
    const form=body instanceof FormData;
    const response=await fetch(base+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{Origin:base}:{}),...(!form&&body?{'Content-Type':'application/json'}:{}),...headers},body:body?(form?body:JSON.stringify(body)):undefined,signal:AbortSignal.timeout(30000)});
    status=response.status;const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    if(!expected.includes(status)){const error={label,status,code:data?.error?.code};errors.push(error);throw Error(JSON.stringify(error));}
    return {status,data,cookie:response.headers.getSetCookie().find(c=>c.startsWith('ls_session='))?.split(';')[0]};
  }catch(error){if(!status)errors.push({label,status:0,error:error.name});throw error;}finally{(samples[label]??=[]).push({ms:performance.now()-start,status});}
}
const get=(label,url,cookie)=>request(label,'GET',url,null,cookie);
const post=(label,url,body,cookie,headers,expected)=>request(label,'POST',url,body,cookie,headers,expected);
async function login(email,portal='user'){
  const salt=(await post('salt','/api/auth/salt',{email})).data;
  const clientHash=await deriveClientHash('demo-pass-2026',salt.salt,salt.iterations);
  const result=await post('login','/api/auth/'+portal+'/login',{email,clientHash});assert.ok(result.cookie);return result.cookie;
}
const reads=['/api/facility','/api/bookings?group=upcoming','/api/notifications/badges','/api/credits'];
async function readRamp(users,cookies){await settled(Array.from({length:users},async(_,i)=>{for(const url of reads)await get('read '+url.split('?')[0],url,cookies[i]);}));}
async function writeCycle(i,cookies,admin){
  const started=performance.now(),cookie=cookies[i%50];const date=new Date(Date.now()+480*60000+(1+i%7)*86400000).toISOString().slice(0,10);
  const resourceId='court-'+(1+i%3),start=(i%12)*60;
  const hold=(await post('create hold','/api/bookings',{resourceId,date,starts:[start]},cookie,{'Idempotency-Key':key()},[201])).data.booking;
  const form=new FormData();form.set('file',new File([fs.readFileSync(path.join(root,'db/seed-proofs/juan.png'))],'synthetic.png',{type:'image/png'}));form.set('amountPesos',(hold.amountDue/100).toFixed(2));
  await post('proof upload',`/api/bookings/${hold.id}/proof`,form,cookie,{},[201]);
  await post('approve',`/api/admin/bookings/${hold.id}/approve`,{checklist:true},admin);
  const preview=(await post('disruption preview','/api/admin/disruptions/preview',{scope:{kind:'bookings',bookingIds:[hold.id]},category:'equipment_failure',reason:'Synthetic capacity exercise'},admin)).data.preview;
  const disruptionBody={...preview.input,previewToken:preview.previewToken},disruptionKey=key();
  const disruption=(await post('disruption apply','/api/admin/disruptions',disruptionBody,admin,{'Idempotency-Key':disruptionKey},[201])).data;
  const replay=(await post('disruption replay','/api/admin/disruptions',disruptionBody,admin,{'Idempotency-Key':disruptionKey})).data;
  assert.equal(replay.disruption.id,disruption.disruption.id);assert.equal(replay.replay,true);
  const credits=(await get('credits after disruption','/api/credits',cookie)).data;
  const credit=credits.credits.find(c=>c.source?.bookingId===hold.id);assert.ok(credit,'Credit belongs to cancelled booking');
  const refundKey=key(),refund={amount:100,method:'cash',note:'Synthetic capacity refund'};
  const [a,b]=await settled([0,1].map(()=>post('refund/replay',`/api/admin/credits/${credit.id}/refund`,refund,admin,{'Idempotency-Key':refundKey})));
  assert.ok(a.data.refund.transactionId);assert.equal(a.data.refund.transactionId,b.data.refund.transactionId);
  const quote=(await get('credit quote',`/api/bookings/quote?resourceId=${resourceId}&starts=${start}`,cookie)).data;
  const replacement=(await post('credit hold','/api/bookings',{resourceId,date,starts:[start],useCredit:true,expectedCredit:quote.creditApplied},cookie,{'Idempotency-Key':key()},[201])).data.booking;
  if(replacement.status==='TEMPORARY')await post('release credit hold',`/api/bookings/${replacement.id}/release`,{},cookie);
  else { // Accumulated available credits can fully fund later replacements; cancel through the accepted disruption API.
    const p=(await post('disruption preview','/api/admin/disruptions/preview',{scope:{kind:'bookings',bookingIds:[replacement.id]},category:'equipment_failure',reason:'Synthetic capacity cleanup'},admin)).data.preview;
    await post('disruption apply','/api/admin/disruptions',{...p.input,previewToken:p.previewToken},admin,{'Idempotency-Key':key()},[201]);
  }
  cycles.push({index:i,ms:performance.now()-started});
}
function invariantResults(){
  return sql(capacityInvariantSql()).flatMap(r=>r.results||[]);
}
function save(extra={}){
  const metrics=Object.fromEntries(Object.entries(samples).map(([label,values])=>{const sorted=values.map(v=>v.ms).sort((a,b)=>a-b),p=n=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*n))];return [label,{requests:values.length,p50:p(.5),p95:p(.95),p99:p(.99)}];}));
  const elapsedSeconds=soakStart?(performance.now()-soakStart)/1000:0;
  const result={environment:'disposable localhost workerd/D1/R2; provider disabled',runId,sourceHashes:hashes,secondsRequested:seconds,elapsedSeconds,ramps:validateOnly?[]:[20,35,50],accounts:validateOnly?1:50,fixtureAccounts:50,historyMessages:36000,historyMonths:12,expiryBurstFixtures:[1,10,12,50],validateOnly,cycles:cycles.length,cronRuns,metrics,errors,unexpected,usage:{requests:Object.values(samples).reduce((n,v)=>n+v.length,0),d1BilledRows:null,r2BilledOperations:null,workerCpuMs:null,workerMemoryBytes:null,plan:null,headroom:null,note:'Local latency/process metrics cannot establish deployed billing or CPU/memory limits. Intended staging metrics and accepted demand required.'},...extra};
  fs.writeFileSync(path.join(scratch,'.wrangler','capacity-mixed-results.json'),JSON.stringify(result,null,2)+'\n');
  fs.writeFileSync(path.join(root,'.wrangler','audit-capacity-mixed-latest.json'),JSON.stringify({scratch,...result},null,2)+'\n');return result;
}
try{
  let ready=false;for(let i=0;i<180;i++){if(server.exitCode!==null)throw Error('Local capacity server exited');try{if((await fetch(base+'/api/facility')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'Local capacity server ready');
  const admin=await login('ana.reyes@lespinners.example','admin');
  const cookies=[];for(let wave=0;wave<(validateOnly?1:5);wave++)cookies.push(...await settled(Array.from({length:validateOnly?1:10},(_,i)=>login(`capacity-${wave*10+i}@example.invalid`))));
  if(!validateOnly)for(const users of [20,35,50])await readRamp(users,cookies);
  await writeCycle(0,cookies,admin); // Validate the complete write path before the timed soak.
  soakStart=performance.now();let nextWrite=soakStart,nextCron=soakStart,nextRead=soakStart,index=1;
  while(!validateOnly&&performance.now()-soakStart<seconds*1000){
    const now=performance.now(),pending=[];
    if(now>=nextRead){pending.push(settled(cookies.map((cookie,i)=>get('soak '+reads[i%reads.length].split('?')[0],reads[i%reads.length],cookie))));nextRead=now+5000;}
    if(now>=nextWrite){pending.push(writeCycle(index++,cookies,admin));nextWrite=now+20000;}
    if(now>=nextCron){pending.push(settled([0,1,2].map(()=>get('overlapping cron','/__scheduled?cron='+encodeURIComponent('* * * * *'),admin))).then(()=>cronRuns+=3));nextCron=now+60000;}
    await settled(pending);if(now>=nextRead-5000)save({state:'running'});
    await new Promise(r=>setTimeout(r,250));
  }
  // Drain the deliberately delayed expiry fixtures through overlapping bounded ticks.
  for(let round=0;round<10;round++){await settled([0,1,2].map(()=>get('expiry catch-up cron','/__scheduled?cron='+encodeURIComponent('* * * * *'),admin)));cronRuns+=3;}
  const invariants=invariantResults();
  assertCapacityInvariants(invariants);
  const result=save({state:'passed',invariants});console.log(JSON.stringify({scope:'Local mixed workload only; G07 remains open',scratch,elapsedSeconds:result.elapsedSeconds,cycles:result.cycles,requests:result.usage.requests,cronRuns:result.cronRuns}));
}catch(error){unexpected.push({name:error.name,message:error.message});save({state:'failed'});throw error;}
finally{if(server.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(server.pid),'/t','/f'],{stdio:'ignore',windowsHide:true});else{try{process.kill(-server.pid,'SIGTERM');}catch{server.kill();}}}fs.closeSync(log);}
