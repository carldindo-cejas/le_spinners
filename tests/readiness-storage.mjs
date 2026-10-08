import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, seedBooking, proofFile, NOW, root, TestD1 } from './helpers/readiness.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function setup(t) {
  const f=fixture(t);seedBooking(f.DB);
  let clock=NOW;t.mock.method(Date,'now',()=>clock);t.mock.method(console,'error',()=>{});
  const metadata=new Map(),deletes=[],lists=[];
  f.env.PROOFS.put=async(key,bytes)=>{f.objects.set(key,bytes);const object={key,size:bytes.byteLength,uploaded:new Date(clock)};metadata.set(key,object);return object;};
  f.env.PROOFS.delete=async key=>{deletes.push(key);f.objects.delete(key);metadata.delete(key);};
  f.env.PROOFS.list=async({prefix,cursor,limit})=>{
    lists.push({prefix,cursor,limit});const keys=[...f.objects.keys()].filter(k=>k.startsWith(prefix)&&(!cursor||k>cursor)).sort();
    const page=keys.slice(0,limit);return {objects:page.map(key=>metadata.get(key)||{key,size:1,uploaded:new Date(NOW-2*86400000)}),
      truncated:keys.length>page.length,cursor:page.at(-1)};
  };
  const api=new Hono(),error=(e,c)=>c.json({code:e.code},e.status??500);
  api.onError(error);app.adminSettingsRoutes.onError(error);
  api.use('*',async(c,next)=>{c.set('user',f.admin);await next();});api.route('/admin',app.adminSettingsRoutes);
  return {...f,metadata,deletes,lists,advance(ms){clock+=ms;},
    async proof(){return app.submitProof(f.env,await app.loadSettings(f.DB),f.player,'test_booking',proofFile(),{gcashRef:null,amount:null},clock);},
    async qr(method='PUT'){
      const form=new FormData();if(method==='PUT')form.set('file',proofFile());
      return api.fetch(new Request('http://localhost/admin/settings/gcash-qr',{method,...(method==='PUT'?{body:form}:{})}),f.env,f.c.executionCtx);
    },
  };
}
function failProofOnce(f) {
  f.DB.beforeExecute=stmt=>{if(stmt.sql.includes('INSERT INTO payment_proofs')){f.DB.beforeExecute=null;throw Error('Injected proof transaction failure');}};
}

test('M11 regression: definite D1 proof failure removes the unreferenced stored object',async t=>{
  const f=setup(t);failProofOnce(f);
  await assert.rejects(f.proof(),/Injected proof transaction failure/);
  assert.equal(f.objects.size,0);assert.equal(f.DB.count('payment_proofs'),0);assert.equal(f.DB.count('booking_events'),0);
  assert.equal(f.DB.one("SELECT status FROM bookings WHERE id='test_booking'").status,'TEMPORARY');
});
test('M11 regression: a committed proof with a lost D1 response recovers as success',async t=>{
  const f=setup(t);
  f.DB.afterCommit=stmts=>{if(stmts.some(s=>s.sql.includes('INSERT INTO payment_proofs'))){f.DB.afterCommit=null;throw Error('Lost transaction response');}};
  assert.equal((await f.proof()).status,'PAYMENT_SUBMITTED');
  assert.equal(f.DB.count('payment_proofs'),1);assert.equal(f.objects.size,1);
  assert.ok(f.objects.has(f.DB.one('SELECT r2_key FROM payment_proofs').r2_key));
});
test('M11 regression: definite QR setting failure cleans the new file and preserves the previous setting',async t=>{
  const f=setup(t);f.objects.set('settings/gcash-qr/old.png',new Uint8Array([1]));
  f.DB.sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES('gcash_qr_key','settings/gcash-qr/old.png',?)").run(NOW);
  f.DB.beforeExecute=stmt=>{if(stmt.sql.includes('INSERT INTO settings')){f.DB.beforeExecute=null;throw Error('Injected QR transaction failure');}};
  assert.equal((await f.qr()).status,500);
  assert.deepEqual([...f.objects.keys()],['settings/gcash-qr/old.png']);
  assert.equal(f.DB.one("SELECT value FROM settings WHERE key='gcash_qr_key'").value,'settings/gcash-qr/old.png');
});
test('M11 regression: R2 failure before writing creates no proof or stored object',async t=>{
  const f=setup(t);f.env.PROOFS.put=async()=>{throw Error('R2 unavailable');};
  await assert.rejects(f.proof(),/R2 unavailable/);assert.equal(f.objects.size,0);assert.equal(f.DB.count('payment_proofs'),0);
});

