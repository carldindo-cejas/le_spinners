import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { app, fixture, seedBooking, proofFile, credit, hold, NOW } from './helpers/readiness.mjs';

async function approvalFixture(t) {
  const f = fixture(t), pending = [], errors = [];
  const api = new Hono();
  const error = (err, c) => {
    errors.push(err);
    return c.json({ error: { code: err.code ?? 'INTERNAL', message: err.code ? err.message : 'Something went wrong on our side. Please try again.' } }, err.status ?? 500);
  };
  api.onError(error); app.operationsRoutes.onError(error); app.revenueRoutes.onError(error);
  api.use('*', app.loadSession);
  api.use('/staff/*', app.roleGuard(app.requireStaff));
  api.use('/admin/*', app.roleGuard(app.requireAdmin));
  api.route('/staff', app.operationsRoutes);
  api.route('/admin/revenue', app.revenueRoutes);
  api.route('/admin', app.operationsRoutes);
  const cookie = async id => {
    const token = app.newToken(), key = await app.sha256Hex(token);
    f.DB.sqlite.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at,auth_version) SELECT ?,id,?,?,?,auth_version FROM users WHERE id=?')
      .run(key, NOW, NOW + 86400000, NOW, id);
    return `ls_session=${token}`;
  };
  const request = (path, body, session = '') => api.fetch(new Request('http://localhost' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Cookie: session },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), f.env, { waitUntil(p) { pending.push(p); }, passThroughOnException() {} });
  t.after(async () => { await Promise.all(pending); });
  return { ...f, request, cookie, errors };
}

async function submitted(f) {
  seedBooking(f.DB);
  await app.submitProof(f.env, await app.loadSettings(f.DB), f.player, 'test_booking', proofFile(), { gcashRef: 'synthetic-reference', amount: 50000 }, NOW);
  return f.DB.one("SELECT id FROM payment_proofs WHERE status='submitted'").id;
}

const effectCounts = f => Object.fromEntries(['booking_events', 'messages', 'notifications', 'outbox'].map(table => [table, f.DB.count(table)]));

for (const role of ['admin', 'staff']) test(`${role} approval confirms the reviewed proof, resolves alerts and counts cash exactly once`, async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), session = await f.cookie(`test_${role}`);
  const path = `/${role}/bookings/test_booking/approve`, body = { proofId, checklist: true, message: 'Synthetic payment reviewed' };
  const response = await f.request(path, body, session);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const detail = await response.json();
  assert.equal(detail.booking.status, 'CONFIRMED');
  const b = f.DB.one('SELECT * FROM bookings');
  assert.equal(b.confirmed_at, NOW); assert.equal(b.confirmed_by, `test_${role}`); assert.equal(b.hold_expires_at, null);
  assert.equal(f.DB.one('SELECT status FROM payment_proofs WHERE id=?', proofId).status, 'approved');
  assert.equal(f.DB.count('booking_events', "type='approved'"), 1);
  assert.equal(f.DB.count('notifications', "type='payment_verified' AND audience='user'"), 1);
  assert.equal(f.DB.count('notifications', "audience='staff' AND resolved_at IS NULL"), 0);
  assert.equal(f.DB.count('outbox', "subject LIKE '%Booking confirmed%'"), 1);
  const counts = effectCounts(f);
  assert.equal((await f.request(path, body, session)).status, 409);
  assert.deepEqual(effectCounts(f), counts);
  const revenue = await (await f.request('/admin/revenue/summary', undefined, await f.cookie('test_admin'))).json();
  assert.equal(revenue.periods.find(p => p.key === 'day').collected, 50000);
  assert.equal(revenue.periods.find(p => p.key === 'day').payments, 1);
});

for (const role of ['admin', 'staff']) test(`${role} missing authorization-table migration fails closed and migration restores approval`, async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), session = await f.cookie(`test_${role}`);
  f.DB.sqlite.exec('DROP TABLE mutation_authorization_guard');
  const before = effectCounts(f);
  const failed = await f.request(`/${role}/bookings/test_booking/approve`, { checklist: true, proofId }, session);
  assert.equal(failed.status, 503, 'A missing required migration must be reported as temporary unavailability');
  assert.equal((await failed.json()).error.code, 'OPERATIONS_UNAVAILABLE');
  assert.equal(f.DB.one('SELECT status FROM bookings').status, 'PAYMENT_SUBMITTED');
  assert.equal(f.DB.one('SELECT status FROM payment_proofs').status, 'submitted');
  assert.deepEqual(effectCounts(f), before);
  f.DB.sqlite.exec('DROP INDEX idx_users_role_created');
  f.DB.sqlite.exec(readFileSync(new URL('../migrations/0021_staff_account_management.sql', import.meta.url), 'utf8'));
  assert.equal((await f.request(`/${role}/bookings/test_booking/approve`, { checklist: true, proofId }, session)).status, 200);
  assert.equal(f.DB.count('booking_events', "type='approved'"), 1);
});

