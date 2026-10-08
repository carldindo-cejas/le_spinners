import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, seedBooking, proofFile, NOW, TestD1, root } from './helpers/readiness.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function setup(t) {
  const f = fixture(t), api = new Hono();
  let actor = f.admin;
  const errors = (error, c) => c.json({ code: error.code, message: error.message }, error.status || 500);
  for (const route of [api, app.adminSettingsRoutes, app.bookingRoutes, app.revenueRoutes, app.operationsRoutes, app.facilityRoutes]) route.onError(errors);
  api.use('*', (c, next) => { c.set('user', actor); return next(); });
  api.route('/admin', app.adminSettingsRoutes); api.route('/revenue', app.revenueRoutes);
  api.route('/operations', app.operationsRoutes); api.route('/bookings', app.bookingRoutes); api.route('/', app.facilityRoutes);
  f.env.PROOFS.get = async key => f.objects.has(key) ? { body: f.objects.get(key), httpMetadata: { contentType: 'image/png' } } : null;
  const request = (url, method = 'GET', body) => api.fetch(new Request('http://localhost' + url, {
    method, ...(body instanceof FormData ? { body } : body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  }), f.env, f.c.executionCtx);
  async function add(body = { name: 'Maya', accountName: 'Test recipient', accountNumber: '09123456789' }) {
    const response = await request('/admin/payment-methods', 'POST', body);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).id;
  }
  const qr = (id, file = proofFile()) => { const data = new FormData(); data.set('file', file); return request(`/admin/payment-methods/${id}/qr`, 'PUT', data); };
  const submit = async (id) => app.submitProof(f.env, await app.loadSettings(f.DB), f.player, 'test_booking', proofFile(), { gcashRef: 'METHOD-123', amount: 50000, paymentMethodId: id });
  return { ...f, request, add, qr, submit, role(user) { actor = user; } };
}

test('Populated migration preserves legacy settings, bookings, proofs and QR keys', t => {
  const db = new TestD1(); t.after(() => db.sqlite.close());
  for (const file of readdirSync(path.join(root, 'migrations')).filter(file => file.endsWith('.sql') && file < '0020').sort()) db.sqlite.exec(readFileSync(path.join(root, 'migrations', file), 'utf8'));
  db.sqlite.exec(readFileSync(path.join(root, 'db/facility.sql'), 'utf8'));
  db.sqlite.exec(`INSERT INTO users(id,email,name,password_hash,created_at,updated_at) VALUES('legacy','legacy@example.invalid','Legacy','',1,1);
    INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('gcash_name','Legacy recipient',1),('gcash_number','09123456789',1),('gcash_qr_key','settings/gcash-qr/legacy.png',1);
    INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,submitted_at,confirmed_at,created_at,updated_at)
      VALUES('legacy','LEGACY','legacy','court-1','2026-10-07',600,660,'CONFIRMED',50000,'member',1,1,1,1);
    INSERT INTO payment_proofs(id,booking_id,user_id,r2_key,content_type,size,status,created_at) VALUES('legacy','legacy','legacy','proofs/legacy/proof.png','image/png',100,'approved',1);`);
  db.sqlite.exec(readFileSync(path.join(root, 'migrations/0020_payment_methods.sql'), 'utf8'));
  assert.equal(db.one('SELECT qr_key FROM payment_methods').qr_key, 'settings/gcash-qr/legacy.png');
  assert.equal(db.one('SELECT account_name FROM payment_methods').account_name, 'Legacy recipient');
  assert.deepEqual({ ...db.one('SELECT payment_method_id,payment_method_name,amount_due,status FROM bookings') }, { payment_method_id: 'gcash', payment_method_name: 'GCash', amount_due: 50000, status: 'CONFIRMED' });
  assert.equal(db.one('SELECT payment_method_name FROM payment_proofs').payment_method_name, 'GCash');
  db.sqlite.exec("UPDATE settings SET value='New legacy recipient' WHERE key='gcash_name'");
  assert.equal(db.one('SELECT account_name FROM payment_methods').account_name, 'New legacy recipient');
});

