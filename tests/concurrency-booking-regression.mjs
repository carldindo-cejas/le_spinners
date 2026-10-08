// Application SQL against transactional SQLite with deliberately aligned concurrent
// promises. The HTTP/workerd capacity harness supplies separate runtime evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, NOW, TOMORROW, hold } from './helpers/readiness.mjs';

function players(f, count) {
  return Array.from({ length: count }, (_, i) => {
    const id = `concurrency-player-${i}`;
    f.DB.sqlite.prepare('INSERT INTO users(id,email,name,password_hash,role,membership,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, `${id}@example.invalid`, id, '', 'player', 'member', NOW, NOW);
    return { ...f.DB.one('SELECT * FROM users WHERE id=?', id), session_id: 'synthetic-session' };
  });
}

function alignBookingCommits(f, count) {
  let arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.DB.beforeWrite = async statements => {
    if (!statements.some(statement => statement.sql.includes('INSERT INTO bookings'))) return;
    if (++arrived === count) { f.DB.beforeWrite = null; release(); }
    await barrier;
  };
}

for (const count of [10, 15, 20, 50]) test(`${count} simultaneous different-slot holds all commit`, async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB), users = players(f, count);
  const resources = f.DB.rows('SELECT id FROM resources ORDER BY id');
  alignBookingCommits(f, count);
  const results = await Promise.allSettled(users.map((user, i) => app.createHold(f.env, settings, user, {
    resourceId: resources[i % resources.length].id, date: TOMORROW,
    starts: [Math.floor(i / resources.length) * settings.slotMinutes], idempotencyKey: `different-slot-${i}`,
  }, NOW)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, count, JSON.stringify(results.filter(r => r.status === 'rejected').map(r => r.reason.code)));
  assert.equal(f.DB.count('bookings'), count);
  assert.equal(f.DB.count('booking_operations'), count);
  assert.equal(f.DB.count('booking_events', "type='created'"), count);
});

test('20 same-slot requests have one winner and predictable slot conflicts', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  alignBookingCommits(f, 20);
  const results = await Promise.allSettled(players(f, 20).map((user, i) => app.createHold(f.env, settings, user, {
    ...hold, idempotencyKey: `same-slot-${i}`,
  }, NOW)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const result of results.filter(r => r.status === 'rejected')) assert.equal(result.reason.code, 'SLOT_TAKEN');
  assert.equal(f.DB.count('booking_slots'), 1);
  assert.equal(f.DB.count('booking_events'), 1);
});

test('different-slot requests still enforce the per-player hold cap atomically', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  alignBookingCommits(f, 10);
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => app.createHold(f.env, settings, f.player, {
    ...hold, starts: [i * settings.slotMinutes], idempotencyKey: `hold-cap-${i}`,
  }, NOW)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  for (const result of results.filter(r => r.status === 'rejected')) assert.equal(result.reason.code, 'TOO_MANY_HOLDS');
  assert.equal(f.DB.count('bookings'), 2);
});

test('20 duplicate booking requests replay one booking and effect set', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  alignBookingCommits(f, 20);
  const results = await Promise.all(Array.from({ length: 20 }, () => app.createHold(f.env, settings, f.player, {
    ...hold, idempotencyKey: 'same-request-001',
  }, NOW)));
  assert.equal(new Set(results.map(b => b.id)).size, 1);
  assert.equal(f.DB.count('bookings'), 1);
  assert.equal(f.DB.count('booking_operations'), 1);
  assert.equal(f.DB.count('booking_events'), 1);
  assert.equal(f.DB.count('messages'), 1);
  assert.equal(f.DB.count('notifications'), 2);
});

test('manual credit duplicate requests replay one credit and complete effects', async t => {
  const f = fixture(t);
  const input = { userId: f.player.id, amount: 50000, reason: 'Synthetic credit', sourceBookingId: null, idempotencyKey: 'duplicate-credit-001' };
  const ids = await Promise.all(Array.from({ length: 10 }, () => app.issueManualCredit(f.env, f.admin, input, NOW)));
  assert.equal(new Set(ids).size, 1);
  assert.equal(f.DB.count('booking_credits'), 1);
  assert.equal(f.DB.count('credit_transactions'), 1);
  assert.equal(f.DB.count('notifications'), 1);
  assert.equal(f.DB.count('outbox'), 1);
  assert.equal(f.DB.count('audit_log'), 1);
});

