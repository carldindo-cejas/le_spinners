import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, hold, credit, NOW, seedBooking } from './helpers/readiness.mjs';

const request = { ...hold, idempotencyKey: 'booking-retry-001' };
const settings = f => app.loadSettings(f.DB);
function failOn(f, sql) {
  f.DB.beforeExecute = stmt => { if (sql.test(stmt.sql)) throw Error('Injected database failure'); };
}

for (const funded of [false, true]) {
  test(`creation effects failure rolls back booking and credit (funded=${funded})`, async t => {
    const f = fixture(t);
    if (funded) await credit(f);
    const input = { ...request, useCredit: funded, expectedCredit: funded ? 50000 : null };
    failOn(f, /INSERT INTO booking_events/);
    await assert.rejects(app.createHold(f.env, await settings(f), f.player, input, NOW), /Injected/);
    assert.equal(f.DB.count('bookings'), 0);
    assert.equal(f.DB.count('booking_slots'), 0);
    assert.equal(f.DB.count('credit_transactions', "kind='redeem'"), 0);
    f.DB.beforeExecute = null;
    const b = await app.createHold(f.env, await settings(f), f.player, input, NOW);
    assert.equal(f.DB.count('booking_events', `booking_id='${b.id}'`), 1);
    assert.equal(f.DB.count('messages'), 1);
    assert.equal(f.DB.count('notifications', `booking_id='${b.id}'`), 2);
  });
}

test('lost creation response replays original booking, including after expiry', async t => {
  const f = fixture(t);
  const s = await settings(f);
  f.DB.afterCommit = statements => {
    if (statements.some(stmt => /INSERT INTO bookings/.test(stmt.sql))) {
      f.DB.afterCommit = null;
      throw Error('Lost response after commit');
    }
  };
  const first = await app.createHold(f.env, s, f.player, request, NOW).catch(() => null);
  const saved = f.DB.one('SELECT id FROM bookings');
  assert.ok(saved);
  if (first) assert.equal(first.id, saved.id);
  await app.sweepExpired(f.env, NOW + 86400000);
  const replay = await app.createHold(f.env, s, f.player, request, NOW + 86400000);
  assert.equal(replay.id, saved.id);
  assert.equal(f.DB.count('bookings'), 1);
  assert.equal(f.DB.count('booking_events', "type='created'"), 1);
});

test('creation key rejects changed payload and is scoped to actor', async t => {
  const f = fixture(t);
  const s = await settings(f);
  await app.createHold(f.env, s, f.player, request, NOW);
  await assert.rejects(app.createHold(f.env, s, f.player, { ...request, starts: [720] }, NOW), e => e.code === 'IDEMPOTENCY_KEY_REUSED');
  const other = await app.createHold(f.env, s, f.other, { ...request, starts: [720] }, NOW);
  assert.equal(other.user_id, f.other.id);
});