test('Method CRUD validates names and optional details, and is admin-only', async t => {
  const f = setup(t);
  for (const actor of [null, f.player, f.staff]) {
    f.role(actor);
    for (const [url, method, body] of [['/admin/payment-methods', 'POST', { name: 'Forbidden' }], ['/admin/payment-methods/gcash', 'PUT', { name: 'Forbidden' }], ['/admin/payment-methods/gcash', 'DELETE'], ['/admin/payment-methods/gcash/qr', 'PUT'], ['/admin/payment-methods/gcash/qr', 'DELETE']]) {
      const response = await f.request(url, method, body); assert.equal(response.status, actor ? 403 : 401);
    }
  }
  f.role(f.admin);
  for (const body of [{ name: '   ' }, { name: 'x'.repeat(81) }, { name: 'Bank', accountNumber: 'x'.repeat(101) }, { name: 'Bank', accountName: 'bad\nname' }, { name: 'Bank', qrKey: 'https://unsafe.invalid' }]) assert.equal((await f.request('/admin/payment-methods', 'POST', body)).status, 422);
  const id = await f.add({ name: 'Bank Transfer' });
  assert.equal((await f.request('/revenue/ledger?method=forged')).status, 422);
  assert.equal((await f.request('/revenue/export?method=forged')).status, 422);
  assert.equal(f.DB.one('SELECT account_number FROM payment_methods WHERE id=?', id).account_number, null);
  assert.equal((await f.request(`/admin/payment-methods/${id}`, 'PUT', { name: 'Bank', accountNumber: 'ABC-123', enabled: false })).status, 200);
  assert.equal(f.DB.one('SELECT enabled FROM payment_methods WHERE id=?', id).enabled, 0);
  assert.equal((await f.request(`/admin/payment-methods/${id}`, 'DELETE')).status, 200);
  assert.ok(f.DB.one('SELECT deleted_at FROM payment_methods WHERE id=?', id).deleted_at);
  assert.equal((await f.request(`/admin/payment-methods/${id}`, 'PUT', { name: 'Removed' })).status, 404);
});

test('Selected method and recipient snapshots survive renaming, removal, verification and CSV export', async t => {
  const f = setup(t); seedBooking(f.DB);
  const id = await f.add();
  const submitted = await f.submit(id);
  assert.equal(submitted.payment_method_id, id);
  assert.equal(f.DB.one('SELECT payment_method_name FROM payment_proofs').payment_method_name, 'Maya');
  const proofId = f.DB.one('SELECT id FROM payment_proofs').id;
  await f.request(`/admin/payment-methods/${id}`, 'PUT', { name: 'Renamed', accountNumber: 'changed', enabled: false });
  await f.request(`/admin/payment-methods/${id}`, 'DELETE');
  await app.approvePayment(f.env, f.staff, 'test_booking', NOW, null, proofId);
  const proofs = await app.listProofs(f.env, 'test_booking');
  assert.equal(proofs[0].paymentMethodName, 'Maya'); assert.equal(proofs[0].accountNumber, '09123456789');
  const ledger = await (await f.request(`/revenue/ledger?from=2026-10-07&to=2026-10-07&method=${id}`)).json();
  assert.equal(ledger.total, 1); assert.equal(ledger.rows[0].methodLabel, 'Maya'); assert.equal(ledger.totals.collected, 50000);
  const csv = await (await f.request(`/revenue/export?from=2026-10-07&to=2026-10-07&method=${id}`)).text();
  assert.ok(csv.includes('"Maya"')); assert.ok(csv.includes('"METHOD-123"'));
  const summary = await (await f.request('/revenue/summary')).json();
  assert.equal(summary.periods[0].collected, 50000); assert.ok(summary.methods.some(method => method.value === id));
  f.role(f.player);
  const detail = await (await f.request('/bookings/test_booking')).json();
  assert.equal(detail.booking.paymentMethodName, 'Maya'); assert.equal(detail.payment, null);
});

for (const change of ['disable', 'remove', 'edit']) test(`Method ${change} during proof upload rolls back all payment effects and cleans the file`, async t => {
  const f = setup(t); seedBooking(f.DB); const id = await f.add(); const put = f.env.PROOFS.put;
  f.env.PROOFS.put = async (...args) => {
    const result = await put(...args);
    if (change === 'remove') await f.request(`/admin/payment-methods/${id}`, 'DELETE');
    else await f.request(`/admin/payment-methods/${id}`, 'PUT', { name: change === 'edit' ? 'Changed' : 'Maya', enabled: change !== 'disable' });
    return result;
  };
  await assert.rejects(f.submit(id), error => error.code === 'PAYMENT_METHOD_UNAVAILABLE');
  assert.equal(f.DB.count('payment_proofs'), 0); assert.equal(f.objects.size, 0);
  assert.equal(f.DB.one('SELECT status FROM bookings').status, 'TEMPORARY');
});

