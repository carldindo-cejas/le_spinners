import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { app, fixture, seedBooking, hold, credit, refundInput, proofFile, TestD1, root, NOW, TOMORROW } from './helpers/readiness.mjs';

test('H01: shared write schemas reject impossible and noncanonical dates', () => {
  for (const date of ['2026-02-29', '2027-02-30', '2026-11-31', '2026-00-10', '2026-13-01', '2026-01-00', '2026-01-32', '2026-1-01', '2026-01-01Z', ' 2026-01-01']) {
    assert.equal(app.zDate.safeParse(date).success, false, date);
    assert.equal(app.closureSchema.safeParse({ date, reason: 'Synthetic closure' }).success, false);
    assert.equal(app.resourceUpdateSchema.safeParse({ maintenanceUntil: date }).success, false);
    assert.equal(app.previewSchema.safeParse({ scope: { kind: 'window', date, start: 600, end: 660 }, category: 'maintenance', reason: 'Synthetic closure' }).success, false);
  }
  for (const date of ['2028-02-29', '2026-11-30', '2026-12-01']) assert.equal(app.zDate.safeParse(date).success, true, date);
});

test('H01: direct booking writers reject aliases before any booking/slot/credit write', async t => {
  const f = fixture(t);
  const settings = { ...await app.loadSettings(f.DB), bookingWindowDays: 60 };
  await assert.rejects(app.createHold(f.env, settings, f.player, { ...hold, date: '2026-11-31', useCredit: true }, NOW), { code: 'VALIDATION_ERROR' });
  await assert.rejects(app.createConsoleBooking(f.env, settings, f.admin, { ...hold, date: '2026-11-31', rate: 'member', payment: 'none', bookerName: 'Synthetic' }, NOW), { code: 'VALIDATION_ERROR' });
  assert.equal(f.DB.count('bookings'), 0);
  assert.equal(f.DB.count('booking_slots'), 0);
  assert.equal(f.DB.count('credit_transactions'), 0);
  const good = await app.createHold(f.env, settings, f.player, { ...hold, date: '2026-12-01' }, NOW);
  assert.equal(good.date, '2026-12-01');
});

test('H01: Manila midnight and booking-window boundaries remain valid', async t => {
  const f = fixture(t);
  const settings = await app.loadSettings(f.DB);
  const midnight = Date.parse('2026-10-07T16:00:00Z');
  assert.equal(app.localNow(480, midnight).date, TOMORROW);
  await assert.rejects(app.createHold(f.env, settings, f.player, { ...hold, date: '2026-10-07' }, midnight), { code: 'DATE_PAST' });
  await assert.rejects(app.createHold(f.env, settings, f.player, { ...hold, starts: [0] }, midnight), { code: 'TIME_STARTED' });
  const last = app.addDays(TOMORROW, settings.bookingWindowDays);
  assert.equal((await app.createHold(f.env, settings, f.player, { ...hold, date: last }, midnight)).date, last);
  await assert.rejects(app.createHold(f.env, settings, f.other, { ...hold, date: app.addDays(last, 1) }, midnight), { code: 'OUTSIDE_WINDOW' });
});

test('H01: database constraints reject new invalid dates and permit valid leap days', t => {
  const f = fixture(t); seedBooking(f.DB);
  for (const date of ['2026-11-31', '2027-02-29', '2026-00-01', '2026-1-01']) {
    assert.throws(() => f.DB.sqlite.prepare("UPDATE bookings SET date=? WHERE id='test_booking'").run(date), /invalid_calendar_date/);
    assert.throws(() => f.DB.sqlite.prepare("INSERT INTO closures(id,date,reason,created_at) VALUES('bad',?,'Synthetic',?)").run(date, NOW), /invalid_calendar_date/);
    assert.throws(() => f.DB.sqlite.prepare("UPDATE resources SET maintenance_until=? WHERE id='court-1'").run(date), /invalid_calendar_date/);
  }
  f.DB.sqlite.prepare("UPDATE bookings SET date='2028-02-29' WHERE id='test_booking'").run();
  assert.equal(f.DB.one("SELECT date FROM bookings WHERE id='test_booking'").date, '2028-02-29');
  assert.equal(f.DB.count('closures'), 0);
});

