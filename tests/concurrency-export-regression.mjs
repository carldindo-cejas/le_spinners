// Real Hono routes and transactional SQLite; isolated synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, NOW } from './helpers/readiness.mjs';

function routes(t) {
  const f = fixture(t), api = new Hono(), pending = [];
  const errors = (error, c) => c.json({ code: error.code, message: error.message }, error.status || 500);
  api.onError(errors);
  app.revenueRoutes.onError(errors); app.operationsRoutes.onError(errors);
  api.use('*', (c, next) => { c.set('user', f.admin); return next(); });
  api.route('/revenue', app.revenueRoutes); api.route('/admin', app.operationsRoutes);
  t.after(() => Promise.all(pending));
  const request = url => api.fetch(new Request('http://localhost' + url), f.env, { waitUntil(p) { pending.push(p); }, passThroughOnException() {} });
  const insert = f.DB.sqlite.prepare(`INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,payment_method,submitted_at,confirmed_at,hold_expires_at,created_at,updated_at)
    VALUES(?,?,'test_player','court-1','2026-10-07',600,660,?,50000,'member','gcash',?,?,?, ?,?)`);
  const seed = (i, status = 'COMPLETED') => insert.run('export-' + i, 'EXPORT-' + String(i).padStart(4, '0'), status, NOW, status === 'COMPLETED' ? NOW : null, status === 'TEMPORARY' ? NOW + 600_000 : null, NOW, NOW);
  const exportPart = async (part = 1, sort = 'user') => {
    const response = await request(`/revenue/export?from=2026-10-07&to=2026-10-07&sort=${sort}&dir=asc&part=${part}`);
    assert.equal(response.status, 200, await response.clone().text());
    return { version: response.headers.get('x-export-version'), rows: Number(response.headers.get('x-export-rows')), parts: Number(response.headers.get('x-export-parts')), text: await response.text() };
  };
  return { ...f, request, seed, exportPart };
}

test('CSV version changes for every joined source even when timestamps and row counts are unchanged', async t => {
  const f = routes(t);
  f.DB.sqlite.exec('BEGIN'); for (let i = 0; i < 1001; i++) f.seed(i); f.DB.sqlite.exec('COMMIT');
  const first = await f.exportPart();
  assert.equal(first.rows, 1001); assert.equal(first.parts, 2);
  let version = first.version;
  const changes = [
    ['users rename', "UPDATE users SET name='Renamed customer' WHERE id='test_player'"],
    ['verifier rename', "UPDATE users SET name='Renamed verifier' WHERE id='test_admin'"],
    ['resources rename', "UPDATE resources SET name='Renamed facility' WHERE id='court-1'"],
    ['bookings update at same timestamp', "UPDATE bookings SET booker_name='Changed booker',updated_at=updated_at WHERE id='export-0'"],
    ['booking slots insertion', "INSERT INTO booking_slots(booking_id,resource_id,date,start_min,end_min) VALUES('export-0','court-1','2026-10-07',600,660)"],
    ['booking slots update', "UPDATE booking_slots SET end_min=630 WHERE booking_id='export-0'"],
    ['booking slots deletion', "DELETE FROM booking_slots WHERE booking_id='export-0'"],
    ['payment proof insertion', `INSERT INTO payment_proofs(id,booking_id,user_id,r2_key,content_type,size,gcash_ref,status,created_at) VALUES('export-proof','export-0','test_player','synthetic/proof.png','image/png',1,'FIRST','approved',${NOW})`],
    ['payment proof update', "UPDATE payment_proofs SET gcash_ref='SECOND' WHERE id='export-proof'"],
    ['payment proof deletion', "DELETE FROM payment_proofs WHERE id='export-proof'"],
    ['booking credit insertion', `INSERT INTO booking_credits(id,user_id,origin,source_booking_id,amount,remaining,state,reason,created_at,updated_at) VALUES('export-credit','test_player','manual','export-0',100,100,'active','Synthetic',${NOW},${NOW})`],
    ['booking credit update', "UPDATE booking_credits SET reason='Synthetic update',updated_at=updated_at WHERE id='export-credit'"],
    ['booking credit deletion', "DELETE FROM booking_credits WHERE id='export-credit'"],
  ];
  for (const [name, sql] of changes) {
    f.DB.sqlite.exec(sql);
    const next = await f.exportPart(2);
    assert.equal(next.rows, 1001, name);
    assert.notEqual(next.version, version, name + ' must invalidate the previous part');
    version = next.version;
  }
  const unchanged = await f.exportPart(2);
  assert.equal(unchanged.version, version);
  assert.equal(f.DB.one('PRAGMA quick_check').quick_check, 'ok');
  assert.equal(f.DB.rows('PRAGMA foreign_key_check').length, 0);
});