test('manual credit identity rejects changes to reason, source booking or actor', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  const booking = await app.createHold(f.env, settings, f.player, hold, NOW);
  const input = { userId: f.player.id, amount: 50000, reason: 'Original reason', sourceBookingId: null, idempotencyKey: 'changed-credit-001' };
  await app.issueManualCredit(f.env, f.admin, input, NOW);
  for (const change of [{ reason: 'Changed reason' }, { sourceBookingId: booking.id }]) {
    await assert.rejects(app.issueManualCredit(f.env, f.admin, { ...input, ...change }, NOW), { code: 'IDEMPOTENCY_KEY_REUSED' });
  }
  await assert.rejects(app.issueManualCredit(f.env, { ...f.staff, role: 'admin' }, input, NOW), { code: 'IDEMPOTENCY_KEY_REUSED' });
  assert.equal(f.DB.count('booking_credits'), 1);
});

test('10 stale credit plans cannot overspend or leave refused booking effects', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  const creditId = await app.issueManualCredit(f.env, f.admin, { userId: f.player.id, amount: 50000,
    reason: 'Synthetic credit', sourceBookingId: null, idempotencyKey: 'overspend-credit-001' }, NOW);
  f.DB.sqlite.exec("UPDATE resources SET price_member=60000 WHERE id='court-1'");
  alignBookingCommits(f, 10);
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => app.createHold(f.env, settings, f.player, {
    ...hold, starts: [i * settings.slotMinutes], useCredit: true, expectedCredit: 50000, idempotencyKey: `credit-plan-${i}`,
  }, NOW)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const result of results.filter(r => r.status === 'rejected')) assert.equal(result.reason.code, 'CREDIT_CHANGED');
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits WHERE id=?', creditId).remaining, 0);
  assert.equal(f.DB.count('credit_transactions', "kind='redeem'"), 1);
  assert.equal(f.DB.count('bookings'), 1);
  assert.equal(f.DB.count('booking_slots'), 1);
  assert.equal(f.DB.count('booking_operations'), 1);
});

test('an unrelated cron expiry does not invalidate a prevalidated free slot', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  const old = await app.createHold(f.env, settings, f.other, { ...hold, starts: [720], idempotencyKey: 'expiry-old-001' }, NOW);
  f.DB.sqlite.prepare('UPDATE bookings SET hold_expires_at=? WHERE id=?').run(NOW - 1, old.id);
  f.DB.beforeWrite = async statements => {
    if (!statements.some(statement => statement.sql.includes('INSERT INTO bookings'))) return;
    f.DB.beforeWrite = null;
    await app.sweepExpired(f.env, NOW);
  };
  const booked = await app.createHold(f.env, settings, f.player, { ...hold, resourceId: 'table-1', idempotencyKey: 'expiry-new-001' }, NOW);
  assert.equal(booked.status, 'TEMPORARY');
  assert.equal(f.DB.one('SELECT status FROM bookings WHERE id=?', old.id).status, 'EXPIRED');
  assert.equal(f.DB.count('booking_events', "type='expired'"), 1);
});

test('overlapping expiry passes cannot expire the new winner or duplicate old effects', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  const old = await app.createHold(f.env, settings, f.player, { ...hold, idempotencyKey: 'expiry-race-old' }, NOW);
  f.DB.sqlite.prepare('UPDATE bookings SET hold_expires_at=? WHERE id=?').run(NOW - 1, old.id);
  const users = players(f, 10);
  const results = await Promise.allSettled([
    ...users.map((user, i) => app.createHold(f.env, settings, user, { ...hold, idempotencyKey: `expiry-race-new-${i}` }, NOW)),
    ...Array.from({ length: 10 }, () => app.sweepExpired(f.env, NOW)),
  ]);
  const winners = results.slice(0, 10).filter(r => r.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(f.DB.one('SELECT status FROM bookings WHERE id=?', winners[0].value.id).status, 'TEMPORARY');
  assert.equal(f.DB.one('SELECT status FROM bookings WHERE id=?', old.id).status, 'EXPIRED');
  assert.equal(f.DB.count('booking_events', "type='expired'"), 1);
  assert.equal(f.DB.count('booking_events', "type='created'"), 2);
});

test('atomic overlap checks preserve gaps and reject another resource on the same player', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  await app.createHold(f.env, settings, f.player, { ...hold, starts: [600, 720], idempotencyKey: 'gaps-001' }, NOW);
  const gap = await app.createHold(f.env, settings, f.other, { ...hold, starts: [660], idempotencyKey: 'gaps-002' }, NOW);
  assert.equal(gap.start_min, 660);
  await assert.rejects(app.createHold(f.env, settings, f.other, { ...hold, starts: [720], idempotencyKey: 'gaps-003' }, NOW), { code: 'SLOT_TAKEN' });
  await assert.rejects(app.createHold(f.env, settings, f.player, { ...hold, resourceId: 'table-1', idempotencyKey: 'gaps-004' }, NOW), { code: 'OVERLAP_OWN' });
  assert.equal(f.DB.count('bookings'), 2);
});