test('P0 migrations: populated upgrade preserves history and requires explicit legacy date repair', t => {
  const DB = new TestD1(); t.after(() => DB.sqlite.close());
  const migrations = readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort();
  const apply = file => DB.sqlite.exec(readFileSync(path.join(root, 'migrations', file), 'utf8'));
  migrations.filter(f => f < '0009').forEach(apply);
  DB.sqlite.exec(readFileSync(path.join(root, 'db/facility.sql'), 'utf8'));
  DB.sqlite.prepare("INSERT INTO users(id,email,name,password_hash,role,membership,created_at,updated_at) VALUES('test_player','test@example.invalid','Synthetic','','player','member',?,?)").run(NOW, NOW);
  seedBooking(DB);
  DB.sqlite.prepare("UPDATE bookings SET date='2026-11-31' WHERE id='test_booking'").run();
  migrations.filter(f => f >= '0009').forEach(apply);
  assert.equal(DB.one("SELECT date FROM bookings WHERE id='test_booking'").date, '2026-11-31');
  assert.equal(DB.count('bookings', "date(date,'+0 days') IS NOT date"), 1);
  assert.throws(() => DB.sqlite.prepare("UPDATE bookings SET date='2026-11-31' WHERE id='test_booking'").run(), /invalid_calendar_date/);
  DB.sqlite.prepare("UPDATE bookings SET date='2026-12-01' WHERE id='test_booking'").run();
  assert.equal(DB.count('bookings'), 1);
  assert.deepEqual(DB.rows('PRAGMA foreign_key_check'), []);
  assert.equal(DB.one('PRAGMA integrity_check').integrity_check, 'ok');
});