test('Export revision rolls back with a failed transaction and fresh parts form one complete ledger', async t => {
  const f = routes(t); for (let i = 0; i < 1001; i++) f.seed(i);
  const before = await f.exportPart(1, 'ref');
  await assert.rejects(f.DB.batch([
    f.DB.prepare("UPDATE resources SET name='Must roll back' WHERE id='court-1'"),
    f.DB.prepare('INSERT INTO revenue_export_revision(id,revision) VALUES(1,0)'),
  ]));
  assert.equal((await f.exportPart(2, 'ref')).version, before.version);
  f.DB.sqlite.exec("UPDATE resources SET name='Committed rename',updated_at=updated_at WHERE id='court-1'");
  const a = await f.exportPart(1, 'ref'), b = await f.exportPart(2, 'ref');
  assert.notEqual(a.version, before.version); assert.equal(a.version, b.version);
  const refs = [...(a.text + b.text).matchAll(/"(EXPORT-\d+)"/g)].map(match => match[1]);
  assert.equal(refs.length, 1001); assert.equal(new Set(refs).size, 1001);
  assert.match(a.text, /Committed rename/); assert.match(b.text, /Committed rename/);
});

test('Dashboard totals remain accurate beyond the bounded 50-row previews', async t => {
  const f = routes(t);
  const insert = f.DB.sqlite.prepare(`INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,hold_expires_at,created_at,updated_at)
    VALUES(?,?,'test_player',?,'2026-10-08',?,?,?,50000,'member',?,?,?)`);
  for (let i = 0; i < 120; i++) {
    const resource = 'court-' + (1 + Math.floor(i / 24)), start = (i % 24) * 60;
    // Synthetic resources make every live interval distinct and retain database protections.
    if (i % 24 === 0 && i >= 72) f.DB.sqlite.prepare("INSERT INTO resources SELECT ?,activity,?,sort_order,status,maintenance_note,maintenance_until,price_member,price_non_member,created_at,updated_at,open_play FROM resources WHERE id='court-1'").run(resource, 'Synthetic ' + resource);
    insert.run('queue-' + i, 'QUEUE-' + i, resource, start, start + 60, i < 60 ? 'PAYMENT_SUBMITTED' : 'TEMPORARY', i < 60 ? null : NOW + 600_000, NOW, NOW);
  }
  const response = await f.request('/admin/summary'); assert.equal(response.status, 200, await response.clone().text());
  const summary = await response.json();
  assert.equal(summary.counts.pendingVerification, 60); assert.equal(summary.counts.activeHolds, 60);
  assert.equal(summary.verification.length, 50); assert.equal(summary.holds.length, 50);
});

test('Ledger chooses the latest inserted payment proof when timestamps tie', async t => {
  const f = routes(t); f.seed(0);
  const insert = f.DB.sqlite.prepare("INSERT INTO payment_proofs(id,booking_id,user_id,r2_key,content_type,size,gcash_ref,status,created_at) VALUES(?,'export-0','test_player',?,'image/png',1,?,'rejected',?)");
  insert.run('old-proof', 'synthetic/old.png', 'OLD-REF', NOW); insert.run('new-proof', 'synthetic/new.png', 'LATEST-REF', NOW);
  const exported = await f.exportPart();
  assert.match(exported.text, /LATEST-REF/); assert.doesNotMatch(exported.text, /OLD-REF/);
});

test('Verification and dashboard queues show the newest proof when timestamps tie', async t => {
  const f = routes(t); f.seed(0, 'PAYMENT_SUBMITTED');
  const insert = f.DB.sqlite.prepare("INSERT INTO payment_proofs(id,booking_id,user_id,r2_key,content_type,size,gcash_ref,status,created_at) VALUES(?,'export-0','test_player',?,'image/png',1,?,?,?)");
  insert.run('old-proof', 'synthetic/old.png', 'OLD-REF', 'rejected', NOW);
  insert.run('new-proof', 'synthetic/new.png', 'LATEST-REF', 'submitted', NOW);
  for (const [url, key] of [['/admin/verifications?tab=pending', 'items'], ['/admin/summary', 'verification']]) {
    const response = await f.request(url); assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data[key][0].proof.id, 'new-proof'); assert.equal(data[key][0].proof.gcashRef, 'LATEST-REF');
  }
});
