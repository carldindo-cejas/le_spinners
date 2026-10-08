import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, seedBooking, proofFile, NOW } from './helpers/readiness.mjs';

function pauseWrite(f, match) {
  let release, entered;
  const arrived = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pause = async statements => {
    if (statements.some(match)) { f.DB.beforeWrite = null; f.DB.beforeRead = null; entered(); await gate; }
  };
  f.DB.beforeWrite = pause;
  f.DB.beforeRead = statement => pause([statement]);
  return { arrived, release };
}
async function payments(t) {
  const f = fixture(t); seedBooking(f.DB);
  const settings = await app.loadSettings(f.DB);
  const submit = () => app.submitProof(f.env, settings, f.player, 'test_booking', proofFile(), { gcashRef: null, amount: 50000 }, NOW);
  const proof = () => f.DB.one("SELECT id FROM payment_proofs WHERE status='submitted'")?.id;
  const reject = proofId => app.rejectPayment(f.env, settings, f.staff, 'test_booking', { reason: 'Use a corrected screenshot', message: null, keepHold: true, proofId }, NOW);
  return { ...f, settings, submit, proof, reject };
}

test('Delayed old upload cannot become a resubmission after a competing proof is rejected', async t => {
  const f = await payments(t);
  const pause = pauseWrite(f, s => s.sql.includes("SET status = 'PAYMENT_SUBMITTED'"));
  const delayed = f.submit(); await pause.arrived;
  try { await f.submit(); await f.reject(f.proof()); } finally { pause.release(); }
  await assert.rejects(delayed, { code: 'BOOKING_CHANGED' });
  assert.equal(f.DB.one("SELECT status FROM bookings WHERE id='test_booking'").status, 'REJECTED');
  assert.equal(f.DB.count('payment_proofs'), 1);
  assert.equal(f.DB.count('payment_proofs', "status='submitted'"), 0);
  assert.equal(f.objects.size, 1);
});

test('A delayed REJECTED upload cannot cross a complete submit/reject cycle at an equal clock', async t => {
  const f = await payments(t); await f.submit(); await f.reject(f.proof());
  const put = f.env.PROOFS.put;
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.env.PROOFS.put = async (...args) => { f.env.PROOFS.put = put; entered(); await gate; return put(...args); };
  const delayed = f.submit(); await ready;
  try { await f.submit(); await f.reject(f.proof()); } finally { release(); }
  await assert.rejects(delayed, { code: 'BOOKING_CHANGED' });
  assert.equal(f.DB.one("SELECT status FROM bookings WHERE id='test_booking'").status,'REJECTED');
  assert.equal(f.DB.count('payment_proofs'),2); assert.equal(f.DB.count('payment_proofs',"status='submitted'"),0);
  assert.equal(f.DB.count('booking_events',"type='proof_submitted'"),2);
  assert.equal(f.objects.size,2); assert.equal(f.DB.count('storage_uploads',"state='attached'"),2);
});

test('A cron warning during a valid temporary-hold upload does not reject its proof', async t => {
  const f = await payments(t);
  f.DB.sqlite.prepare('UPDATE bookings SET hold_expires_at=?').run(NOW + 60000);
  const pause = pauseWrite(f, s => s.sql.includes("SET status = 'PAYMENT_SUBMITTED'"));
  const uploading = f.submit(); await pause.arrived;
  try { assert.equal(await app.warnExpiringHolds(f.env, f.settings, NOW), 1); } finally { pause.release(); }
  assert.equal((await uploading).status, 'PAYMENT_SUBMITTED');
  assert.equal(f.DB.count('payment_proofs'), 1); assert.equal(f.objects.size, 1);
});

