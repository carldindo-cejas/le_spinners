// Real local D1/R2/API exercise. Only the documented disposable runtime/port is supported.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deriveClientHash } from '../public/js/core/password.js';
import { app } from './helpers/readiness.mjs';
import { png } from './helpers/images.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const base=process.env.BASE_URL||'http://127.0.0.1:8795';
assert.match(base,/^http:\/\/127\.0\.0\.1:\d+$/);
const scratch=path.resolve(process.env.STORAGE_RUNTIME_ROOT||path.join(root,'.wrangler/readiness-storage-runtime-20261007'));
if(!scratch.startsWith(path.resolve(root,'.wrangler')+path.sep)||!existsSync(path.join(scratch,'wrangler.jsonc')))throw new Error('Missing isolated runtime.');
let cookie='';
async function request(method,url,body,json=false){
  const response=await fetch(base+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{Origin:base}:{}),...(json?{'Content-Type':'application/json'}:{})},body:json?JSON.stringify(body):body});
  const session=response.headers.getSetCookie?.().find(c=>c.startsWith('ls_session='));if(session)cookie=session.split(';')[0];
  return response;
}
const email='ana.reyes@lespinners.example';
const saltResponse=await request('POST','/api/auth/salt',{email},true);assert.equal(saltResponse.status,200);
const salt=await saltResponse.json();
const clientHash=await deriveClientHash('demo-pass-2026',salt.salt,salt.iterations);
assert.equal((await request('POST','/api/auth/admin/login',{email,clientHash},true)).status,200);
const original=await request('GET','/api/facility/gcash-qr');assert.equal(original.status,200);
const originalType=original.headers.get('Content-Type'),originalBytes=new Uint8Array(await original.arrayBuffer());
const upload=bytes=>{const form=new FormData();form.set('file',new File([bytes],'synthetic.png'));return request('PUT','/api/admin/settings/gcash-qr',form);};
try {
  assert.equal((await upload(png.subarray(0,8))).status,422);
  assert.equal((await upload(png)).status,200);
  const saved=await request('GET','/api/facility/gcash-qr');assert.equal(saved.status,200);
  assert.deepEqual(new Uint8Array(await saved.arrayBuffer()),app.stripMetadata(png,app.sniffImage(png)));
  const replacements=await Promise.all([upload(png),upload(png)]);assert.ok(replacements.every(r=>r.status===200));
  assert.equal((await request('DELETE','/api/admin/settings/gcash-qr')).status,200);
  assert.equal((await request('GET','/api/facility/gcash-qr')).status,404);
  // Fast-forward only the retired QR checkpoints in this already verified scratch database.
  const rel='.wrangler/tmp/storage-runtime-grace.sql';mkdirSync(path.join(scratch,'.wrangler/tmp'),{recursive:true});
  writeFileSync(path.join(scratch,rel),"UPDATE storage_uploads SET next_attempt_at=0 WHERE kind='qr' AND state='delete_pending';\n");
  const cli=spawnSync(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local',`--file=${rel}`,'--json'],
    {cwd:scratch,encoding:'utf8',windowsHide:true,env:{...process.env,CI:'true'}});
  assert.equal(cli.status,0,cli.stderr);
  const scheduled=await fetch(`${base}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
  assert.equal(scheduled.status,200);assert.equal(await scheduled.text(),'Ran scheduled event','Route the local test handler before static assets');
  let health;
  for(let attempt=0;attempt<40;attempt++) {
    health=await (await request('GET','/api/admin/storage-health')).json();
    if(health.cleanupPending===0)break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(health.cleanupPending,0);assert.equal(health.needsReview,0);assert.equal(health.deleteFailures,0);
  console.log('Real local D1/R2 passed: malformed rejection, image round-trip, overlapping QR replacements, atomic removal and cron cleanup.');
  const created=await request('POST','/api/admin/payment-methods',{name:'Runtime Bank',accountNumber:'SYNTHETIC-123'},true);
  assert.equal(created.status,201);const methodId=(await created.json()).id;
  try {
    const methodUpload=()=>{const form=new FormData();form.set('file',new File([png],'synthetic-method.png'));return request('PUT',`/api/admin/payment-methods/${methodId}/qr`,form);};
    assert.equal((await methodUpload()).status,200);
    const qr=await request('GET',`/api/facility/payment-methods/${methodId}/qr`);assert.equal(qr.status,200);
    assert.equal(qr.headers.get('Cache-Control'),'private, no-store');
    assert.deepEqual(new Uint8Array(await qr.arrayBuffer()),app.stripMetadata(png,app.sniffImage(png)));
    assert.equal((await fetch(base+`/api/facility/payment-methods/${methodId}/qr`)).status,401);
    const enabled=await (await request('GET','/api/facility')).json();assert.ok(enabled.paymentMethods.some(method=>method.id===methodId));
    assert.equal((await request('PUT',`/api/admin/payment-methods/${methodId}`,{name:'Runtime Bank',enabled:false},true)).status,200);
    const disabled=await (await request('GET','/api/facility')).json();assert.equal(disabled.paymentMethods.some(method=>method.id===methodId),false);
    assert.equal((await request('DELETE',`/api/admin/payment-methods/${methodId}/qr`)).status,200);
    assert.equal((await request('GET',`/api/facility/payment-methods/${methodId}/qr`)).status,404);
    console.log('Real configurable-method D1/R2 passed: CRUD, optional details, private QR round-trip, disabled filtering and QR removal.');
  } finally { assert.equal((await request('DELETE',`/api/admin/payment-methods/${methodId}`)).status,200); }
} finally {
  const form=new FormData();form.set('file',new File([originalBytes],'restored-qr',{type:originalType}));
  assert.equal((await request('PUT','/api/admin/settings/gcash-qr',form)).status,200,'Restore the synthetic QR image');
  assert.equal((await request('POST','/api/auth/logout',{},true)).status,200);
}