test('Twenty simultaneous admin/staff approvals produce one confirmation and one set of effects', async t => {
  const f = await approvalFixture(t), proofId = await submitted(f);
  const sessions = [await f.cookie('test_admin'), await f.cookie('test_staff')];
  const responses = await Promise.all(Array.from({ length: 20 }, (_, n) => f.request(`/${n % 2 ? 'staff' : 'admin'}/bookings/test_booking/approve`, { checklist: true, proofId }, sessions[n % 2])));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 19);
  assert.equal(f.DB.count('booking_events', "type='approved'"), 1);
  assert.equal(f.DB.count('notifications', "type='payment_verified'"), 1);
  assert.equal(f.DB.count('outbox', "subject LIKE '%Booking confirmed%'"), 1);
});

for (const role of ['admin', 'staff']) test(`${role} approval recovers a lost batch response after commit`, async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), session = await f.cookie(`test_${role}`);
  f.DB.afterCommit = statements => {
    if (statements.some(s => s.sql.includes("SET status = 'CONFIRMED'"))) {
      f.DB.afterCommit = null;
      throw Error('Synthetic transport failure after committed approval');
    }
  };
  const response = await f.request(`/${role}/bookings/test_booking/approve`, { checklist: true, proofId }, session);
  assert.equal(response.status, 200, 'A committed approval must be reconciled before reporting failure');
  assert.equal((await response.json()).booking.status, 'CONFIRMED');
  assert.equal(f.DB.count('booking_events', "type='approved'"), 1);
  assert.equal(f.DB.count('outbox', "subject LIKE '%Booking confirmed%'"), 1);
});

for (const role of ['admin', 'staff']) test(`${role} approval is successful when the post-commit deferred lookup fails`, async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), session = await f.cookie(`test_${role}`);
  f.DB.beforeRead = statement => {
    if (statement.sql.includes("SELECT disruption_id FROM disruption_items WHERE booking_id = ? AND outcome = 'deferred'")) {
      f.DB.beforeRead = null;
      throw Error('Synthetic deferred lookup database failure');
    }
  };
  const response = await f.request(`/${role}/bookings/test_booking/approve`, { checklist: true, proofId }, session);
  assert.equal(response.status, 200, 'Best-effort disruption lookup must not turn a committed approval into HTTP 500');
  assert.equal((await response.json()).booking.status, 'CONFIRMED');
  assert.equal(f.DB.count('booking_events', "type='approved'"), 1);
});

for (const keepHold of [true, false]) test(`Rejection recovers a committed lost response (resubmit window=${keepHold})`, async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), session = await f.cookie('test_staff');
  f.DB.afterCommit = statements => {
    if (statements.some(s => s.sql.includes('rejected_at ='))) {
      f.DB.afterCommit = null;
      throw Error('Synthetic transport failure after committed rejection');
    }
  };
  const body = { proofId, reason: 'Synthetic incorrect amount', keepHold };
  const response = await f.request('/staff/bookings/test_booking/reject', body, session);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).booking.status, keepHold ? 'REJECTED' : 'EXPIRED');
  assert.equal(f.DB.one('SELECT status FROM payment_proofs').status, 'rejected');
  assert.equal(f.DB.count('booking_events', "type='rejected'"), 1);
  assert.equal(f.DB.count('notifications', "type='proof_rejected'"), 1);
  assert.equal(f.DB.count('outbox', "subject LIKE '%Payment proof rejected%'"), 1);
  assert.equal((await f.request('/staff/bookings/test_booking/reject', body, session)).status, 409);
  assert.equal(f.DB.count('booking_events', "type='rejected'"), 1);
});

test('A committed decision with an unavailable reconciliation read stays unconfirmed without duplicate effects', async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), session = await f.cookie('test_admin');
  f.DB.afterCommit = statements => {
    if (statements.some(s => s.sql.includes("SET status = 'CONFIRMED'"))) {
      f.DB.afterCommit = null;
      throw Error('Synthetic transport failure after committed approval');
    }
  };
  f.DB.beforeRead = statement => {
    if (statement.sql.startsWith('SELECT 1 FROM bookings WHERE id = ? AND transition_id = ?')) {
      f.DB.beforeRead = null;
      throw Error('Synthetic unavailable reconciliation');
    }
  };
  const body = { checklist: true, proofId };
  assert.equal((await f.request('/admin/bookings/test_booking/approve', body, session)).status, 500);
  assert.equal(f.DB.one('SELECT status FROM bookings').status, 'CONFIRMED');
  assert.equal((await f.request('/admin/bookings/test_booking/approve', body, session)).status, 409);
  assert.equal(f.DB.count('booking_events', "type='approved'"), 1);
  assert.equal(f.DB.count('outbox', "subject LIKE '%Booking confirmed%'"), 1);
});