for (const action of ['approve', 'reject']) test(`Delayed ${action} cannot act on a replacement proof`, async t => {
  const f = await payments(t); await f.submit(); const original = f.proof();
  const pause = pauseWrite(f, s => s.sql.includes(action === 'approve' ? "SET status = 'CONFIRMED'" : 'rejected_at ='));
  const delayed = action === 'approve'
    ? app.approvePayment(f.env, f.admin, 'test_booking', NOW, null, original)
    : f.reject(original);
  await pause.arrived;
  try { await f.reject(original); await f.submit(); } finally { pause.release(); }
  await assert.rejects(delayed, { code: 'PROOF_CHANGED' });
  assert.notEqual(f.proof(), original);
  assert.equal(f.DB.one("SELECT status FROM bookings WHERE id='test_booking'").status, 'PAYMENT_SUBMITTED');
  assert.equal(f.DB.count('booking_events', "type='approved'"), 0);
  assert.equal(f.DB.count('booking_events', "type='rejected'"), 1);
});

test('Twenty simultaneous proof submissions on one hold have one success and one retained object', async t => {
  const f = await payments(t);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => f.submit()));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'ALREADY_SUBMITTED'));
  assert.equal(f.DB.count('payment_proofs'), 1); assert.equal(f.objects.size, 1);
  assert.equal(f.DB.count('booking_events', "type='proof_submitted'"), 1);
  assert.equal(f.DB.count('messages', "kind='proof'"), 1);
  assert.equal(f.DB.count('storage_uploads', "state='attached'"), 1);
});

async function apiFixture(t) {
  const f = fixture(t), pending = [];
  const api = new Hono(), error = (e,c) => c.json({ code: e.code ?? 'INTERNAL' }, e.status ?? 500);
  api.onError(error); app.operationsRoutes.onError(error); app.meRoutes.onError(error);
  api.use('*', app.loadSession); api.route('/staff', app.operationsRoutes); api.route('/me', app.meRoutes);
  const token = async id => {
    const value = app.newToken(), key = await app.sha256Hex(value);
    f.DB.sqlite.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at,auth_version) SELECT ?,id,?,?,?,auth_version FROM users WHERE id=?')
      .run(key, NOW, NOW + 86400000, NOW, id);
    return `ls_session=${value}`;
  };
  const request = (method, path, body, cookie) => api.fetch(new Request('http://localhost'+path, { method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }), f.env,
    { waitUntil(p) { pending.push(p); }, passThroughOnException() {} });
  t.after(async () => { await Promise.all(pending); });
  return { ...f, token, request, pending };
}

for (const action of ['approve', 'reject']) test(`Public ${action} rejects a stale reviewed proof ID and requires proof identity`, async t => {
  const f = await apiFixture(t); seedBooking(f.DB);
  const settings = await app.loadSettings(f.DB), cookie = await f.token('test_staff');
  const send = () => app.submitProof(f.env, settings, f.player, 'test_booking', proofFile(), { gcashRef: null, amount: null }, NOW);
  await send(); const original = f.DB.one('SELECT id FROM payment_proofs').id;
  await app.rejectPayment(f.env, settings, f.staff, 'test_booking', { proofId: original, reason: 'Correct it', message: null, keepHold: true }, NOW);
  await send(); const replacement = f.DB.one("SELECT id FROM payment_proofs WHERE status='submitted'").id;
  const detail = await f.request('GET','/staff/bookings/test_booking',null,cookie);
  assert.equal((await detail.json()).proofs[0].id,replacement, 'Equal-clock proof history must show the current screenshot first');
  const body = action === 'approve' ? { checklist: true } : { reason: 'Correct it', keepHold: true };
  const path = `/staff/bookings/test_booking/${action}`;
  assert.equal((await f.request('POST', path, body, cookie)).status, 422);
  const stale = await f.request('POST', path, { ...body, proofId: original }, cookie);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'PROOF_CHANGED');
  assert.equal(f.DB.one("SELECT status FROM bookings WHERE id='test_booking'").status, 'PAYMENT_SUBMITTED');
  assert.equal((await f.request('POST', path, { ...body, proofId: replacement }, cookie)).status, 200);
});