test('M11: R2 put response loss is fenced and cleaned without creating proof effects',async t=>{
  const f=setup(t),put=f.env.PROOFS.put;
  f.env.PROOFS.put=async(...args)=>{await put(...args);throw Error('Lost R2 response');};
  await assert.rejects(f.proof(),/Lost R2 response/);assert.equal(f.objects.size,0);assert.equal(f.DB.count('payment_proofs'),0);
  assert.equal(f.DB.one('SELECT state FROM storage_uploads').state,'deleted');
});
test('M11: failed R2 deletion remains queued with backoff and later converges',async t=>{
  const f=setup(t),del=f.env.PROOFS.delete;failProofOnce(f);
  f.env.PROOFS.delete=async()=>{throw Error('Delete unavailable');};
  await assert.rejects(f.proof());assert.equal(f.objects.size,1);
  assert.equal(f.DB.one('SELECT state FROM storage_uploads').state,'delete_pending');
  assert.equal((await app.reconcileUploads(f.env)).deleted,0);
  f.env.PROOFS.delete=del;f.advance(60001);
  assert.equal((await app.reconcileUploads(f.env)).deleted,1);assert.equal(f.objects.size,0);
});
test('M11: unavailable failure checkpoint leaves a lease that the next cron can recover',async t=>{
  const f=setup(t);
  f.DB.beforeExecute=stmt=>{if(stmt.sql.includes('INSERT INTO payment_proofs')){
    f.DB.beforeExecute=null;f.DB.beforeWrite=()=>{throw Error('D1 unavailable');};throw Error('Proof rolled back');
  }};
  await assert.rejects(f.proof(),/Proof rolled back/);assert.equal(f.objects.size,1);
  assert.equal(f.DB.one('SELECT state FROM storage_uploads').state,'staged');
  f.DB.beforeWrite=null;f.advance(app.UPLOAD_LEASE_MS+1);
  await app.reconcileUploads(f.env);assert.equal(f.objects.size,0);
});
test('M11: losing attachment after a long put is cleaned and cannot change the booking',async t=>{
  const f=setup(t),put=f.env.PROOFS.put;
  let started,release;const ready=new Promise(r=>started=r),held=new Promise(r=>release=r);
  f.env.PROOFS.put=async(...args)=>{started();await held;return put(...args);};
  const uploading=f.proof();await ready;f.advance(app.UPLOAD_LEASE_MS+1);
  await app.reconcileUploads(f.env);release();
  await assert.rejects(uploading,e=>e.code==='UPLOAD_EXPIRED');
  assert.equal(f.objects.size,0);assert.equal(f.DB.count('payment_proofs'),0);
  assert.equal(f.DB.one("SELECT status FROM bookings WHERE id='test_booking'").status,'TEMPORARY');
});
test('M11: a late put invalidates an in-flight delete acknowledgement and is swept again',async t=>{
  const f=setup(t),put=f.env.PROOFS.put,del=f.env.PROOFS.delete;
  let started,releasePut,deleted,releaseDelete;
  const ready=new Promise(r=>started=r),putHeld=new Promise(r=>releasePut=r),deleteReady=new Promise(r=>deleted=r),deleteHeld=new Promise(r=>releaseDelete=r);
  f.env.PROOFS.put=async(...args)=>{started();await putHeld;return put(...args);};
  const uploading=f.proof();await ready;f.advance(app.UPLOAD_LEASE_MS+1);
  f.env.PROOFS.delete=async key=>{await del(key);deleted();await deleteHeld;};
  const sweeping=app.reconcileUploads(f.env);await deleteReady;releasePut();
  await assert.rejects(uploading,e=>e.code==='UPLOAD_EXPIRED');assert.equal(f.objects.size,1);
  releaseDelete();assert.equal((await sweeping).lost,1);
  assert.equal(f.DB.one('SELECT state FROM storage_uploads').state,'deleting');
  f.env.PROOFS.delete=del;f.advance(60001);await app.reconcileUploads(f.env);assert.equal(f.objects.size,0);
});
test('M11: a remotely late put after a failed response is caught by its durable tombstone',async t=>{
  const f=setup(t);let late;
  f.env.PROOFS.put=async(key,bytes)=>{late={key,bytes};throw Error('Ambiguous R2 timeout');};
  await assert.rejects(f.proof());f.objects.set(late.key,late.bytes);f.advance(app.STORAGE_RECHECK_MS+1);
  await app.reconcileUploads(f.env);assert.equal(f.objects.size,0);
});
test('M11: overlapping sweepers own one cleanup and stale deletion results cannot replace a newer owner',async t=>{
  const f=setup(t),intent=await app.beginUpload(f.env,'proofs/test/stale.png','proof',f.player.id,'test_booking');
  f.objects.set(intent.key,new Uint8Array([1]));f.advance(app.UPLOAD_LEASE_MS+1);
  const del=f.env.PROOFS.delete;let started,release,calls=0;
  const ready=new Promise(r=>started=r),held=new Promise(r=>release=r);
  f.env.PROOFS.delete=async key=>{calls++;await del(key);if(calls===1){started();await held;}};
  const first=app.reconcileUploads(f.env);await ready;f.advance(60001);
  assert.equal((await app.reconcileUploads(f.env)).deleted,1);release();assert.equal((await first).lost,1);
  assert.equal(f.DB.one('SELECT state FROM storage_uploads').state,'deleted');assert.equal(f.objects.size,0);
});
test('M11: lost ownership-insert response starts no R2 operation',async t=>{
  const f=setup(t);
  f.DB.afterCommit=stmts=>{if(stmts.some(s=>s.sql.includes('INSERT INTO storage_uploads'))){f.DB.afterCommit=null;throw Error('Lost ownership response');}};
  await assert.rejects(f.proof(),/Lost ownership response/);assert.equal(f.objects.size,0);assert.equal(f.DB.count('payment_proofs'),0);
  f.advance(app.UPLOAD_LEASE_MS+1);await app.reconcileUploads(f.env);assert.equal(f.DB.one('SELECT state FROM storage_uploads').state,'deleted');
});
test('M11: a lost deletion checkpoint recovers idempotently after its lease',async t=>{
  const f=setup(t);failProofOnce(f);let fail=true;
  const original=f.DB.beforeExecute;
  f.DB.beforeExecute=stmt=>{original?.(stmt);if(fail&&stmt.sql.includes("SET state='deleted'")){fail=false;throw Error('Deletion checkpoint failed');}};
  // The proof hook clears beforeExecute; install the deletion fault when R2 deletion starts.
  const del=f.env.PROOFS.delete;f.env.PROOFS.delete=async key=>{await del(key);f.DB.beforeExecute=stmt=>{if(fail&&stmt.sql.includes("SET state='deleted'")){fail=false;throw Error('Deletion checkpoint failed');}};};
  await assert.rejects(f.proof());assert.equal(f.objects.size,0);assert.equal(f.DB.one('SELECT state FROM storage_uploads').state,'deleting');
  f.DB.beforeExecute=null;f.advance(60001);await app.reconcileUploads(f.env);assert.equal(f.DB.one('SELECT state FROM storage_uploads').state,'deleted');
});
test('M11: committed proof survives acknowledgement and verification-read failures',async t=>{
  const f=setup(t);
  f.DB.afterCommit=stmts=>{if(stmts.some(s=>s.sql.includes('INSERT INTO payment_proofs'))){f.DB.afterCommit=null;f.DB.beforeRead=()=>{throw Error('Read unavailable');};throw Error('Ack unavailable');}};
  await assert.rejects(f.proof(),/Ack unavailable/);f.DB.beforeRead=null;f.advance(app.STORAGE_RECHECK_MS+1);
  await app.reconcileUploads(f.env);assert.equal(f.objects.size,1);assert.equal(f.DB.count('payment_proofs'),1);
});
test('M11: overlapping QR replacements retire both previous keys and preserve the final current file',async t=>{
  const f=setup(t);f.objects.set('settings/gcash-qr/old.png',new Uint8Array([1]));
  f.DB.sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES('gcash_qr_key','settings/gcash-qr/old.png',?)").run(NOW);
  const responses=await Promise.all([f.qr(),f.qr()]);assert.ok(responses.every(r=>r.status===200));
  assert.equal(f.DB.count('audit_log',"action='gcash_qr_updated'"),2);assert.equal(f.objects.size,3);
  f.advance(60001);await app.reconcileUploads(f.env);
  assert.equal(f.objects.size,1);assert.ok(f.objects.has(f.DB.one("SELECT value FROM settings WHERE key='gcash_qr_key'").value));
});
test('M11: QR committed response loss returns success and preserves its referenced object',async t=>{
  const f=setup(t);f.DB.afterCommit=stmts=>{if(stmts.some(s=>s.sql.includes('INSERT INTO settings'))){f.DB.afterCommit=null;throw Error('Lost QR commit response');}};
  assert.equal((await f.qr()).status,200);assert.equal(f.objects.size,1);assert.equal(f.DB.count('audit_log',"action='gcash_qr_updated'"),1);
});
test('M11: QR removal atomically retires the actual old file with cache grace',async t=>{
  const f=setup(t);assert.equal((await f.qr()).status,200);const old=f.DB.one("SELECT value FROM settings WHERE key='gcash_qr_key'").value;
  assert.equal((await f.qr('DELETE')).status,200);assert.equal(f.DB.one("SELECT value FROM settings WHERE key='gcash_qr_key'").value,'');
  assert.ok(f.objects.has(old));await app.reconcileUploads(f.env);assert.ok(f.objects.has(old));
  f.advance(60001);await app.reconcileUploads(f.env);assert.equal(f.objects.size,0);
});
test('M11: legacy discovery is disabled by default and protects recent/unknown writes',async t=>{
  const f=setup(t);f.objects.set('proofs/old.png',new Uint8Array([1]));
  await app.reconcileUploads(f.env);assert.equal(f.lists.length,0);assert.equal(f.objects.size,1);
  f.env.STORAGE_ORPHAN_SCAN_ENABLED='true';f.metadata.set('proofs/old.png',{key:'proofs/old.png',uploaded:new Date(NOW)});
  await app.reconcileUploads(f.env);assert.equal(f.DB.count('storage_uploads'),0);assert.equal(f.objects.size,1);
});
test('M11: legacy scan and cleanup bound each page/pass to eight and resume the cursor',async t=>{
  const f=setup(t);f.env.STORAGE_ORPHAN_SCAN_ENABLED='true';
  for(let n=0;n<10;n++)f.objects.set(`proofs/orphan-${String(n).padStart(2,'0')}.png`,new Uint8Array([1]));
  assert.equal((await app.reconcileUploads(f.env)).deleted,8);assert.equal(f.objects.size,2);
  f.advance(60001);await app.reconcileUploads(f.env);f.advance(60001);
  assert.equal((await app.reconcileUploads(f.env)).deleted,2);assert.equal(f.objects.size,0);
  assert.ok(f.lists.every(call=>call.limit===8));assert.equal(f.DB.count('storage_uploads',"state='deleted'"),10);
});
test('M11: eight consecutive R2 delete failures become visible manual review',async t=>{
  const f=setup(t);failProofOnce(f);f.env.PROOFS.delete=async()=>{throw Error('Delete refused');};
  await assert.rejects(f.proof());
  for(let n=1;n<8;n++){f.advance(86400000);await app.reconcileUploads(f.env);}
  const row=f.DB.one('SELECT * FROM storage_uploads');assert.equal(row.state,'needs_review');assert.equal(row.last_error,'R2_DELETE_EXHAUSTED');
  assert.equal(f.objects.size,1);
});
test('M11: populated migration adopts proof/current-QR references without changing them',t=>{
  const DB=new TestD1();t.after(()=>DB.sqlite.close());
  for(const name of readdirSync(path.join(root,'migrations')).filter(n=>n.endsWith('.sql')&&n<'0014').sort())DB.sqlite.exec(readFileSync(path.join(root,'migrations',name),'utf8'));
  DB.sqlite.exec(readFileSync(path.join(root,'db/facility.sql'),'utf8'));
  DB.sqlite.prepare("INSERT INTO users(id,email,name,password_hash,role,membership,created_at,updated_at) VALUES('test_player','p@example.invalid','Test','','player','member',?,?)").run(NOW,NOW);
  seedBooking(DB);
  DB.sqlite.prepare("INSERT INTO payment_proofs(id,booking_id,user_id,r2_key,content_type,size,created_at) VALUES('legacy','test_booking','test_player','proofs/legacy.png','image/png',1,?)").run(NOW);
  DB.sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES('gcash_qr_key','settings/gcash-qr/legacy.png',?)").run(NOW);
  DB.sqlite.exec(readFileSync(path.join(root,'migrations/0014_storage_uploads.sql'),'utf8'));
  assert.equal(DB.count('storage_uploads',"state='attached'"),2);assert.equal(DB.count('payment_proofs'),1);
  assert.equal(DB.one("SELECT value FROM settings WHERE key='gcash_qr_key'").value,'settings/gcash-qr/legacy.png');
  assert.deepEqual(DB.rows('PRAGMA foreign_key_check'),[]);
});