test('An approval side-effect database failure rolls back proof, booking, revenue and notifications', async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), session = await f.cookie('test_admin'), counts = effectCounts(f);
  f.DB.beforeExecute = statement => { if (statement.sql.includes('INSERT INTO notifications')) throw Error('Synthetic private SQL failure'); };
  const response = await f.request('/admin/bookings/test_booking/approve', { checklist: true, proofId }, session);
  assert.equal(response.status, 500); assert.equal((await response.json()).error.message.includes('SQL'), false);
  assert.equal(f.DB.one('SELECT status,confirmed_at FROM bookings').status, 'PAYMENT_SUBMITTED');
  assert.equal(f.DB.one('SELECT confirmed_at FROM bookings').confirmed_at, null);
  assert.equal(f.DB.one('SELECT status FROM payment_proofs').status, 'submitted');
  assert.deepEqual(effectCounts(f), counts);
  f.DB.beforeExecute = null;
  assert.equal((await f.request('/admin/bookings/test_booking/approve', { checklist: true, proofId }, session)).status, 200);
});

test('Credit plus cash approval reports only collected cash and does not spend credit twice', async t => {
  const f = await approvalFixture(t), creditId = await credit(f), settings = await app.loadSettings(f.DB);
  f.DB.sqlite.prepare("UPDATE resources SET price_member=60000 WHERE id='court-1'").run();
  const booking = await app.createHold(f.env, settings, f.player, { ...hold, useCredit: true, expectedCredit: 50000, idempotencyKey: 'approval-credit-cash-test' }, NOW);
  assert.equal(booking.amount_due, 10000); assert.equal(booking.credit_applied, 50000);
  await app.submitProof(f.env, settings, f.player, booking.id, proofFile(), { amount: 10000, gcashRef: null }, NOW);
  const proofId = f.DB.one('SELECT id FROM payment_proofs').id, session = await f.cookie('test_admin');
  const path = `/admin/bookings/${booking.id}/approve`, body = { checklist: true, proofId };
  assert.equal((await f.request(path, body, session)).status, 200);
  assert.equal((await f.request(path, body, session)).status, 409);
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits WHERE id=?', creditId).remaining, 0);
  assert.equal(f.DB.count('credit_transactions', "kind='redeem'"), 1);
  assert.equal(f.DB.count('booking_events', "type='approved'"), 1);
  const revenue = await (await f.request('/admin/revenue/summary', undefined, session)).json();
  assert.equal(revenue.periods.find(p => p.key === 'day').collected, 10000);
  assert.equal(revenue.periods.find(p => p.key === 'day').payments, 1);
});

test('A payment received during its hold remains verifiable after the original hold deadline', async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), session = await f.cookie('test_staff');
  t.mock.method(Date, 'now', () => NOW + 11 * 60_000);
  assert.equal(await app.sweepExpired(f.env, NOW + 11 * 60_000), 0);
  const response = await f.request('/staff/bookings/test_booking/approve', { checklist: true, proofId }, session);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).booking.status, 'CONFIRMED');
  assert.equal(f.DB.one('SELECT hold_expires_at FROM bookings').hold_expires_at, null);
});

for (const status of ['TEMPORARY', 'REJECTED', 'CANCELLED', 'EXPIRED', 'CONFIRMED', 'COMPLETED']) test(`Approval rejects ${status} booking without effects`, async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), session = await f.cookie('test_staff');
  f.DB.sqlite.prepare('UPDATE bookings SET status=?,hold_expires_at=?').run(status, status === 'TEMPORARY' || status === 'REJECTED' ? NOW - 1 : null);
  const counts = effectCounts(f);
  assert.equal((await f.request('/staff/bookings/test_booking/approve', { checklist: true, proofId }, session)).status, 409);
  assert.equal(f.DB.one('SELECT status FROM bookings').status, status);
  assert.deepEqual(effectCounts(f), counts);
});

test('Anonymous/player callers and staff admin-namespace access cannot approve; malformed review input is rejected', async t => {
  const f = await approvalFixture(t), proofId = await submitted(f), body = { checklist: true, proofId }, counts = effectCounts(f);
  assert.equal((await f.request('/staff/bookings/test_booking/approve', body)).status, 401);
  assert.equal((await f.request('/staff/bookings/test_booking/approve', body, await f.cookie('test_player'))).status, 403);
  const session = await f.cookie('test_staff');
  assert.equal((await f.request('/admin/bookings/test_booking/approve', body, session)).status, 403);
  for (const malformed of [{ checklist: false, proofId }, { checklist: true }, { checklist: true, proofId: null }, '{invalid-json']) {
    const response = await f.request('/staff/bookings/test_booking/approve', malformed, session);
    assert.ok([400, 422].includes(response.status));
  }
  assert.equal((await f.request('/staff/bookings/test_booking/approve', { ...body, proofId: 'nonexistent-proof' }, session)).status, 409);
  assert.equal((await f.request('/staff/bookings/no-such-booking/approve', body, session)).status, 404);
  assert.deepEqual(effectCounts(f), counts);
});