test('Concurrent partial profile edits preserve independent fields', async t => {
  const f = await apiFixture(t), cookie = await f.token('test_player');
  const pause = pauseWrite(f, s => s.sql.includes('UPDATE users SET name'));
  const name = f.request('PATCH', '/me', { name: 'New concurrent name' }, cookie); await pause.arrived;
  try { assert.equal((await f.request('PATCH', '/me', { phone: '09171234567' }, cookie)).status, 200); } finally { pause.release(); }
  assert.equal((await name).status, 200);
  const row = f.DB.one("SELECT name,phone FROM users WHERE id='test_player'");
  assert.equal(row.name, 'New concurrent name'); assert.equal(row.phone, '09171234567');
});

test('A delayed activity touch cannot shorten a newer session expiry', async t => {
  const f = await apiFixture(t), cookie = await f.token('test_player');
  f.DB.sqlite.prepare('UPDATE sessions SET last_seen_at=?').run(NOW - 2*3600000);
  const pause = pauseWrite(f, s => s.sql.includes('UPDATE sessions SET last_seen_at'));
  assert.equal((await f.request('GET', '/me', null, cookie)).status, 200); await pause.arrived;
  const expires = NOW + 31*86400000;
  f.DB.sqlite.prepare('UPDATE sessions SET last_seen_at=?,expires_at=?').run(NOW+1, expires);
  pause.release(); await Promise.all(f.pending);
  assert.equal(f.DB.one('SELECT expires_at FROM sessions').expires_at, expires);
});

test('Payment proof cleanup uses an indexed R2 reference lookup', async t => {
  const f = fixture(t);
  const plan = f.DB.rows('EXPLAIN QUERY PLAN SELECT 1 FROM payment_proofs WHERE r2_key=?', 'proofs/synthetic.png');
  assert.ok(plan.some(row => /SEARCH payment_proofs USING COVERING INDEX .*\(r2_key=\?\)/.test(row.detail)), JSON.stringify(plan));
});

test('Mixed cron checkpoints expose the Free-plan query budget requirement', async t => {
  const f = fixture(t);
  const insert = f.DB.sqlite.prepare(`INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,hold_expires_at,created_at,updated_at)
    VALUES(?,?, 'test_player','court-1',?,?,?, ?,50000,'member',?,?,?)`);
  for (let n=0; n<8; n++) {
    insert.run(`expired-${n}`,`EXPIRED-${n}`,'2026-10-08',n*60,n*60+60,'TEMPORARY',NOW-1,NOW,NOW);
    insert.run(`warning-${n}`,`WARNING-${n}`,'2026-10-08',480+n*60,540+n*60,'TEMPORARY',NOW+60000,NOW,NOW);
    insert.run(`complete-${n}`,`COMPLETE-${n}`,'2026-10-06',n*60,n*60+60,'CONFIRMED',null,NOW,NOW);
  }
  let statements=0; f.DB.beforeExecute = () => { statements++; };
  const report = await app.runMaintenance(f.env, NOW, { cron: true });
  assert.equal(report.expired,8); assert.equal(report.warned,8); assert.equal(report.completed,8);
  assert.ok(statements>50, `Measured ${statements} SQL statements in the mixed cron pass`);
  t.diagnostic(`Mixed cron pass: ${statements} SQL statements; requires Paid D1's 1000-query budget or shared task budgeting.`);
});

test('Payment transaction statement counts stay bounded independently of concurrency', async t => {
  const f = await payments(t), counts = {};
  let statements = 0; f.DB.beforeExecute = () => { statements++; };
  await f.submit(); counts.submit = statements;
  statements = 0; await f.reject(f.proof()); counts.reject = statements;
  statements = 0; await f.submit(); counts.resubmit = statements;
  statements = 0; await app.approvePayment(f.env,f.admin,'test_booking',NOW,null,f.proof()); counts.approve = statements;
  assert.ok(Object.values(counts).every(n => n<50), JSON.stringify(counts));
  t.diagnostic(`Payment function SQL statements without alert recipients or route/detail reads: ${JSON.stringify(counts)}`);
});