test('H02: equal-clock proof submissions create one proof and no dangling object', async t => {
  const f = fixture(t); seedBooking(f.DB);
  const settings = await app.loadSettings(f.DB);
  const send = () => app.submitProof(f.env, settings, f.player, 'test_booking', proofFile(), { gcashRef: null, amount: 50000 }, NOW);
  const results = await Promise.allSettled([send(), send()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.DB.count('payment_proofs'), 1);
  assert.equal(f.DB.count('booking_events', "type='proof_submitted'"), 1);
  assert.equal(f.DB.count('messages', "kind='proof'"), 1);
  assert.equal(f.objects.size, 1);
  assert.ok(f.objects.has(f.DB.one('SELECT r2_key FROM payment_proofs').r2_key));
  await assert.rejects(send(), { code: 'ALREADY_SUBMITTED' });
  assert.equal(f.DB.count('payment_proofs'), 1);
});

for (const action of ['approve', 'reject', 'cancel', 'release']) {
  test(`H02: equal-clock ${action} has one event/notice set, including response retry`, async t => {
    const f = fixture(t); seedBooking(f.DB, ['approve', 'reject'].includes(action) ? 'PAYMENT_SUBMITTED' : 'TEMPORARY');
    const settings = await app.loadSettings(f.DB);
    const run = {
      approve: () => app.approvePayment(f.env, f.admin, 'test_booking', NOW, 'Synthetic approval'),
      reject: () => app.rejectPayment(f.env, settings, f.admin, 'test_booking', { reason: 'Synthetic rejection', message: null, keepHold: false }, NOW),
      cancel: () => app.staffCancel(f.env, f.admin, 'test_booking', 'Synthetic cancellation', NOW),
      release: () => app.releaseHold(f.env, f.player, 'test_booking', NOW),
    }[action];
    const results = await Promise.allSettled([run(), run()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.DB.count('booking_events'), 1);
    assert.equal(f.DB.count('outbox'), action === 'release' ? 0 : 1);
    const counts = ['booking_events', 'messages', 'notifications', 'outbox'].map(table => f.DB.count(table));
    await assert.rejects(run());
    assert.deepEqual(['booking_events', 'messages', 'notifications', 'outbox'].map(table => f.DB.count(table)), counts);
  });
}

test('H02: approval competing with rejection has only the winning effects', async t => {
  const f = fixture(t); seedBooking(f.DB, 'PAYMENT_SUBMITTED');
  const settings = await app.loadSettings(f.DB);
  const results = await Promise.allSettled([
    app.approvePayment(f.env, f.admin, 'test_booking', NOW),
    app.rejectPayment(f.env, settings, f.admin, 'test_booking', { reason: 'Synthetic rejection', message: null, keepHold: true }, NOW),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.DB.count('booking_events'), 1);
  assert.equal(f.DB.count('outbox'), 1);
});

test('H02: duplicate release returns reserved credit only once', async t => {
  const f = fixture(t), id = await credit(f);
  const settings = await app.loadSettings(f.DB);
  f.DB.sqlite.prepare("UPDATE resources SET price_member=60000 WHERE id='court-1'").run();
  const booking = await app.createHold(f.env, settings, f.player, { ...hold, useCredit: true, expectedCredit: 50000 }, NOW);
  await Promise.allSettled([0, 1].map(() => app.releaseHold(f.env, f.player, booking.id, NOW)));
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits WHERE id=?', id).remaining, 50000);
  assert.equal(f.DB.count('credit_transactions', "kind='release'"), 1);
  assert.equal(f.DB.count('booking_events', "type='released'"), 1);
});

test('H03: intervening booking rolls back disruption; fresh preview includes it', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  const input = app.previewSchema.parse({ scope: { kind: 'window', date: TOMORROW, start: 600, end: 660, resourceId: 'court-1' }, category: 'maintenance', reason: 'Synthetic closure' });
  const plan = await app.buildPlan(f.c, f.admin, input, NOW);
  let booking;
  f.DB.beforeWrite = async statements => {
    if (statements.some(s => s.sql.includes('INSERT INTO disruptions'))) {
      f.DB.beforeWrite = null;
      booking = await app.createHold(f.env, settings, f.player, hold, NOW);
    }
  };
  await assert.rejects(app.applyDisruption(f.c, f.admin, { ...input, previewToken: plan.previewToken }, 'test-disruption-001', 'local'), { code: 'DISRUPTION_CHANGED' });
  assert.equal(f.DB.count('closures'), 0);
  assert.equal(f.DB.count('disruptions'), 0);
  assert.equal(f.DB.count('disruption_items'), 0);
  const fresh = await app.buildPlan(f.c, f.admin, input, NOW);
  assert.ok(fresh.items.some(i => i.booking.id === booking.id));
  await app.applyDisruption(f.c, f.admin, { ...input, previewToken: fresh.previewToken }, 'test-disruption-002', 'local');
  assert.equal(f.DB.count('disruption_items'), 1);
  assert.equal(f.DB.one('SELECT status FROM bookings WHERE id=?', booking.id).status, 'CANCELLED');
  await assert.rejects(app.createHold(f.env, settings, f.other, hold, NOW), { code: 'CLOSED' });
});

for (const kind of ['closure', 'resource', 'hours']) {
  test(`H03: ordinary ${kind} change rejects a booking arriving after affected-set read`, async t => {
    const f = fixture(t), settings = await app.loadSettings(f.DB);
    const trigger = { closure: 'INSERT INTO closures', resource: 'UPDATE resources', hours: 'INSERT INTO opening_hours' }[kind];
    f.DB.beforeWrite = async statements => {
      if (statements.some(s => s.sql.includes(trigger))) {
        f.DB.beforeWrite = null;
        await app.createHold(f.env, settings, f.player, hold, NOW);
      }
    };
    const run = {
      closure: () => app.createClosure(f.c, f.admin, app.closureSchema.parse({ date: TOMORROW, resourceId: 'court-1', reason: 'Synthetic closure' })),
      resource: () => app.updateResource(f.c, f.admin, 'court-1', app.resourceUpdateSchema.parse({ status: 'maintenance' })),
      hours: () => app.setWeeklyHours(f.c, f.admin, app.weekdayOf(TOMORROW), settings.slotMinutes, app.hoursSchema.parse({ isOpen: false, open: 0, close: 1440 })),
    }[kind];
    await assert.rejects(run(), { code: 'SCHEDULE_CHANGED' });
    assert.equal(f.DB.count('bookings'), 1);
    assert.equal(f.DB.count('closures'), 0);
    assert.equal(f.DB.one("SELECT status FROM resources WHERE id='court-1'").status, 'active');
    assert.equal(f.DB.one('SELECT is_open FROM opening_hours WHERE weekday=?', app.weekdayOf(TOMORROW)).is_open, 1);
  });
}

test('H03: hours changed after booking validation cannot admit stale booking', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  f.DB.beforeWrite = async statements => {
    if (statements.some(s => s.sql.includes('INSERT INTO bookings'))) {
      f.DB.beforeWrite = null;
      await app.setWeeklyHours(f.c, f.admin, app.weekdayOf(TOMORROW), settings.slotMinutes, app.hoursSchema.parse({ isOpen: false, open: 0, close: 1440 }));
    }
  };
  await assert.rejects(app.createHold(f.env, settings, f.player, hold, NOW), { code: 'SCHEDULE_CHANGED' });
  assert.equal(f.DB.count('bookings'), 0);
  assert.equal(f.DB.count('booking_slots'), 0);
});

test('M09: concurrent staff rename never overwrites administrator price', async t => {
  const f = fixture(t);
  f.DB.beforeWrite = async statements => {
    if (statements.some(s => s.sql.includes('UPDATE resources'))) {
      f.DB.beforeWrite = null;
      f.DB.sqlite.prepare("UPDATE resources SET price_member=99999 WHERE id='court-1'").run();
    }
  };
  try { await app.updateResource(f.c, f.staff, 'court-1', app.resourceUpdateSchema.parse({ name: 'Renamed court' })); }
  catch (error) { assert.equal(error.code, 'SCHEDULE_CHANGED'); }
  assert.equal(f.DB.one("SELECT price_member FROM resources WHERE id='court-1'").price_member, 99999);
  await app.updateResource(f.c, f.staff, 'court-1', app.resourceUpdateSchema.parse({ name: 'Renamed court' }));
  assert.equal(f.DB.one("SELECT price_member FROM resources WHERE id='court-1'").price_member, 99999);
});

test('H04: sequential and concurrent replay returns original refund without more effects', async t => {
  const f = fixture(t), id = await credit(f);
  const run = () => app.recordRefund(f.env, f.admin, id, refundInput, NOW);
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await run(), results[0]);
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits WHERE id=?', id).remaining, 40000);
  assert.equal(f.DB.count('credit_transactions', "kind='refund'"), 1);
  assert.equal(f.DB.count('audit_log', "action='refund_recorded'"), 1);
  assert.equal(f.DB.count('notifications', "title='Refund recorded'"), 1);
});

