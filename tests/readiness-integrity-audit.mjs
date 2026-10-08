import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app, fixture, hold, credit, NOW, TOMORROW, root, seedBooking } from './helpers/readiness.mjs';

const kinds = ['closure', 'maintenance', 'open_play', 'disabled', 'hours'];
function scheduleChange(f, settings, kind, confirmed = []) {
  if (kind === 'closure') return app.createClosure(f.c, f.admin, app.closureSchema.parse({
    date: TOMORROW, resourceId: 'court-1', reason: 'Synthetic closure', confirmAffected: confirmed,
  }));
  if (kind === 'hours') return app.setWeeklyHours(f.c, f.admin, app.weekdayOf(TOMORROW), settings.slotMinutes,
    app.hoursSchema.parse({ isOpen: false, open: 0, close: 1440, confirmAffected: confirmed }));
  return app.updateResource(f.c, f.admin, 'court-1', app.resourceUpdateSchema.parse({ status: kind, confirmAffected: confirmed }));
}
for (const kind of kinds) for (const writer of ['player', 'console', 'credit']) {
  const make = async (f, settings) => {
    if (writer === 'console') return app.createConsoleBooking(f.env, settings, f.staff,
      { ...hold, rate: 'member', payment: 'on_site', bookerName: 'Synthetic booker', idempotencyKey: 'audit-console-001' }, NOW);
    if (writer === 'credit') {
      await credit(f);
      f.DB.sqlite.prepare("UPDATE resources SET price_member=50000 WHERE id='court-1'").run();
    }
    return app.createHold(f.env, settings, f.player,
      { ...hold, useCredit: writer === 'credit', expectedCredit: writer === 'credit' ? 50000 : null, idempotencyKey: 'audit-player-001' }, NOW);
  };
  test(`H03 independent: ${kind} must acknowledge an existing ${writer} booking`, async t => {
    const f = fixture(t), settings = await app.loadSettings(f.DB);
    const booking = await make(f, settings);
    await assert.rejects(scheduleChange(f, settings, kind), { code: 'AFFECTS_BOOKINGS' });
    const result = await scheduleChange(f, settings, kind, [booking.id]);
    assert.deepEqual(result.affected.map(item => item.id), [booking.id]);
    assert.equal(f.DB.one('SELECT status FROM bookings WHERE id=?', booking.id).status, booking.status);
    assert.equal(f.DB.count('disruption_items'), 0, 'Ordinary change must preserve explicit follow-up semantics');
  });
  test(`H03 independent: ${kind} rolls back when ${writer} arrives between planning and commit`, async t => {
    const f = fixture(t), settings = await app.loadSettings(f.DB);
    const trigger = kind === 'closure' ? 'INSERT INTO closures' : kind === 'hours' ? 'INSERT INTO opening_hours' : 'UPDATE resources';
    let booking;
    f.DB.beforeWrite = async statements => {
      if (statements.some(stmt => stmt.sql.includes(trigger))) {
        f.DB.beforeWrite = null;
        booking = await make(f, settings);
      }
    };
    await assert.rejects(scheduleChange(f, settings, kind), { code: 'SCHEDULE_CHANGED' });
    assert.equal(f.DB.count('closures'), 0);
    assert.equal(f.DB.one("SELECT status FROM resources WHERE id='court-1'").status, 'active');
    assert.equal(f.DB.one("SELECT open_play FROM resources WHERE id='court-1'").open_play, 0);
    assert.equal(f.DB.one('SELECT is_open FROM opening_hours WHERE weekday=?', app.weekdayOf(TOMORROW)).is_open, 1);
    assert.equal(f.DB.one('SELECT status FROM bookings WHERE id=?', booking.id).status, booking.status);
  });
  test(`H03 independent: ${writer} cannot book after ${kind} commit`, async t => {
    const f = fixture(t), settings = await app.loadSettings(f.DB);
    await scheduleChange(f, settings, kind);
    await assert.rejects(make(f, settings));
    assert.equal(f.DB.count('bookings'), 0);
    assert.equal(f.DB.count('booking_slots'), 0);
    assert.equal(f.DB.count('credit_transactions', "kind='redeem'"), 0);
  });
}