test('overlapping keyed creations converge to one complete booking', async t => {
  const f = fixture(t);
  const s = await settings(f);
  const results = await Promise.all([app.createHold(f.env, s, f.player, request, NOW), app.createHold(f.env, s, f.player, request, NOW)]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(f.DB.count('bookings'), 1);
  assert.equal(f.DB.count('notifications'), 2);
});

test('creation replay survives another request committing during validation', async t => {
  const f = fixture(t);
  await credit(f);
  const s = await settings(f);
  const input = { ...request, useCredit: true, expectedCredit: 50000 };
  let winner;
  f.DB.beforeRead = async stmt => {
    if (/SELECT version FROM schedule_revision/.test(stmt.sql)) {
      f.DB.beforeRead = null;
      winner = await app.createHold(f.env, s, f.player, input, NOW);
    }
  };
  const result = await app.createHold(f.env, s, f.player, input, NOW);
  assert.equal(result.id, winner.id);
  assert.equal(f.DB.count('credit_transactions', "kind='redeem'"), 1);
});

test('console creation effects and audit are atomic and replayable', async t => {
  const f = fixture(t);
  const s = await settings(f);
  const input = { ...request, rate: 'member', payment: 'on_site', bookerName: 'Test Booker', requestIp: '127.0.0.1' };
  failOn(f, /INSERT INTO messages/);
  await assert.rejects(app.createConsoleBooking(f.env, s, f.staff, input, NOW), /Injected/);
  assert.equal(f.DB.count('bookings'), 0);
  f.DB.beforeExecute = null;
  const b = await app.createConsoleBooking(f.env, s, f.staff, input, NOW);
  const replay = await app.createConsoleBooking(f.env, s, f.staff, input, NOW);
  assert.equal(replay.id, b.id);
  assert.equal(f.DB.count('audit_log', "action='booking_created_on_site'"), 1);
});

for (const kind of ['expiry', 'warning', 'completion']) {
  const transition = async (f, s) => kind === 'expiry' ? app.sweepExpired(f.env, NOW) : kind === 'warning' ? app.warnExpiringHolds(f.env, s, NOW) : app.completePast(f.env, NOW);
  const prepare = f => {
    seedBooking(f.DB, kind === 'completion' ? 'CONFIRMED' : 'TEMPORARY');
    f.DB.sqlite.exec(kind === 'completion' ? "UPDATE bookings SET date='2026-10-06'" : `UPDATE bookings SET hold_expires_at=${NOW + (kind === 'warning' ? 60000 : -1)}`);
  };
  test(`${kind} effect failure leaves transition eligible for retry`, async t => {
    const f = fixture(t);
    const s = await settings(f);
    prepare(f);
    f.DB.beforeExecute = stmt => {
      const target = kind === 'warning' ? /INSERT INTO notifications/.test(stmt.sql)
        : /INSERT INTO booking_events/.test(stmt.sql) && stmt.args[1] === (kind === 'expiry' ? 'expired' : 'completed');
      if (target) throw Error('Injected database failure');
    };
    await assert.rejects(transition(f, s), /Injected/);
    assert.equal(f.DB.one('SELECT status FROM bookings').status, kind === 'completion' ? 'CONFIRMED' : 'TEMPORARY');
    assert.equal(f.DB.one('SELECT warned_at FROM bookings').warned_at, null);
    f.DB.beforeExecute = null;
    assert.equal(await transition(f, s), 1);
    assert.equal(await transition(f, s), 0);
  });
  test(`${kind} overlapping maintenance writes effects once`, async t => {
    const f = fixture(t);
    const s = await settings(f);
    prepare(f);
    assert.equal((await Promise.all([transition(f, s), transition(f, s)])).reduce((a, b) => a + b), 1);
    assert.equal(f.DB.count(kind === 'warning' ? 'notifications' : 'booking_events'), kind === 'warning' ? 2 : 1);
  });
  test(`${kind} committed response loss leaves a complete checkpoint without duplicate retry effects`, async t => {
    const f = fixture(t);
    const s = await settings(f);
    prepare(f);
    f.DB.afterCommit = () => { f.DB.afterCommit = null; throw Error('Lost maintenance response'); };
    await assert.rejects(transition(f, s), /Lost maintenance response/);
    assert.equal(await transition(f, s), 0);
    assert.equal(f.DB.count(kind === 'warning' ? 'notifications' : 'booking_events'), kind === 'warning' ? 2 : 1);
  });
  test(`${kind} catches up 50 records in bounded passes`, async t => {
    const f = fixture(t);
    const s = await settings(f);
    prepare(f);
    const source = f.DB.one('SELECT * FROM bookings');
    const columns = Object.keys(source);
    const insert = f.DB.sqlite.prepare(`INSERT INTO bookings (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    for (let n = 1; n < 50; n++) insert.run(...columns.map(k => k === 'id' ? `batch_${n}` : k === 'ref' ? `BATCH-${n}` : k === 'start_min' ? n : k === 'end_min' ? n + 1 : source[k]));
    let total = 0;
    for (let n = 0; n < 10; n++) {
      const changed = await transition(f, s);
      assert.ok(changed <= 8, `one pass changed ${changed}, expected <=8`);
      total += changed;
      if (!changed) break;
    }
    assert.equal(total, 50);
    assert.equal(f.DB.count(kind === 'warning' ? 'notifications' : 'booking_events'), kind === 'warning' ? 100 : 50);
  });
}

for (const table of ['bookings', 'booking_slots', 'credit_transactions', 'booking_events', 'messages', 'notifications', 'outbox', 'booking_operations']) {
  test(`credit-funded creation rolls back when ${table} write fails`, async t => {
    const f = fixture(t);
    await credit(f);
    const s = await settings(f);
    failOn(f, new RegExp(`INSERT INTO ${table}\\b`));
    await assert.rejects(app.createHold(f.env, s, f.player, { ...request, useCredit: true, expectedCredit: 50000 }, NOW), /Injected/);
    assert.equal(f.DB.count('bookings'), 0);
    assert.equal(f.DB.count('credit_transactions', "kind='redeem'"), 0);
    assert.equal(f.DB.one('SELECT remaining FROM booking_credits').remaining, 50000);
  });
}

test('failed expiry effects restore partially spent credit only on successful retry', async t => {
  const f = fixture(t);
  await credit(f);
  const s = await settings(f);
  f.DB.sqlite.exec("UPDATE resources SET price_member=60000 WHERE id='court-1'");
  const b = await app.createHold(f.env, s, f.player, { ...request, useCredit: true, expectedCredit: 50000 }, NOW);
  f.DB.beforeExecute = stmt => { if (/INSERT INTO booking_events/.test(stmt.sql) && stmt.args[1] === 'expired') throw Error('Injected expiry failure'); };
  await assert.rejects(app.sweepExpired(f.env, NOW + 86400000), /Injected/);
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits').remaining, 0);
  assert.equal(f.DB.one('SELECT status FROM bookings WHERE id=?', b.id).status, 'TEMPORARY');
  f.DB.beforeExecute = null;
  await app.sweepExpired(f.env, NOW + 86400000);
  await app.sweepExpired(f.env, NOW + 86400000);
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits').remaining, 50000);
  assert.equal(f.DB.count('credit_transactions', "kind='release'"), 1);
});

test('creation API rejects missing/invalid keys and replays a valid keyed request', async t => {
  const f = fixture(t);
  const api = new Hono();
  const error = (e, c) => c.json({ code: e.code }, e.status ?? 500);
  api.onError(error); app.bookingRoutes.onError(error); app.operationsRoutes.onError(error);
  api.use('*', async (c, next) => { c.set('user', c.req.path.startsWith('/ops') ? f.staff : f.player); await next(); });
  api.route('/bookings', app.bookingRoutes); api.route('/ops', app.operationsRoutes);
  for (const url of ['/bookings', '/ops/bookings']) {
    const body = url.startsWith('/ops') ? { ...hold, rate: 'member', payment: 'none', bookerName: 'Test Booker' } : hold;
    for (const key of [null, 'bad!']) {
      const r = await api.request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } }, f.env);
      assert.equal(r.status, 422);
    }
  }
  const options = { method: 'POST', body: JSON.stringify(hold), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'route-retry-001' } };
  const first = await api.request('/bookings', options, f.env);
  assert.equal(first.status, 201);
  const firstId = (await first.json()).booking.id;
  const second = await api.request('/bookings', options, f.env);
  assert.equal(second.status, 201);
  assert.equal((await second.json()).booking.id, firstId);
  assert.equal(f.DB.count('bookings'), 1);
});

test('deferred item closure and staff notice resolution roll back together', async t => {
  const f = fixture(t);
  seedBooking(f.DB, 'EXPIRED');
  f.DB.sqlite.prepare(`INSERT INTO disruptions(id,kind,category,reason,created_by,idempotency_key,request_hash,created_at)
    VALUES('test_disruption','bookings','weather','Test rain','test_staff','test-disruption-key','test',?)`).run(NOW);
  f.DB.sqlite.prepare(`INSERT INTO disruption_items(disruption_id,booking_id,user_id,planned_action,outcome,status_before,version_before,booked_min,affected_min,affected_segments,paid_value,where_label,created_at)
    VALUES('test_disruption','test_booking','test_player','defer','deferred','TEMPORARY',0,60,60,'[[600,660]]',50000,'Test Court',?)`).run(NOW);
  f.DB.sqlite.prepare(`INSERT INTO notifications(id,audience,type,title,body,link,created_at)
    VALUES('test_notice','staff','disruption','Rain','Rain','/admin/disruptions/test_disruption',?)`).run(NOW);
  failOn(f, /UPDATE notifications/);
  await assert.rejects(app.closeUnpaidDeferred(f.env, NOW), /Injected/);
  assert.equal(f.DB.one('SELECT outcome FROM disruption_items').outcome, 'deferred');
  f.DB.beforeExecute = null;
  assert.equal(await app.closeUnpaidDeferred(f.env, NOW), 1);
  assert.equal(await app.closeUnpaidDeferred(f.env, NOW), 0);
  assert.equal(f.DB.one("SELECT resolved_at FROM notifications WHERE id='test_notice'").resolved_at, NOW);
});

test('credit reconciliation catches up 12 ended holds without exceeding eight per pass', async t => {
  const f = fixture(t);
  seedBooking(f.DB, 'EXPIRED');
  const sample = f.DB.one('SELECT * FROM bookings');
  const columns = Object.keys(sample);
  const insert = f.DB.sqlite.prepare(`INSERT INTO bookings (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (let n = 0; n < 12; n++) {
    const bookingId = n ? `ended_${n}` : 'test_booking';
    if (n) insert.run(...columns.map(k => k === 'id' ? bookingId : k === 'ref' ? `ENDED-${n}` : sample[k]));
    const creditId = `credit_${n}`;
    f.DB.sqlite.prepare(`INSERT INTO booking_credits(id,user_id,origin,amount,remaining,reason,created_at,updated_at)
      VALUES(?,'test_player','manual',100,0,'Test credit',?,?)`).run(creditId, NOW, NOW);
    f.DB.sqlite.prepare(`INSERT INTO credit_transactions(id,credit_id,user_id,kind,amount,actor_role,created_at)
      VALUES(?,?,'test_player','issue',100,'staff',?)`).run(`issue_${n}`, creditId, NOW);
    f.DB.sqlite.prepare(`INSERT INTO credit_transactions(id,credit_id,user_id,kind,amount,booking_id,actor_role,created_at)
      VALUES(?,?,'test_player','redeem',-100,?,'player',?)`).run(`redeem_${n}`, creditId, bookingId, NOW);
  }
  assert.equal(await app.reconcileCreditHolds(f.env, NOW), 8);
  assert.equal(await app.reconcileCreditHolds(f.env, NOW), 4);
  assert.equal(await app.reconcileCreditHolds(f.env, NOW), 0);
  assert.equal(f.DB.one('SELECT SUM(remaining) AS amount FROM booking_credits').amount, 1200);
  assert.equal(f.DB.count('booking_events', "type='credit_restored'"), 12);
  assert.equal(f.DB.count('notifications', "type='credit_restored'"), 12);
});

test('housekeeping deletes at most 250 expired sessions and rate limits per hourly pass', async t => {
  const f = fixture(t);
  const versioned=f.DB.rows('PRAGMA table_info(sessions)').some(column=>column.name==='auth_version');
  for (let n = 0; n < 600; n++) {
    f.DB.sqlite.prepare(versioned
      ? 'INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at,auth_version) SELECT ?,?,?,?, ?,auth_version FROM users WHERE id=\'test_player\''
      : 'INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)')
      .run(`session_${n}`, f.player.id, NOW - 1, NOW - 1, NOW - 1);
    f.DB.sqlite.prepare('INSERT INTO rate_limits(key,count,window_start) VALUES(?,1,?)').run(`counter_${n}`, NOW - 86400001);
  }
  const report = await app.runMaintenance(f.env, NOW, { cron: true });
  assert.equal(report.housekeeping, 'ok');
  assert.equal(f.DB.count('sessions'), 350);
  assert.equal(f.DB.count('rate_limits'), 350);
});
