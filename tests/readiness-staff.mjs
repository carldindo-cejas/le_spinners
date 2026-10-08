import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { app, fixture, NOW, root, seedBooking, TestD1 } from './helpers/readiness.mjs';

const ADMIN_HASH = 'A'.repeat(43), STAFF_HASH = 'B'.repeat(43), NEW_HASH = 'C'.repeat(43);
const password = (clientHash = STAFF_HASH, salt = 'S'.repeat(22)) => ({ clientHash, salt, scheme: app.PASSWORD_SCHEME, iterations: app.PASSWORD_ITERATIONS });
const stamp = account => ({ expectedAuthVersion: account.authVersion, expectedUpdatedAt: account.updatedAt });
async function setup(t) {
  const f = fixture(t), pending = [], api = new Hono();
  f.env.PASSWORD_PEPPER = 'synthetic-staff-management-pepper-for-tests-only';
  for (const [id, hash] of [['test_admin', ADMIN_HASH], ['test_staff', STAFF_HASH], ['test_player', STAFF_HASH]]) {
    f.DB.sqlite.prepare('UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,password_scheme=? WHERE id=?')
      .run(await app.pepperHash(f.env.PASSWORD_PEPPER, hash), 'S'.repeat(22), app.PASSWORD_ITERATIONS, app.PASSWORD_SCHEME, id);
  }
  const errors = (error, c) => c.json({ error: { code: error.code ?? 'INTERNAL', message: error.message, details: error.details } }, error.status ?? 500);
  for (const router of [api, app.authRoutes, app.adminStaffRoutes, app.operationsRoutes, app.meRoutes]) router.onError(errors);
  api.use('*', app.loadSession);
  api.route('/api/auth', app.authRoutes); api.route('/api/me', app.meRoutes);
  api.use('/api/admin/*', app.roleGuard(app.requireAdmin));
  api.route('/api/admin/staff', app.adminStaffRoutes);
  api.route('/api/staff', app.operationsRoutes);
  api.route('/api/admin', app.operationsRoutes);
  let administratorCookie = '';
  const request = (method, url, body, cookie = administratorCookie) => api.fetch(new Request('http://localhost' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }), f.env, { waitUntil(p) { pending.push(p); }, passThroughOnException() {} });
  const cookie = response => response.headers.get('Set-Cookie')?.split(';')[0] ?? '';
  const login = (email = 'test_staff@example.invalid', hash = STAFF_HASH, portal = 'staff') => request('POST', `/api/auth/${portal}/login`, { email, clientHash: hash }, '');
  administratorCookie = cookie(await login('test_admin@example.invalid', ADMIN_HASH, 'admin'));
  assert.ok(administratorCookie);
  t.after(async () => { await Promise.all(pending); });
  const create = (fields = {}) => request('POST', '/api/admin/staff', { name: 'New Staff', email: 'new.staff@example.invalid', password: password(), ...fields });
  const account = id => app.staffDTO(f.DB.one('SELECT * FROM users WHERE id=?', id));
  const update = (row, fields) => request('PATCH', '/api/admin/staff/' + row.id, { ...stamp(row), ...fields });
  const reset = (row, fields = {}) => request('POST', `/api/admin/staff/${row.id}/reset-password`, { ...stamp(row), currentClientHash: ADMIN_HASH, newPassword: password(NEW_HASH, 'T'.repeat(22)), ...fields });
  const active = async session => Boolean((await (await request('GET', '/api/auth/session', null, session)).json()).user);
  const actor = async session => {
    const id = await app.sha256Hex(session.slice('ls_session='.length));
    return { ...f.DB.one('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=?', id), session_id: id };
  };
  return { ...f, request, cookie, login, create, update, reset, account, active, actor, administratorCookie };
}
function pauseWrite(f, match) {
  let release, enter;
  const arrived = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.DB.beforeWrite = async statements => { if (statements.some(match)) { f.DB.beforeWrite = null; enter(); await gate; } };
  return { arrived, release };
}

test('Staff creation uses fixed role, existing hash format, safe DTO and preserves admin session', async t => {
  const f = await setup(t), response = await f.create(); assert.equal(response.status, 201);
  const account = (await response.json()).staff, row = f.DB.one('SELECT * FROM users WHERE id=?', account.id);
  assert.equal(row.role, 'staff'); assert.equal(row.membership, 'none'); assert.equal(row.status, 'active');
  assert.equal(await app.verifyClientHash(f.env.PASSWORD_PEPPER, STAFF_HASH, row.password_hash), true);
  assert.equal(account.createdAt, NOW); assert.equal(account.authVersion, 1);
  assert.deepEqual(Object.keys(account).sort(), ['authVersion','createdAt','email','id','name','role','status','updatedAt'].sort());
  assert.equal(f.DB.count('sessions', `user_id='${account.id}'`), 0);
  assert.equal(await f.active(f.administratorCookie), true);
  assert.equal((await f.login(account.email)).status, 200);
  for (const portal of ['user', 'admin']) assert.equal((await f.login(account.email, STAFF_HASH, portal)).status, 401);
  const audit = f.DB.one("SELECT * FROM audit_log WHERE action='staff_created'");
  assert.equal(audit.actor_id, 'test_admin'); assert.equal(audit.entity_id, account.id);
});