test('M11: references arriving before the cleanup claim protect the file',async t=>{
  const f=setup(t),intent=await app.beginUpload(f.env,'proofs/test/referenced.png','proof',f.player.id,'test_booking');
  f.objects.set(intent.key,new Uint8Array([1]));f.advance(app.UPLOAD_LEASE_MS+1);
  f.DB.beforeWrite=stmts=>{if(stmts.some(s=>s.sql.includes('RETURNING id,r2_key'))){
    f.DB.beforeWrite=null;
    f.DB.sqlite.prepare("INSERT INTO payment_proofs(id,booking_id,user_id,r2_key,content_type,size,created_at) VALUES('late_ref','test_booking','test_player',?,'image/png',1,?)").run(intent.key,NOW);
  }};
  await app.reconcileUploads(f.env);assert.ok(f.objects.has(intent.key));assert.equal(f.deletes.length,0);
  await app.reconcileUploads(f.env);assert.equal(f.DB.one('SELECT state FROM storage_uploads').state,'attached');
});
test('M11: legacy scan skips historical objects with proof or current-QR references',async t=>{
  const f=setup(t);f.env.STORAGE_ORPHAN_SCAN_ENABLED='true';
  f.objects.set('proofs/linked.png',new Uint8Array([1]));f.objects.set('settings/gcash-qr/linked.png',new Uint8Array([1]));
  f.DB.sqlite.prepare("INSERT INTO payment_proofs(id,booking_id,user_id,r2_key,content_type,size,created_at) VALUES('linked','test_booking','test_player','proofs/linked.png','image/png',1,?)").run(NOW);
  f.DB.sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES('gcash_qr_key','settings/gcash-qr/linked.png',?)").run(NOW);
  await app.reconcileUploads(f.env);f.advance(60001);await app.reconcileUploads(f.env);
  assert.equal(f.objects.size,2);assert.equal(f.DB.count('storage_uploads'),0);assert.equal(f.deletes.length,0);
});
test('M11: scan cursor and adopted checkpoints survive a lost committed response',async t=>{
  const f=setup(t);f.env.STORAGE_ORPHAN_SCAN_ENABLED='true';f.objects.set('proofs/orphan.png',new Uint8Array([1]));
  f.DB.afterCommit=stmts=>{if(stmts.some(s=>s.sql.includes('INSERT OR IGNORE INTO storage_uploads'))){f.DB.afterCommit=null;throw Error('Lost scan checkpoint response');}};
  const report=await app.reconcileUploads(f.env);assert.equal(report.scanDeferred,true);
  assert.equal(f.objects.size,0);assert.equal(f.DB.count('storage_uploads'),1);
});
test('M11: QR remove failure rolls back the setting, audit, operation and cleanup together',async t=>{
  const f=setup(t);assert.equal((await f.qr()).status,200);
  const old=f.DB.one("SELECT value FROM settings WHERE key='gcash_qr_key'").value;
  f.DB.beforeExecute=stmt=>{if(stmt.sql.includes('INSERT INTO settings')){f.DB.beforeExecute=null;throw Error('Remove failed');}};
  assert.equal((await f.qr('DELETE')).status,500);assert.equal(f.DB.count('storage_qr_operations'),0);
  assert.equal(f.DB.one("SELECT value FROM settings WHERE key='gcash_qr_key'").value,old);assert.ok(f.objects.has(old));
  assert.equal(f.DB.count('audit_log',"action='gcash_qr_removed'"),0);
});
test('M11: QR removal with a lost committed response recovers without a second operation',async t=>{
  const f=setup(t);assert.equal((await f.qr()).status,200);
  f.DB.afterCommit=stmts=>{if(stmts.some(s=>s.sql.includes('INSERT INTO storage_qr_operations'))){f.DB.afterCommit=null;throw Error('Lost remove response');}};
  assert.equal((await f.qr('DELETE')).status,200);assert.equal(f.DB.count('storage_qr_operations'),1);
  assert.equal(f.DB.count('audit_log',"action='gcash_qr_removed'"),1);
});
test('M11: storage health is admin-only and omits file/owner details',async t=>{
  const f=setup(t);failProofOnce(f);f.env.PROOFS.delete=async()=>{throw Error('Delete failed');};await assert.rejects(f.proof());
  const view=await app.storageHealth(f.env);assert.equal(view.cleanupPending,1);assert.equal(view.deleteFailures,1);
  const encoded=JSON.stringify(view);
  for(const privateField of ['r2_key','owner_id','upload_token','proofs/','settings/gcash-qr/'])assert.equal(encoded.includes(privateField),false);
  const api=new Hono(),error=(e,c)=>c.json({code:e.code},e.status??500);let user=f.staff;
  api.onError(error);app.adminSettingsRoutes.onError(error);api.use('*',async(c,next)=>{c.set('user',user);await next();});api.route('/admin',app.adminSettingsRoutes);
  const request=()=>api.fetch(new Request('http://localhost/admin/storage-health'),f.env,f.c.executionCtx);
  assert.equal((await request()).status,403);user=f.admin;assert.equal((await request()).status,200);
});