test('manual credit failure rolls back effects and committed response loss replays', async t => {
  const f = fixture(t);
  const input = { userId: f.player.id, amount: 50000, reason: 'Synthetic credit', sourceBookingId: null, idempotencyKey: 'credit-recovery-001' };
  f.DB.beforeExecute = statement => {
    if (statement.sql.includes('INSERT INTO notifications')) throw new Error('Synthetic effect failure');
  };
  await assert.rejects(app.issueManualCredit(f.env, f.admin, input, NOW), /Synthetic effect failure/);
  assert.equal(f.DB.count('booking_credits'), 0);
  assert.equal(f.DB.count('credit_transactions'), 0);
  f.DB.beforeExecute = null;
  f.DB.afterCommit = statements => {
    if (statements.some(statement => statement.sql.includes('INSERT INTO booking_credits'))) {
      f.DB.afterCommit = null;
      throw new Error('Synthetic response loss');
    }
  };
  const id = await app.issueManualCredit(f.env, f.admin, input, NOW);
  assert.equal(await app.issueManualCredit(f.env, f.admin, input, NOW), id);
  assert.equal(f.DB.count('booking_credits'), 1);
  assert.equal(f.DB.count('credit_transactions'), 1);
  assert.equal(f.DB.count('notifications'), 1);
  assert.equal(f.DB.count('outbox'), 1);
});

test('bounded expiry cleanup prioritizes the exact slot requested behind a backlog', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  const users = players(f, 12);
  const insert = f.DB.sqlite.prepare('INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,hold_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  users.forEach((user, i) => insert.run(`backlog-${i}`, `BACKLOG-${i}`, user.id, 'court-1', TOMORROW,
    i * 60, (i + 1) * 60, 'TEMPORARY', 50000, 'member', NOW - 12000 + i, NOW - 60000, NOW - 60000));
  const booked = await app.createHold(f.env, settings, f.player, { ...hold, starts: [660], idempotencyKey: 'backlog-new-001' }, NOW);
  assert.equal(booked.status, 'TEMPORARY');
  assert.equal(f.DB.one("SELECT status FROM bookings WHERE id='backlog-11'").status, 'EXPIRED');
  assert.equal(f.DB.count('bookings', "status='EXPIRED'"), 8, 'The cleanup bound remains in force');
  assert.equal(f.DB.count('booking_events', "type='expired'"), 8);
});

test('booking HTTP replay remains successful after the new-hold rate budget is exhausted', async t => {
  const f = fixture(t), api = new Hono();
  api.use('*', async (c, next) => { c.set('user', f.player); await next(); });
  const error = (error, c) => c.json({ error: { code: error.code, message: error.message } }, error.status ?? 500);
  api.onError(error); app.bookingRoutes.onError(error);
  api.route('/bookings', app.bookingRoutes);
  const request = (key, body = hold) => api.request('/bookings', { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } }, f.env);
  const first = await request('limited-replay-001');
  assert.equal(first.status, 201);
  const id = (await first.json()).booking.id;
  f.DB.sqlite.prepare('UPDATE rate_limits SET count=20 WHERE key=?').run(`hold:user:${f.player.id}`);
  const replay = await request('limited-replay-001');
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).booking.id, id);
  assert.equal(f.DB.one('SELECT count FROM rate_limits WHERE key=?', `hold:user:${f.player.id}`).count, 20);
  const changed = await request('limited-replay-001', { ...hold, starts: [660] });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
  const newAttempt = await request('limited-replay-002', { ...hold, starts: [660] });
  assert.equal(newAttempt.status, 429);
  assert.equal(f.DB.count('bookings'), 1);
});

test('daily booking references keep increasing beyond 999 historical attempts', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  const insert = f.DB.sqlite.prepare('INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const sequence of [999, 1000]) insert.run(`reference-${sequence}`, `LS-20261008-${sequence}`, f.other.id,
    'court-1', TOMORROW, 600, 660, 'EXPIRED', 50000, 'member', NOW - 60000, NOW - 60000);
  const booking = await app.createHold(f.env, settings, f.player, { ...hold, idempotencyKey: 'reference-next-001' }, NOW);
  assert.equal(booking.ref, 'LS-20261008-1001');
});