test('Unavailable methods and forged identifiers cannot submit proof; old GCash clients remain supported', async t => {
  const f = setup(t); seedBooking(f.DB); const id = await f.add();
  await f.request(`/admin/payment-methods/${id}`, 'PUT', { name: 'Maya', enabled: false });
  for (const method of [id, 'on_site', 'none', 'forged']) await assert.rejects(f.submit(method), error => error.code === 'PAYMENT_METHOD_UNAVAILABLE');
  assert.equal(f.objects.size, 0);
  await f.submit(undefined);
  assert.equal(f.DB.one('SELECT payment_method_name FROM bookings').payment_method_name, 'GCash');
});

test('QR upload validates bytes, protects private images, retires replaced files and retains current method QR', async t => {
  const f = setup(t); const id = await f.add();
  assert.equal((await f.qr(id, new File(['<svg/>'], 'fake.png', { type: 'image/png' }))).status, 422);
  assert.equal((await f.qr(id, new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png'))).status, 413);
  assert.equal((await f.qr(id)).status, 200);
  const old = f.DB.one('SELECT qr_key FROM payment_methods WHERE id=?', id).qr_key;
  assert.equal((await f.qr(id)).status, 200);
  const current = f.DB.one('SELECT qr_key FROM payment_methods WHERE id=?', id).qr_key;
  assert.notEqual(old, current); assert.equal(f.DB.one('SELECT state FROM storage_uploads WHERE r2_key=?', old).state, 'delete_pending');
  f.role(null); assert.equal((await f.request(`/facility/payment-methods/${id}/qr`)).status, 401);
  f.role(f.player); assert.equal((await f.request(`/facility/payment-methods/${id}/qr`)).status, 200);
  f.role(f.admin); await f.request(`/admin/payment-methods/${id}`, 'PUT', { name: 'Maya', enabled: false });
  f.role(f.player); assert.equal((await f.request(`/facility/payment-methods/${id}/qr`)).status, 404);
  f.role(f.admin); assert.equal((await f.request(`/facility/payment-methods/${id}/qr`)).status, 200);
  t.mock.method(Date, 'now', () => NOW + 60001);
  await app.reconcileUploads(f.env);
  assert.equal(f.objects.has(old), false); assert.equal(f.objects.has(current), true);
  await f.request(`/admin/payment-methods/${id}/qr`, 'DELETE');
  assert.equal(f.DB.one('SELECT qr_key FROM payment_methods WHERE id=?', id).qr_key, null);
});

test('A method removed during QR storage cannot be resurrected or leak an orphan', async t => {
  const f = setup(t); const id = await f.add(); const put = f.env.PROOFS.put;
  f.env.PROOFS.put = async (...args) => { const result = await put(...args); await f.request(`/admin/payment-methods/${id}`, 'DELETE'); return result; };
  assert.equal((await f.qr(id)).status, 409); assert.equal(f.objects.size, 0);
  assert.equal(f.DB.one('SELECT qr_key FROM payment_methods WHERE id=?', id).qr_key, null);
});

test('Overlapping method QR replacements and a lost committed response preserve the final referenced image', async t => {
  const f = setup(t); const id = await f.add();
  assert.equal((await f.qr(id)).status, 200);
  const responses = await Promise.all([f.qr(id), f.qr(id)]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(f.DB.count('storage_uploads', "state='delete_pending'"), 2);
  f.DB.afterCommit = statements => {
    if (statements.some(statement => statement.sql.includes('payment_method_qr_updated'))) { f.DB.afterCommit = null; throw Error('Lost method QR commit response'); }
  };
  assert.equal((await f.qr(id)).status, 200);
  const key = f.DB.one('SELECT qr_key FROM payment_methods WHERE id=?', id).qr_key;
  t.mock.method(Date, 'now', () => NOW + 60001); await app.reconcileUploads(f.env);
  assert.deepEqual([...f.objects.keys()], [key]);
});

test('Resubmitted proof can change method without changing the previous proof or counting it as cash', async t => {
  const f = setup(t); seedBooking(f.DB); const id = await f.add();
  await f.submit(undefined);
  const oldProof = f.DB.one('SELECT id FROM payment_proofs').id;
  await app.rejectPayment(f.env, await app.loadSettings(f.DB), f.staff, 'test_booking', { reason: 'Test correction', keepHold: true, message: null }, NOW, oldProof);
  await f.submit(id);
  const proofs = await app.listProofs(f.env, 'test_booking');
  assert.deepEqual(proofs.map(proof => proof.paymentMethodName), ['Maya', 'GCash']);
  const pending = await (await f.request('/revenue/summary')).json(); assert.equal(pending.periods[0].collected, 0);
  await app.approvePayment(f.env, f.staff, 'test_booking', NOW, null, proofs[0].id);
  const verified = await (await f.request('/revenue/summary')).json(); assert.equal(verified.periods[0].collected, 50000);
});

test('Payment details expose enabled methods only and do not resurrect GCash when all methods are disabled', async t => {
  const f = setup(t); seedBooking(f.DB); const id = await f.add({ name: 'Details only', accountNumber: '123' });
  await f.request('/admin/payment-methods/gcash', 'PUT', { name: 'GCash', enabled: false });
  f.role(f.player);
  let detail = await (await f.request('/bookings/test_booking')).json();
  assert.equal(detail.payment.methods.length, 1); assert.equal(detail.payment.methods[0].id, id); assert.equal(detail.payment.methods[0].qrUrl, null);
  f.role(f.admin); await f.request(`/admin/payment-methods/${id}`, 'PUT', { name: 'Details only', accountNumber: '123', enabled: false }); f.role(f.player);
  detail = await (await f.request('/bookings/test_booking')).json(); assert.deepEqual(detail.payment.methods, []);
  assert.deepEqual((await (await f.request('/facility')).json()).paymentMethods, []);
  await assert.rejects(f.submit(id), error => error.code === 'PAYMENT_METHOD_UNAVAILABLE');
  f.role(f.admin); await f.request(`/admin/payment-methods/${id}`, 'PUT', { name: 'Details only', accountNumber: '123', enabled: true }); f.role(f.player);
  detail = await (await f.request('/bookings/test_booking')).json(); assert.equal(detail.payment.methods[0].id, id); assert.equal(detail.payment.methods[0].accountNumber, '123');
  assert.equal((await (await f.request('/facility')).json()).paymentMethods[0].id, id);
  f.role(f.admin); await f.request(`/admin/payment-methods/${id}`, 'DELETE'); f.role(f.player);
  detail = await (await f.request('/bookings/test_booking')).json(); assert.deepEqual(detail.payment.methods, []);
  f.role(null); const publicInfo = await (await f.request('/facility')).json(); assert.deepEqual(publicInfo.paymentMethods, []);
});

test('Dashboard cash uses verification date and facility availability follows maintenance, closures, hours and live occupancy', async t => {
  const f = setup(t); seedBooking(f.DB, 'CONFIRMED');
  f.DB.sqlite.prepare('UPDATE bookings SET date=?,confirmed_at=?,submitted_at=?').run('2026-10-09', NOW, NOW);
  f.DB.sqlite.exec(`UPDATE resources SET status='maintenance' WHERE id='court-3'; UPDATE resources SET status='disabled' WHERE id='table-3';`);
  let summary = await (await f.request('/operations/summary')).json();
  assert.equal(summary.verifiedRevenueToday, 50000);
  assert.deepEqual(summary.facility.availability, [{ activity: 'pickleball', available: 2, total: 3 }, { activity: 'table_tennis', available: 2, total: 3 }]);
  const revenue = await (await f.request('/revenue/summary')).json(); assert.equal(summary.verifiedRevenueToday, revenue.periods[0].collected);
  f.DB.sqlite.exec("INSERT INTO closures(id,date,resource_id,reason,created_at) VALUES('test_closed','2026-10-07','court-2','Test',1)");
  summary = await (await f.request('/operations/summary')).json(); assert.equal(summary.facility.availability[0].available, 1);
  f.DB.sqlite.exec("UPDATE bookings SET date='2026-10-07'; INSERT INTO booking_slots(booking_id,resource_id,date,start_min,end_min) VALUES('test_booking','court-1','2026-10-07',600,660)");
  summary = await (await f.request('/operations/summary')).json(); assert.equal(summary.facility.availability[0].available, 0);
  f.DB.sqlite.exec("UPDATE opening_hours SET is_open=0");
  summary = await (await f.request('/operations/summary')).json(); assert.equal(summary.facility.availability[1].available, 0);
  for (const status of ['PAYMENT_SUBMITTED', 'REJECTED', 'CANCELLED']) {
    f.DB.sqlite.prepare('UPDATE bookings SET status=?').run(status);
    summary = await (await f.request('/operations/summary')).json(); assert.equal(summary.verifiedRevenueToday, 0);
  }
});
