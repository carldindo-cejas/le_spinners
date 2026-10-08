// Real application functions and SQL against transactional SQLite. Workerd/D1
// runtime coverage is provided separately; this harness does not model quotas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, hold, proofFile, NOW, TOMORROW } from './helpers/readiness.mjs';

function seed(f, { id = 'existing', userId = f.player.id, resourceId = 'court-1', status = 'CONFIRMED',
  starts = [600], duration = 60, deadline = NOW + 600000, date = TOMORROW, legacy = false } = {}) {
  f.DB.sqlite.prepare(`INSERT INTO bookings
    (id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,hold_expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, `REF-${id}`, userId, resourceId, date,
    Math.min(...starts), Math.max(...starts) + duration, status, 50000, 'member', deadline, NOW, NOW);
  if (!legacy) for (const start of starts) f.DB.sqlite.prepare(`INSERT INTO booking_slots
    (booking_id,resource_id,date,start_min,end_min) VALUES(?,?,?,?,?)`).run(id, resourceId, date, start, start + duration);
  return id;
}

function apiFor(f, user = f.player) {
  const api = new Hono();
  const error = (e, c) => c.json({ error: { code: e.code ?? 'INTERNAL', message: e.status ? e.message : 'Unable to complete the request.' } }, e.status ?? 500);
  api.onError(error); app.bookingRoutes.onError(error); app.facilityRoutes.onError(error);
  api.use('*', async (c, next) => { c.set('user', user); await next(); });
  api.route('/api/bookings', app.bookingRoutes); api.route('/api', app.facilityRoutes);
  return api;
}

async function overlaps(f, changes = {}) {
  const settings = await app.loadSettings(f.DB);
  return app.personalOverlaps(f.DB, f.player.id, { ...hold, resourceId: 'court-2', ...changes }, settings.slotMinutes, NOW);
}

function alignInserts(f, count) {
  let arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.DB.beforeWrite = async statements => {
    if (!statements.some(s => s.sql.includes('INSERT INTO bookings'))) return;
    if (++arrived === count) { f.DB.beforeWrite = null; release(); }
    await barrier;
  };
}

test('one player can reserve two courts and two tables at exactly the same time', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB), ids = [];
  for (const resourceId of ['court-1', 'court-2', 'table-1', 'table-2']) {
    const booking = await app.createHold(f.env, settings, f.player, { ...hold, resourceId, idempotencyKey: `four-facilities-${resourceId}` }, NOW);
    ids.push(booking.id);
    // A submitted payment exits the existing two-unpaid-hold cap without
    // releasing occupancy. Four simultaneous unpaid holds remain forbidden.
    await app.submitProof(f.env, settings, f.player, booking.id, proofFile(), { gcashRef: null, amount: booking.amount_due }, NOW);
  }
  assert.equal(new Set(ids).size, 4);
  assert.equal(f.DB.count('bookings', "status='PAYMENT_SUBMITTED'"), 4);
  assert.equal(f.DB.count('booking_slots'), 4);
  assert.equal((await overlaps(f, { resourceId: 'court-3' })).length, 4);
});

test('different-facility bookings permit partial overlap and produce a warning', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  const first = await app.createHold(f.env, settings, f.player, { ...hold, starts: [600, 660], idempotencyKey: 'partial-first' }, NOW);
  const second = await app.createHold(f.env, settings, f.player, { ...hold, resourceId: 'table-1', starts: [660, 720], idempotencyKey: 'partial-second' }, NOW);
  const warnings = await overlaps(f, { resourceId: 'table-1', starts: [660, 720] });
  assert.deepEqual(warnings.map(w => w.id), [first.id]);
  assert.equal(warnings[0].resourceId, 'court-1');
  assert.equal(warnings[0].status, 'TEMPORARY');
  assert.notEqual(first.id, second.id);
});

for (const status of ['TEMPORARY', 'REJECTED', 'PAYMENT_SUBMITTED', 'CONFIRMED']) {
  test(`${status} personal booking triggers an advisory warning on another resource`, async t => {
    const f = fixture(t); seed(f, { status });
    const warnings = await overlaps(f);
    assert.equal(warnings.length, 1); assert.equal(warnings[0].id, 'existing');
    assert.equal(warnings[0].date, TOMORROW); assert.equal(warnings[0].status, status);
    assert.deepEqual(warnings[0].segments, [{ start: 600, end: 660 }]);
    const booking = await app.createHold(f.env, await app.loadSettings(f.DB), f.player, { ...hold, resourceId: 'court-2' }, NOW);
    assert.equal(booking.status, 'TEMPORARY');
  });
}

for (const data of [
  { status: 'CANCELLED' }, { status: 'EXPIRED' }, { status: 'COMPLETED' },
  { status: 'TEMPORARY', deadline: NOW }, { status: 'REJECTED', deadline: NOW - 1 },
]) test(`${data.status} ${data.deadline != null ? 'elapsed hold ' : ''}does not warn or occupy inventory`, async t => {
  const f = fixture(t); seed(f, data);
  assert.deepEqual(await overlaps(f), []);
  const booking = await app.createHold(f.env, await app.loadSettings(f.DB), f.player, hold, NOW);
  assert.equal(booking.status, 'TEMPORARY');
});

test('warning excludes other users, same facility, other dates and adjacent times', async t => {
  const f = fixture(t);
  seed(f, { id: 'same-resource', resourceId: 'court-2' });
  seed(f, { id: 'other-player', resourceId: 'table-1', userId: f.other.id });
  seed(f, { id: 'other-date', resourceId: 'court-1', date: app.addDays(TOMORROW, 1) });
  seed(f, { id: 'adjacent-before', resourceId: 'table-2', starts: [540] });
  seed(f, { id: 'adjacent-after', resourceId: 'court-3', starts: [660] });
  assert.deepEqual(await overlaps(f), []);
});

test('warning checks actual booking segments and skips gaps in either selection', async t => {
  const f = fixture(t);
  seed(f, { starts: [600, 720] });
  assert.deepEqual(await overlaps(f, { starts: [660] }), []);
  assert.equal((await overlaps(f, { starts: [600, 720] })).length, 1);
  assert.equal((await overlaps(f, { starts: [720] })).length, 1);
  assert.deepEqual(await overlaps(f, { starts: [540, 660, 780] }), []);
});

test('warning lookup uses indexed player/day and booking-slot identities', async t => {
  const f = fixture(t); seed(f);
  let warningQuery;
  f.DB.beforeExecute = statement => {
    if (statement.sql.includes('b.resource_id != ?2')) warningQuery = statement;
  };
  assert.equal((await overlaps(f)).length, 1);
  f.DB.beforeExecute = null;
  assert.ok(warningQuery);
  const { results: plan } = await f.DB.prepare(`EXPLAIN QUERY PLAN ${warningQuery.sql}`).bind(...warningQuery.args).all();
  assert.ok(plan.some(row => /SEARCH b USING INDEX .*\(user_id=\? AND date=\?\)/.test(row.detail)), JSON.stringify(plan));
  assert.ok(plan.some(row => /SEARCH .* USING (?:COVERING )?INDEX .*\(booking_id=\?/.test(row.detail)), JSON.stringify(plan));
});

test('legacy booking spans still warn on a genuine partial overlap', async t => {
  const f = fixture(t); seed(f, { starts: [630], duration: 60, legacy: true });
  assert.equal((await overlaps(f, { starts: [600] })).length, 1);
  assert.equal((await overlaps(f, { starts: [660] })).length, 1);
  assert.deepEqual(await overlaps(f, { starts: [720] }), []);
});

for (const sameUser of [false, true]) test(`simultaneous ${sameUser ? 'same-player' : 'different-player'} same-facility requests have one winner`, async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB), count = sameUser ? 10 : 2;
  alignInserts(f, count);
  const results = await Promise.allSettled(Array.from({ length: count }, (_, i) => app.createHold(f.env, settings,
    sameUser || i === 0 ? f.player : f.other, { ...hold, idempotencyKey: `same-resource-race-${i}` }, NOW)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const failure of results.filter(r => r.status === 'rejected')) assert.equal(failure.reason.code, 'SLOT_TAKEN');
  assert.equal(f.DB.count('bookings'), 1); assert.equal(f.DB.count('booking_slots'), 1);
  assert.equal(f.DB.count('booking_operations'), 1); assert.equal(f.DB.count('booking_events'), 1);
});

test('simultaneous same-player different-facility requests both commit', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB); alignInserts(f, 2);
  const results = await Promise.all(['court-1', 'table-1'].map(resourceId => app.createHold(f.env, settings, f.player,
    { ...hold, resourceId, idempotencyKey: `different-resource-race-${resourceId}` }, NOW)));
  assert.equal(new Set(results.map(b => b.id)).size, 2); assert.equal(f.DB.count('booking_slots'), 2);
});

test('cross-facility allowance preserves the atomic unpaid-hold cap', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB), resources = ['court-1', 'court-2', 'court-3', 'table-1', 'table-2'];
  alignInserts(f, resources.length);
  const results = await Promise.allSettled(resources.map(resourceId => app.createHold(f.env, settings, f.player,
    { ...hold, resourceId, idempotencyKey: `cross-resource-cap-${resourceId}` }, NOW)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  for (const failure of results.filter(r => r.status === 'rejected')) assert.equal(failure.reason.code, 'TOO_MANY_HOLDS');
  assert.equal(f.DB.count('bookings'), 2); assert.equal(f.DB.count('booking_slots'), 2);
});

test('same-facility conflict is reported before the unpaid-hold cap', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  await app.createHold(f.env, settings, f.player, hold, NOW);
  await app.createHold(f.env, settings, f.player, { ...hold, resourceId: 'court-2' }, NOW);
  await assert.rejects(app.createHold(f.env, settings, f.player, hold, NOW), { code: 'SLOT_TAKEN' });
  assert.equal(f.DB.count('bookings'), 2);
});

test('same facility keeps selected gaps free and rejects overlapping legacy spans', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  seed(f, { starts: [600, 720] });
  const gap = await app.createHold(f.env, settings, f.player, { ...hold, starts: [660] }, NOW);
  assert.equal(gap.start_min, 660);
  await assert.rejects(app.createHold(f.env, settings, f.other, { ...hold, starts: [720] }, NOW), { code: 'SLOT_TAKEN' });
  seed(f, { id: 'legacy', resourceId: 'court-2', starts: [630], legacy: true });
  await assert.rejects(app.createHold(f.env, settings, f.other, { ...hold, resourceId: 'court-2', starts: [600] }, NOW), { code: 'SLOT_TAKEN' });
});

test('availability shows only the occupied resource as mine and keeps other facilities selectable', async t => {
  const f = fixture(t); seed(f); const api = apiFor(f);
  const response = await api.request(`/api/availability?activity=pickleball&date=${TOMORROW}`, {}, f.env);
  assert.equal(response.status, 200); const day = await response.json();
  const state = id => day.resources.find(r => r.id === id).slots.find(s => s.start === 600).state;
  assert.equal(state('court-1'), 'mine'); assert.equal(state('court-2'), 'available');
  const other = await apiFor(f, f.other).request(`/api/availability?activity=pickleball&date=${TOMORROW}`, {}, f.env);
  const occupied = (await other.json()).resources.find(r => r.id === 'court-1').slots.find(s => s.start === 600);
  assert.equal(occupied.state, 'booked'); assert.equal(occupied.booking, undefined);
});

test('quote includes advisory overlaps without mutating holds, slots or credits', async t => {
  const f = fixture(t); seed(f); const api = apiFor(f);
  const response = await api.request(`/api/bookings/quote?resourceId=court-2&date=${TOMORROW}&starts=600`, {}, f.env);
  assert.equal(response.status, 200); const quote = await response.json();
  assert.equal(quote.personalOverlaps.length, 1); assert.equal(quote.personalOverlaps[0].id, 'existing');
  assert.equal(quote.amountDue, quote.price); assert.equal(quote.creditApplied, 0);
  assert.equal(f.DB.count('bookings'), 1); assert.equal(f.DB.count('booking_slots'), 1);
  assert.equal(f.DB.count('credit_transactions'), 0);
  const legacy = await api.request('/api/bookings/quote?resourceId=court-2&starts=600', {}, f.env);
  assert.equal(legacy.status, 200); assert.deepEqual((await legacy.json()).personalOverlaps, []);
  const noOverlap = await api.request(`/api/bookings/quote?resourceId=court-2&date=${TOMORROW}&starts=660`, {}, f.env);
  assert.deepEqual((await noOverlap.json()).personalOverlaps, []);
});

test('quote rejects malformed input and unauthorized access before disclosing bookings', async t => {
  const f = fixture(t); seed(f); const api = apiFor(f);
  for (const query of ['date=2026-11-31&starts=600', `date=${TOMORROW}&starts=1500`, `date=${TOMORROW}&starts=nope`]) {
    const response = await api.request(`/api/bookings/quote?resourceId=court-2&${query}`, {}, f.env);
    assert.equal(response.status, 422, query);
  }
  for (const user of [null, f.staff, f.admin]) {
    const response = await apiFor(f, user).fetch(new Request(`http://localhost/api/bookings/quote?resourceId=court-2&date=${TOMORROW}&starts=600`), f.env,
      { waitUntil(promise) { f.c.executionCtx.waitUntil(promise); }, passThroughOnException() {} });
    assert.ok([401, 403].includes(response.status));
    assert.equal((await response.json()).personalOverlaps, undefined);
  }
});