test('Inactive staff cannot log in; activation requires a fresh session', async t => {
  const f = await setup(t), account = (await (await f.create({ status: 'disabled' })).json()).staff;
  assert.equal((await f.login(account.email)).status, 403);
  assert.equal((await f.update(account, { status: 'active' })).status, 200);
  assert.equal((await f.login(account.email)).status, 200);
});

test('Normalized duplicates across roles and simultaneous creation never overwrite an account', async t => {
  const f = await setup(t);
  for (const role of ['admin', 'staff', 'player']) {
    const response = await f.create({ email: ` TEST_${role}@EXAMPLE.INVALID ` });
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'EMAIL_TAKEN');
    assert.equal(f.DB.one('SELECT role FROM users WHERE id=?', 'test_' + role).role, role);
  }
  const responses = await Promise.all([f.create(), f.create()]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(f.DB.count('users', "email='new.staff@example.invalid'"), 1);
  assert.equal(f.DB.count('audit_log', "action='staff_created'"), 1);
});

test('Validation rejects malformed credentials, invalid fields and client-selected privileges', async t => {
  const f = await setup(t);
  for (const body of [{ name: 'x' }, { email: 'invalid' }, { status: 'inactive' }, { role: 'admin' }, { membership: 'member' },
    { password: { ...password(), iterations: 1 } }, { password: { ...password(), scheme: 'other' } }, { password: { ...password(), clientHash: 'bad' } }]) {
    assert.equal((await f.create(body)).status, 422, JSON.stringify(body));
  }
  assert.equal(f.DB.count('audit_log', "action='staff_created'"), 0);
});

test('Every management method rejects anonymous/player/staff and wrong-role targets', async t => {
  const f = await setup(t), staffCookie = f.cookie(await f.login()), playerCookie = f.cookie(await f.login('test_player@example.invalid', STAFF_HASH, 'user'));
  for (const session of ['', playerCookie, staffCookie]) for (const [method, url, body] of [
    ['GET', '/api/admin/staff', null], ['POST', '/api/admin/staff', {}], ['PATCH', '/api/admin/staff/test_staff', {}], ['POST', '/api/admin/staff/test_staff/reset-password', {}],
  ]) assert.equal((await f.request(method, url, body, session)).status, session ? 403 : 401);
  for (const id of ['test_admin', 'test_player', 'missing']) {
    assert.equal((await f.request('PATCH', '/api/admin/staff/' + id, { expectedAuthVersion: 1, expectedUpdatedAt: NOW, name: 'Wrong target' })).status, 404);
    assert.equal((await f.request('POST', `/api/admin/staff/${id}/reset-password`, { expectedAuthVersion: 1, expectedUpdatedAt: NOW, currentClientHash: ADMIN_HASH, newPassword: password() })).status, 404);
  }
  assert.equal((await f.request('PATCH', '/api/admin/staff/test_staff', { ...stamp(f.account('test_staff')), role: 'admin' })).status, 422);
});

test('Staff listing searches literal text, scopes pagination and includes inactive accounts without secrets', async t => {
  const f = await setup(t);
  for (let n = 0; n < 5; n++) assert.equal((await f.create({ email: `person${n}@example.invalid`, name: n === 0 ? 'Staff % Name' : 'Staff ' + n, status: n === 1 ? 'disabled' : 'active' })).status, 201);
  const first = await (await f.request('GET', '/api/admin/staff?limit=2')).json();
  assert.equal(first.staff.length, 2); assert.equal(first.page.hasMore, true);
  const next = await (await f.request('GET', '/api/admin/staff?limit=2&cursor=' + first.page.nextCursor)).json();
  assert.equal(new Set([...first.staff, ...next.staff].map(row => row.id)).size, 4);
  assert.equal((await f.request('GET', '/api/admin/staff?status=disabled&cursor=' + first.page.nextCursor)).status, 400);
  const inactive = await (await f.request('GET', '/api/admin/staff?status=disabled')).json(); assert.equal(inactive.staff.length, 1);
  const literal = await (await f.request('GET', '/api/admin/staff?q=%25')).json(); assert.equal(literal.staff.length, 1);
  const searched = await (await f.request('GET', '/api/admin/staff?q=PERSON2')).json(); assert.equal(searched.staff[0].email, 'person2@example.invalid');
  assert.ok(first.staff.every(row => row.role === 'staff')); assert.ok(!JSON.stringify(first).includes('password'));
  assert.equal((await f.request('GET', '/api/admin/staff?limit=101')).status, 400);
});