test('H04: changed payload is rejected; distinct intended refunds remain possible', async t => {
  const f = fixture(t), id = await credit(f);
  await app.recordRefund(f.env, f.admin, id, refundInput, NOW);
  for (const change of [{ amount: 20000 }, { method: 'gcash', reference: 'OTHER' }, { note: 'Changed' }]) {
    await assert.rejects(app.recordRefund(f.env, f.admin, id, { ...refundInput, ...change }, NOW), { code: 'IDEMPOTENCY_KEY_REUSED' });
  }
  await app.recordRefund(f.env, f.admin, id, { ...refundInput, idempotencyKey: 'test-refund-002' }, NOW);
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits WHERE id=?', id).remaining, 30000);
  assert.equal(f.DB.count('credit_transactions', "kind='refund'"), 2);
});

test('H04: concurrent changed-payload key reuse cannot debit twice', async t => {
  const f = fixture(t), id = await credit(f);
  const results = await Promise.allSettled([
    app.recordRefund(f.env, f.admin, id, refundInput, NOW),
    app.recordRefund(f.env, f.admin, id, { ...refundInput, amount: 20000 }, NOW),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(f.DB.count('credit_transactions', "kind='refund'"), 1);
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits WHERE id=?', id).remaining,
    f.DB.one('SELECT SUM(amount) AS balance FROM credit_transactions WHERE credit_id=?', id).balance);
});

test('H04: lost committed response can replay even after the balance reaches zero', async t => {
  const f = fixture(t), id = await credit(f);
  const input = { ...refundInput, amount: 50000 };
  f.DB.afterCommit = statements => {
    if (statements.some(s => s.sql.includes('refund_operations'))) {
      f.DB.afterCommit = null;
      throw new Error('Synthetic lost response after commit');
    }
  };
  await assert.rejects(app.recordRefund(f.env, f.admin, id, input, NOW), /Synthetic lost response/);
  const replay = await app.recordRefund(f.env, f.admin, id, input, NOW + 1000);
  assert.equal(replay.amount, 50000);
  assert.equal(replay.remaining, 0);
  assert.equal(f.DB.count('credit_transactions', "kind='refund'"), 1);
});

test('H04: failed refund effects roll back the ledger and replay record together', async t => {
  const f = fixture(t), id = await credit(f);
  f.DB.beforeExecute = stmt => { if (stmt.sql.includes("'refund_recorded'")) throw new Error('Synthetic D1 failure'); };
  await assert.rejects(app.recordRefund(f.env, f.admin, id, refundInput, NOW), /Synthetic D1 failure/);
  f.DB.beforeExecute = null;
  assert.equal(f.DB.count('credit_transactions', "kind='refund'"), 0);
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits WHERE id=?', id).remaining, 50000);
  await app.recordRefund(f.env, f.admin, id, refundInput, NOW);
  assert.equal(f.DB.count('credit_transactions', "kind='refund'"), 1);
});

test('H04: API requires a valid refund replay key', async t => {
  const f = fixture(t), id = await credit(f);
  const api = new Hono();
  app.adminCreditRoutes.onError((error, c) => c.json({ code: error.code }, error.status ?? 500));
  api.onError((error, c) => c.json({ code: error.code }, error.status ?? 500));
  api.use('*', async (c, next) => { c.set('user', f.admin); await next(); });
  api.route('/credits', app.adminCreditRoutes);
  for (const key of [null, 'bad!']) {
    const headers = { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) };
    const response = await api.request(`/credits/${id}/refund`, { method: 'POST', headers, body: JSON.stringify({ amount: 10000, method: 'cash' }) }, f.env);
    assert.equal(response.status, key ? 422 : 400);
  }
  assert.equal(f.DB.count('credit_transactions', "kind='refund'"), 0);
});