for (const [change, code] of [
  ["UPDATE resources SET status='maintenance' WHERE id='court-2'", 'MAINTENANCE'],
  ["UPDATE resources SET status='disabled' WHERE id='court-2'", 'RESOURCE_UNAVAILABLE'],
  ["UPDATE resources SET open_play=1 WHERE id='court-2'", 'OPEN_PLAY'],
  ['UPDATE opening_hours SET is_open=0', 'CLOSED'],
  ['UPDATE opening_hours SET open_min=660', 'INVALID_SLOT'],
]) test(`cross-facility allowance preserves ${code} validation`, async t => {
  const f = fixture(t); seed(f); f.DB.sqlite.exec(change);
  await assert.rejects(app.createHold(f.env, await app.loadSettings(f.DB), f.player, { ...hold, resourceId: 'court-2' }, NOW), { code });
  assert.equal(f.DB.count('bookings'), 1);
});

test('cross-facility allowance preserves closures and configuration race protection', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB); seed(f);
  f.DB.sqlite.prepare("INSERT INTO closures(id,date,resource_id,start_min,end_min,reason,created_at) VALUES('test-closure',?,'court-2',600,660,'Synthetic closure',?)").run(TOMORROW, NOW);
  await assert.rejects(app.createHold(f.env, settings, f.player, { ...hold, resourceId: 'court-2' }, NOW), { code: 'CLOSED' });
  f.DB.sqlite.exec("DELETE FROM closures WHERE id='test-closure'");
  f.DB.beforeWrite = async statements => {
    if (!statements.some(s => s.sql.includes('INSERT INTO bookings'))) return;
    f.DB.beforeWrite = null;
    f.DB.sqlite.exec("UPDATE resources SET price_member=55000 WHERE id='court-2'");
  };
  await assert.rejects(app.createHold(f.env, settings, f.player, { ...hold, resourceId: 'court-2' }, NOW), { code: 'SCHEDULE_CHANGED' });
  assert.equal(f.DB.count('bookings'), 1);
});