test('H03 independent regression: ordinary resource planning refuses a truncated 501-booking scope', async t => {
  const f = fixture(t);
  seedBooking(f.DB, 'CONFIRMED');
  const source = f.DB.one('SELECT * FROM bookings'), columns = Object.keys(source);
  const insert = f.DB.sqlite.prepare(`INSERT INTO bookings (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  const ids = ['test_booking'];
  for (let i = 1; i <= 500; i++) {
    const id = `scope_${i}`;
    ids.push(id);
    insert.run(...columns.map(column => column === 'id' ? id : column === 'ref' ? `SCOPE-${i}` :
      column === 'date' ? app.addDays(TOMORROW, i) : source[column]));
  }
  await assert.rejects(app.updateResource(f.c, f.admin, 'court-1', app.resourceUpdateSchema.parse({
    status: 'disabled', confirmAffected: ids.slice(0, 500),
  })), { code: 'TOO_MANY_BOOKINGS' });
  assert.equal(f.DB.one("SELECT status FROM resources WHERE id='court-1'").status, 'active');
  assert.equal(f.DB.count('bookings', "status='CONFIRMED'"), 501);
});

for (const writer of ['player', 'console', 'credit']) {
  const input = app.previewSchema.parse({ scope: { kind: 'window', date: TOMORROW, start: 600, end: 660, resourceId: 'court-1' },
    category: 'maintenance', reason: 'Synthetic disruption' });
  const make = async (f, settings) => {
    if (writer === 'console') return app.createConsoleBooking(f.env, settings, f.staff,
      { ...hold, rate: 'member', payment: 'on_site', bookerName: 'Synthetic booker', idempotencyKey: 'audit-console-002' }, NOW);
    if (writer === 'credit') {
      await credit(f);
      f.DB.sqlite.prepare("UPDATE resources SET price_member=50000 WHERE id='court-1'").run();
    }
    return app.createHold(f.env, settings, f.player,
      { ...hold, useCredit: writer === 'credit', expectedCredit: writer === 'credit' ? 50000 : null, idempotencyKey: 'audit-player-002' }, NOW);
  };
  test(`H03 independent: disruption includes an existing ${writer} booking and balances its effects`, async t => {
    const f = fixture(t), settings = await app.loadSettings(f.DB), booking = await make(f, settings);
    const plan = await app.buildPlan(f.c, f.admin, input, NOW);
    assert.deepEqual(plan.items.map(item => item.booking.id), [booking.id]);
    await app.applyDisruption(f.c, f.admin, { ...input, previewToken: plan.previewToken }, 'audit-disruption-001', 'local');
    assert.equal(f.DB.one('SELECT status FROM bookings WHERE id=?', booking.id).status, 'CANCELLED');
    assert.equal(f.DB.count('disruption_items'), 1);
    assert.equal(f.DB.count('booking_credits', "remaining < 0"), 0);
    for (const row of f.DB.rows('SELECT id, remaining FROM booking_credits')) {
      assert.equal(row.remaining, f.DB.one('SELECT SUM(amount) AS total FROM credit_transactions WHERE credit_id=?', row.id).total);
    }
  });
  test(`H03 independent: disruption rolls back if ${writer} arrives between planning and commit`, async t => {
    const f = fixture(t), settings = await app.loadSettings(f.DB);
    const plan = await app.buildPlan(f.c, f.admin, input, NOW);
    let booking;
    f.DB.beforeWrite = async statements => {
      if (statements.some(stmt => stmt.sql.includes('INSERT INTO disruptions'))) {
        f.DB.beforeWrite = null;
        booking = await make(f, settings);
      }
    };
    await assert.rejects(app.applyDisruption(f.c, f.admin, { ...input, previewToken: plan.previewToken }, 'audit-disruption-002', 'local'), { code: 'DISRUPTION_CHANGED' });
    assert.equal(f.DB.count('closures'), 0);
    assert.equal(f.DB.count('disruptions'), 0);
    assert.equal(f.DB.count('disruption_items'), 0);
    const fresh = await app.buildPlan(f.c, f.admin, input, NOW);
    assert.deepEqual(fresh.items.map(item => item.booking.id), [booking.id]);
    assert.equal(f.DB.count('credit_transactions', "kind='issue'"), writer === 'credit' ? 1 : 0);
  });
  test(`H03 independent: ${writer} cannot book after disruption closure commit`, async t => {
    const f = fixture(t), settings = await app.loadSettings(f.DB);
    const plan = await app.buildPlan(f.c, f.admin, input, NOW);
    await app.applyDisruption(f.c, f.admin, { ...input, previewToken: plan.previewToken }, 'audit-disruption-003', 'local');
    await assert.rejects(make(f, settings));
    assert.equal(f.DB.count('bookings'), 0);
    assert.equal(f.DB.count('booking_slots'), 0);
    assert.equal(f.DB.count('credit_transactions', "kind='redeem'"), 0);
  });
}

test('M09 independent: field-only edits preserve unrelated resource and price fields', async t => {
  const f = fixture(t);
  await app.updateResource(f.c, f.admin, 'court-1', app.resourceUpdateSchema.parse({
    status: 'maintenance', maintenanceNote: 'Original reason', maintenanceUntil: '2026-12-01', priceMember: 99000,
  }));
  await app.updateResource(f.c, f.staff, 'court-1', app.resourceUpdateSchema.parse({ name: 'Renamed court' }));
  let row = f.DB.one("SELECT * FROM resources WHERE id='court-1'");
  assert.equal(row.status, 'maintenance');
  assert.equal(row.maintenance_note, 'Original reason');
  assert.equal(row.maintenance_until, '2026-12-01');
  assert.equal(row.price_member, 99000);
  await app.updateResource(f.c, f.staff, 'court-1', app.resourceUpdateSchema.parse({ maintenanceNote: 'Changed reason' }));
  row = f.DB.one("SELECT * FROM resources WHERE id='court-1'");
  assert.equal(row.name, 'Renamed court');
  assert.equal(row.maintenance_until, '2026-12-01');
  assert.equal(row.price_member, 99000);
  await assert.rejects(app.updateResource(f.c, f.staff, 'court-1', app.resourceUpdateSchema.parse({ priceMember: 1 })), { code: 'FORBIDDEN' });
});

test('M07 independent regression: refused partially credited booking returns a slot conflict with no partial effects', async t => {
  const f = fixture(t), settings = await app.loadSettings(f.DB);
  f.DB.sqlite.prepare("UPDATE resources SET price_member=60000 WHERE id='court-1'").run();
  await app.createHold(f.env, settings, f.player, { ...hold, idempotencyKey: 'audit-occupied-001' }, NOW);
  const creditId = await app.issueManualCredit(f.env, f.admin, { userId: f.other.id, amount: 50000,
    reason: 'Synthetic test credit', sourceBookingId: null, idempotencyKey: 'audit-other-credit-001' }, NOW);
  const before = ['bookings', 'booking_slots', 'booking_events', 'messages', 'notifications', 'booking_operations']
    .map(table => f.DB.count(table));
  await assert.rejects(app.createHold(f.env, settings, f.other, { ...hold, useCredit: true,
    expectedCredit: 50000, idempotencyKey: 'audit-refused-credit-001' }, NOW), { code: 'SLOT_TAKEN' });
  assert.deepEqual(['bookings', 'booking_slots', 'booking_events', 'messages', 'notifications', 'booking_operations']
    .map(table => f.DB.count(table)), before);
  assert.equal(f.DB.count('credit_transactions', "kind='redeem'"), 0);
  assert.equal(f.DB.one('SELECT remaining FROM booking_credits WHERE id=?', creditId).remaining, 50000);
});

for (const first of ['price', 'status']) test(`M09 independent: concurrent admin ${first} edit conflicts before a staff update can undo it`, async t => {
  const f = fixture(t);
  f.DB.beforeWrite = async statements => {
    if (statements.some(stmt => stmt.sql.includes('UPDATE resources'))) {
      f.DB.beforeWrite = null;
      await app.updateResource(f.c, f.admin, 'court-1', app.resourceUpdateSchema.parse(first === 'price' ? { priceMember: 99000 } : { status: 'open_play' }));
    }
  };
  await assert.rejects(app.updateResource(f.c, f.staff, 'court-1', app.resourceUpdateSchema.parse({ name: 'Renamed court' })), { code: 'SCHEDULE_CHANGED' });
  assert.equal(f.DB.one("SELECT name FROM resources WHERE id='court-1'").name, 'Court 1');
  await app.updateResource(f.c, f.staff, 'court-1', app.resourceUpdateSchema.parse({ name: 'Renamed court' }));
  const row = f.DB.one("SELECT * FROM resources WHERE id='court-1'");
  assert.equal(row.name, 'Renamed court');
  assert.equal(first === 'price' ? row.price_member : row.open_play, first === 'price' ? 99000 : 1);
});

test('read-only independent inventory parses and detects deliberately seeded scope/finance anomalies', t => {
  const f = fixture(t);
  seedBooking(f.DB, 'CONFIRMED');
  // The inventory deliberately uses SQLite's real clock. Keep this live fixture
  // ahead of that clock instead of using the application's frozen October 8 date.
  const liveDate = f.DB.sqlite.prepare("SELECT date('now','+8 hours','+2 days') AS date").get().date;
  f.DB.sqlite.prepare("UPDATE bookings SET date=? WHERE id='test_booking'").run(liveDate);
  f.DB.sqlite.exec("UPDATE resources SET status='disabled' WHERE id='court-1'; UPDATE opening_hours SET is_open=0;");
  f.DB.sqlite.prepare("INSERT INTO closures(id,date,resource_id,reason,created_at) VALUES('audit_closure',?,'court-1','Synthetic',?)").run(liveDate, NOW);
  f.DB.sqlite.prepare("INSERT INTO booking_slots(booking_id,resource_id,date,start_min,end_min) VALUES('test_booking','court-1',?,600,660)").run(liveDate);
  const sql = readFileSync(path.join(root, 'scripts/audit-schedule-inventory.sql'), 'utf8');
  const queries = sql.replace(/--[^\n]*/g, '').split(';').map(query => query.trim()).filter(Boolean);
  const results = () => queries.map(query => f.DB.sqlite.prepare(query).all());
  const count = name => results().flat().find(row => row.check_name === name)?.candidates;
  assert.equal(count('live_ordinary_closure_overlaps'), 1);
  assert.equal(count('live_out_of_service_resource_overlaps'), 1);
  assert.equal(count('live_weekly_hours_overlaps'), 1);
  assert.equal(count('negative_credit_balances'), 0);
  assert.deepEqual(results().at(-1), []);
  const historicalDate = f.DB.sqlite.prepare("SELECT date('now','+8 hours','-2 days') AS date").get().date;
  for (const table of ['bookings', 'booking_slots', 'closures']) {
    f.DB.sqlite.prepare(`UPDATE ${table} SET date=?`).run(historicalDate);
  }
  for (const name of ['live_ordinary_closure_overlaps', 'live_out_of_service_resource_overlaps', 'live_weekly_hours_overlaps']) {
    assert.equal(count(name), 0, 'Historical bookings are excluded from live conflict candidates');
  }
  assert.deepEqual(results().at(-1), []);
});

test('read-only slot inventory accepts legacy fallback and gaps, and detects parent/overlap anomalies', t => {
  const f = fixture(t);
  seedBooking(f.DB, 'COMPLETED');
  const queries = readFileSync(path.join(root, 'scripts/audit-schedule-inventory.sql'), 'utf8')
    .replace(/--[^\n]*/g, '').split(';').map(query => query.trim()).filter(Boolean);
  const names = ['slot_parent_identity_mismatches', 'slots_outside_parent_span',
    'slot_parent_envelope_mismatches', 'intra_booking_slot_overlap_pairs'];
  const counts = () => queries.flatMap(query => f.DB.sqlite.prepare(query).all())
    .filter(row => names.includes(row.check_name)).map(row => row.candidates);
  assert.deepEqual(counts(), [0, 0, 0, 0], 'Legacy booking without explicit slots is valid');
  f.DB.sqlite.exec("UPDATE bookings SET end_min=780 WHERE id='test_booking'");
  const insert = f.DB.sqlite.prepare('INSERT INTO booking_slots(booking_id,resource_id,date,start_min,end_min) VALUES(?,?,?,?,?)');
  insert.run('test_booking', 'court-1', TOMORROW, 600, 660);
  insert.run('test_booking', 'court-1', TOMORROW, 720, 780);
  assert.deepEqual(counts(), [0, 0, 0, 0], 'Terminal history slots with a gap are valid');
  const anotherResource = f.DB.one("SELECT id FROM resources WHERE id != 'court-1' LIMIT 1").id;
  f.DB.sqlite.prepare("UPDATE booking_slots SET resource_id=?,date=? WHERE booking_id='test_booking' AND start_min=600")
    .run(anotherResource, app.addDays(TOMORROW, 1));
  f.DB.sqlite.exec("UPDATE booking_slots SET end_min=840 WHERE booking_id='test_booking' AND start_min=720");
  insert.run('test_booking', 'court-1', TOMORROW, 630, 650);
  assert.deepEqual(counts(), [1, 1, 1, 1]);
});