test('Deactivation revokes all existing cookies; reactivation never resurrects them', async t => {
  const f = await setup(t), cookies = [f.cookie(await f.login()), f.cookie(await f.login())];
  assert.equal((await f.update(f.account('test_staff'), { status: 'disabled' })).status, 200);
  for (const cookie of cookies) { assert.equal(await f.active(cookie), false); assert.equal((await f.request('GET', '/api/staff/summary', null, cookie)).status, 401); }
  assert.equal(f.DB.count('sessions', "user_id='test_staff'"), 0);
  assert.equal((await f.update(f.account('test_staff'), { status: 'active' })).status, 200);
  for (const cookie of cookies) assert.equal(await f.active(cookie), false);
  assert.equal((await f.login()).status, 200); assert.equal(await f.active(f.administratorCookie), true);
});

test('Name edits retain sessions; email edits invalidate cookies and change login identity', async t => {
  const f = await setup(t), cookie = f.cookie(await f.login());
  assert.equal((await f.update(f.account('test_staff'), { name: 'Updated Staff' })).status, 200); assert.equal(await f.active(cookie), true);
  assert.equal((await f.update(f.account('test_staff'), { email: ' changed@example.invalid ' })).status, 200); assert.equal(await f.active(cookie), false);
  assert.equal((await f.login()).status, 401); assert.equal((await f.login('changed@example.invalid')).status, 200);
});

test('Admin-authenticated reset revokes every staff cookie and preserves inactive status', async t => {
  const f = await setup(t), cookie = f.cookie(await f.login());
  assert.equal((await f.reset(f.account('test_staff'), { currentClientHash: STAFF_HASH })).status, 422); assert.equal(await f.active(cookie), true);
  assert.equal((await f.reset(f.account('test_staff'))).status, 200); assert.equal(await f.active(cookie), false);
  assert.equal((await f.login()).status, 401); assert.equal((await f.login('test_staff@example.invalid', NEW_HASH)).status, 200);
  assert.equal((await f.update(f.account('test_staff'), { status: 'disabled' })).status, 200);
  assert.equal((await f.reset(f.account('test_staff'), { newPassword: password(STAFF_HASH, 'U'.repeat(22)) })).status, 200);
  assert.equal(f.account('test_staff').status, 'disabled'); assert.equal((await f.login()).status, 403);
  assert.equal(await f.active(f.administratorCookie), true);
});

test('A delayed verified staff login cannot win against deactivation or password reset', async t => {
  for (const operation of ['deactivate', 'reset']) {
    const f = await setup(t), pause = pauseWrite(f, statement => statement.sql.includes('INSERT INTO sessions'));
    const login = f.login(); await pause.arrived;
    try { assert.equal((await (operation === 'reset' ? f.reset(f.account('test_staff')) : f.update(f.account('test_staff'), { status: 'disabled' }))).status, 200); }
    finally { pause.release(); }
    const response = await login; assert.equal(response.status, 401); assert.equal(response.headers.get('Set-Cookie'), null);
  }
});