test('fully credit-paid overlapping facilities confirm atomically without opening unpaid holds', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  const creditId = await app.issueManualCredit(f.env, f.admin, { userId: f.player.id, amount: 500000,
    reason: 'Synthetic group credit', sourceBookingId: null, idempotencyKey: 'overlap-credit-grant' }, NOW);
  for (const resourceId of ['court-1', 'court-2', 'table-1', 'table-2']) {
    const resource = f.DB.one('SELECT price_member FROM resources WHERE id=?', resourceId);
    const booking = await app.createHold(f.env, settings, f.player, { ...hold, resourceId,
      useCredit: true, expectedCredit: resource.price_member, idempotencyKey: `overlap-credit-${resourceId}` }, NOW);
    assert.equal(booking.status, 'CONFIRMED'); assert.equal(booking.amount_due, 0);
    assert.equal(booking.credit_applied, resource.price_member); assert.equal(booking.hold_expires_at, null);
  }
  assert.equal(f.DB.count('bookings', "status='TEMPORARY'"), 0);
  assert.equal(f.DB.count('credit_transactions', "kind='redeem'"), 4);
  const spent = f.DB.one("SELECT -SUM(amount) AS n FROM credit_transactions WHERE kind='redeem'").n;
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits WHERE id=?', creditId).remaining, 500000 - spent);
});