test('M11: storage cleanup can be paused without losing durable failure checkpoints',async t=>{
  const f=setup(t);f.env.STORAGE_CLEANUP_ENABLED='false';failProofOnce(f);await assert.rejects(f.proof());
  assert.equal(f.objects.size,1);assert.equal(f.deletes.length,0);assert.equal((await app.reconcileUploads(f.env)).disabled,true);
  assert.equal((await app.storageHealth(f.env)).cleanupEnabled,false);
  f.env.STORAGE_CLEANUP_ENABLED='true';await app.reconcileUploads(f.env);assert.equal(f.objects.size,0);
});
test('M11: unreferenced historical keys outside the upload namespaces require review',async t=>{
  const f=setup(t);f.objects.set('unrelated/archive.png',new Uint8Array([1]));
  f.DB.sqlite.prepare("INSERT INTO storage_uploads(id,r2_key,kind,state,created_at,updated_at) VALUES('external','unrelated/archive.png','qr','attached',?,?)").run(NOW,NOW);
  await app.reconcileUploads(f.env);assert.ok(f.objects.has('unrelated/archive.png'));assert.equal(f.deletes.length,0);
  assert.equal(f.DB.one("SELECT last_error FROM storage_uploads WHERE id='external'").last_error,'UNKNOWN_STORAGE_NAMESPACE');
});