test('Stale and competing sensitive changes have one winner and no duplicate effects', async t => {
  const f = await setup(t), row = f.account('test_staff');
  const responses = await Promise.all([f.update(row, { status: 'disabled' }), f.reset(row)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.DB.count('audit_log', "action IN ('staff_deactivated','staff_password_reset')"), 1);
  assert.equal((await f.update(row, { name: 'Stale' })).status, 409);
});

test('A staff profile edit invalidates a same-millisecond management form without revoking its session', async t => {
  const f = await setup(t), row = f.account('test_staff'), cookie = f.cookie(await f.login());
  const profile = await f.request('PATCH', '/api/me', { name: 'Staff updated their name' }, cookie);
  assert.equal(profile.status, 200);
  assert.ok(f.account('test_staff').updatedAt > row.updatedAt);
  assert.equal((await f.update(row, { name: 'Old management form' })).status, 409);
  assert.equal(f.account('test_staff').name, 'Staff updated their name');
  assert.equal(await f.active(cookie), true);
});

test('A failed audit rolls back account changes and session deletion', async t => {
  const f = await setup(t), cookie = f.cookie(await f.login()), before = f.DB.one("SELECT * FROM users WHERE id='test_staff'");
  f.DB.beforeExecute = statement => { if (statement.sql.includes('INSERT INTO audit_log') && statement.args.includes('test_staff')) throw Error('Injected audit failure'); };
  assert.equal((await f.update(f.account('test_staff'), { status: 'disabled' })).status, 500);
  f.DB.beforeExecute = null;
  assert.deepEqual(f.DB.one("SELECT * FROM users WHERE id='test_staff'"), before); assert.equal(await f.active(cookie), true);
});

test('Pending account mutation fails when the administrator loses access', async t => {
  const f = await setup(t), pause = pauseWrite(f, s => s.sql.includes('INSERT INTO users'));
  const creation = f.create(); await pause.arrived;
  try { f.DB.sqlite.exec("UPDATE users SET status='disabled' WHERE id='test_admin'"); } finally { pause.release(); }
  assert.equal((await creation).status, 401); assert.equal(f.DB.count('users', "email='new.staff@example.invalid'"), 0);
});

test('Already-authenticated payment, chat, facility and notification writes fail after deactivation', async t => {
  const f = await setup(t), cookie = f.cookie(await f.login()), staff = await f.actor(cookie);
  seedBooking(f.DB, 'PAYMENT_SUBMITTED'); const booking = await app.getBooking(f.DB, 'test_booking');
  f.DB.sqlite.exec("INSERT INTO notifications(id,audience,type,title,body,created_at) VALUES('notice','staff','new_message','Test','Test',1)");
  assert.equal((await f.update(f.account('test_staff'), { status: 'disabled' })).status, 200);
  for (const action of [
    () => app.approvePayment(f.env, staff, 'test_booking', NOW),
    () => app.postMessage(f.env, staff, 'staff', booking, 'Must not be sent', NOW),
    () => app.updateResource(f.c, staff, 'court-1', { name: 'Must not rename', confirmAffected: null }),
    () => app.authorizedBatch(f.DB, staff, [f.DB.prepare("UPDATE notifications SET read_at=1 WHERE id='notice'")]),
  ]) await assert.rejects(action(), error => error.status === 401);
  assert.equal(f.DB.one("SELECT status FROM bookings WHERE id='test_booking'").status, 'PAYMENT_SUBMITTED');
  assert.equal(f.DB.count('messages'), 0); assert.equal(f.DB.one("SELECT read_at FROM notifications WHERE id='notice'").read_at, null);
});

test('A paused staff mutation rolls back when deactivation commits before its batch', async t => {
  const f = await setup(t), cookie = f.cookie(await f.login()), staff = await f.actor(cookie); seedBooking(f.DB, 'PAYMENT_SUBMITTED');
  const pause = pauseWrite(f, statement => statement.sql.includes("SET status = 'CONFIRMED'"));
  const approval = app.approvePayment(f.env, staff, 'test_booking', NOW); await pause.arrived;
  try { assert.equal((await f.update(f.account('test_staff'), { status: 'disabled' })).status, 200); } finally { pause.release(); }
  await assert.rejects(approval, error => error.status === 401);
  assert.equal(f.DB.one("SELECT status FROM bookings WHERE id='test_booking'").status, 'PAYMENT_SUBMITTED'); assert.equal(f.DB.count('booking_events'), 0);
});

test('Staff dashboard excludes revenue aggregates while admin dashboard retains them', async t => {
  const f = await setup(t), staffCookie = f.cookie(await f.login());
  assert.equal('verifiedRevenueToday' in await (await f.request('GET', '/api/staff/summary', null, staffCookie)).json(), false);
  assert.equal('verifiedRevenueToday' in await (await f.request('GET', '/api/admin/summary')).json(), true);
});

test('Populated upgrade preserves credentials and sessions until an identity change', t => {
  const db = new TestD1(); t.after(() => db.sqlite.close());
  for (const file of readdirSync(path.join(root, 'migrations')).filter(name => name.endsWith('.sql') && name < '0021').sort()) db.sqlite.exec(readFileSync(path.join(root, 'migrations', file), 'utf8'));
  db.sqlite.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES('legacy','Legacy','legacy@example.invalid','unchanged','staff',?,?)").run(NOW, NOW);
  db.sqlite.prepare("INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at,auth_version) VALUES('legacy-session','legacy',?,?,?,1)").run(NOW, NOW + 1000, NOW);
  db.sqlite.exec(readFileSync(path.join(root, 'migrations/0021_staff_account_management.sql'), 'utf8'));
  assert.equal(db.one("SELECT password_hash FROM users WHERE id='legacy'").password_hash, 'unchanged'); assert.equal(db.one("SELECT auth_version FROM sessions WHERE id='legacy-session'").auth_version, 1);
  db.sqlite.exec("UPDATE users SET email='new@example.invalid' WHERE id='legacy'"); assert.equal(db.one("SELECT auth_version FROM users WHERE id='legacy'").auth_version, 2);
  assert.deepEqual(db.rows('PRAGMA foreign_key_check'), []);
});