test('failed effects roll back a cross-facility hold and response-loss retry has one effect set', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB); seed(f);
  const input = { ...hold, resourceId: 'court-2', idempotencyKey: 'overlap-response-loss' };
  f.DB.beforeExecute = s => { if (s.sql.includes('INSERT INTO notifications')) throw new Error('Synthetic effect failure'); };
  await assert.rejects(app.createHold(f.env, settings, f.player, input, NOW), /Synthetic effect failure/);
  assert.equal(f.DB.count('bookings'), 1); assert.equal(f.DB.count('booking_operations'), 0);
  assert.equal(f.DB.count('booking_events'), 0); f.DB.beforeExecute = null;
  f.DB.afterCommit = statements => {
    if (statements.some(s => s.sql.includes('INSERT INTO bookings'))) { f.DB.afterCommit = null; throw new Error('Synthetic response loss'); }
  };
  const first = await app.createHold(f.env, settings, f.player, input, NOW);
  const replay = await app.createHold(f.env, settings, f.player, input, NOW);
  assert.equal(first.id, replay.id); assert.equal(f.DB.count('bookings'), 2);
  assert.equal(f.DB.count('booking_operations'), 1); assert.equal(f.DB.count('booking_events'), 1);
  assert.equal(f.DB.count('notifications'), 2);
});
