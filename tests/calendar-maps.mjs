import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, NOW } from './helpers/readiness.mjs';
import { facilityDirections } from '../public/js/core/facility.js';

function setup(t) {
  const f = fixture(t), api = new Hono();
  let actor = f.admin;
  const errors = (error, c) => c.json({ code: error.code, message: error.message, details: error.details }, error.status || 500);
  for (const router of [api, app.adminSettingsRoutes, app.operationsRoutes, app.facilityRoutes]) router.onError(errors);
  api.use('*', (c, next) => { c.set('user', actor); return next(); });
  api.route('/admin', app.adminSettingsRoutes); api.route('/operations', app.operationsRoutes); api.route('/', app.facilityRoutes);
  const request = (url, body) => api.fetch(new Request('http://localhost' + url, body === undefined ? {} : { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), f.env, f.c.executionCtx);
  return { ...f, request, role(value) { actor = value; } };
}

test('Maps location saves, edits and clears through existing settings and public facility APIs', async t => {
  const f = setup(t);
  assert.equal((await (await f.request('/admin/settings')).json()).settings.facilityMapsUrl, '');
  for (const value of [' https://maps.app.goo.gl/SyntheticPin ', 'https://www.google.com/maps/place/Synthetic+Hub/@14.5,121.0,17z', '']) {
    const response = await f.request('/admin/settings', { facilityMapsUrl: value });
    assert.equal(response.status, 200);
    const saved = value.trim();
    assert.equal(f.DB.one("SELECT value FROM settings WHERE key='facility_maps_url'").value, saved);
    assert.equal((await (await f.request('/admin/settings')).json()).settings.facilityMapsUrl, saved);
    f.role(null);
    assert.equal((await (await f.request('/facility')).json()).facility.mapsUrl, saved);
    f.role(f.admin);
  }
  assert.equal(f.DB.count('audit_log', "action='settings_updated' AND detail='facilityMapsUrl'"), 3);
});

test('Maps updates enforce admin authorization and reject unsafe or malformed links', async t => {
  const f = setup(t);
  for (const actor of [null, f.player, f.staff]) {
    f.role(actor);
    assert.equal((await f.request('/admin/settings', { facilityMapsUrl: 'https://maps.app.goo.gl/Test' })).status, actor ? 403 : 401);
  }
  f.role(f.admin);
  for (const value of ['javascript:alert(1)', 'data:text/html,unsafe', '//maps.google.com/abc', 'http://maps.google.com/abc', 'not a link', 'https://user:secret@example.invalid/', 'https://maps.google.com/ab\ncd', 'https://example.invalid/' + 'a'.repeat(2048)]) {
    const response = await f.request('/admin/settings', { facilityMapsUrl: value });
    assert.equal(response.status, 422, value);
    assert.ok((await response.json()).details.facilityMapsUrl);
  }
  assert.equal(f.DB.count('settings', "key='facility_maps_url'"), 0);
});

test('Directions prefer a configured pin and safely fall back to an older address', () => {
  assert.equal(facilityDirections({ mapsUrl: 'https://maps.app.goo.gl/Pin', address: 'Old address' }), 'https://maps.app.goo.gl/Pin');
  assert.equal(facilityDirections({ address: 'Manila & Pasig' }), 'https://www.google.com/maps/search/?api=1&query=Manila%20%26%20Pasig');
  assert.equal(facilityDirections({ mapsUrl: 'javascript:alert(1)', address: 'Manila' }), 'https://www.google.com/maps/search/?api=1&query=Manila');
  assert.equal(facilityDirections({ mapsUrl: 'https://user:secret@example.invalid/' }), null);
  assert.equal(facilityDirections({ address: '[Address pending]' }), null);
  assert.equal(facilityDirections({ mapsUrl: 'https://maps.app.goo.gl/Pin', address: '' }), 'https://maps.app.goo.gl/Pin');
});

test('Console date strip uses real slot availability, respects filters and excludes booking names', async t => {
  const f = setup(t);
  f.DB.sqlite.exec("UPDATE opening_hours SET open_min=960,close_min=1320; UPDATE resources SET status='disabled' WHERE id NOT IN ('court-1','table-1'); UPDATE resources SET status='maintenance',maintenance_until='2026-10-10',maintenance_note='Repair' WHERE id='table-1';");
  f.DB.sqlite.prepare("INSERT INTO closures(id,resource_id,date,reason,created_at) VALUES('all-closed',NULL,'2026-10-08','Event',?)").run(NOW);
  f.DB.sqlite.prepare("INSERT INTO closures(id,resource_id,date,reason,created_at) VALUES('court-closed','court-1','2026-10-09','Repair',?)").run(NOW);
  const result = await (await f.request('/operations/schedule/days?from=2026-10-07')).json();
  assert.equal(result.days.length, 14);
  assert.equal(result.days[0].date, '2026-10-07');
  assert.equal(result.days[0].state, 'open');
  assert.equal(result.days[1].state, 'closed');
  assert.equal(result.days[2].state, 'closed');
  assert.equal(result.days[3].state, 'open');
  assert.equal(result.days[0].available, 6);
  assert.equal(JSON.stringify(result).includes('test_player'), false);
  assert.equal((await (await f.request('/operations/schedule/days?from=2026-10-07&activity=table_tennis')).json()).days[0].state, 'closed');
  f.DB.sqlite.exec("UPDATE resources SET status='active',maintenance_until=NULL,open_play=1 WHERE id='table-1'");
  assert.equal((await (await f.request('/operations/schedule/days?from=2026-10-07&activity=table_tennis')).json()).days[0].state, 'open_play');
  f.DB.sqlite.exec("UPDATE resources SET status='disabled' WHERE id='table-1'");
  assert.equal((await (await f.request('/operations/schedule/days?from=2026-10-07&activity=table_tennis')).json()).days[0].state, 'empty');
});

test('Console date strip reports fully occupied, past and out-of-window days correctly', async t => {
  const f = setup(t);
  f.DB.sqlite.exec("UPDATE opening_hours SET open_min=960,close_min=1020; UPDATE resources SET status='disabled' WHERE id!='court-1';");
  f.DB.sqlite.prepare(`INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,confirmed_at,created_at,updated_at)
    VALUES('occupied','OCCUPIED','test_player','court-1','2026-10-08',960,1020,'CONFIRMED',50000,'member',?,?,?)`).run(NOW, NOW, NOW);
  const result = await (await f.request('/operations/schedule/days?from=2026-10-06')).json();
  assert.equal(result.days[0].state, 'past');
  assert.equal(result.days[2].state, 'full');
  assert.equal(result.days[2].available, 0);
  const grid = await (await f.request('/operations/schedule?date=2026-10-08')).json();
  assert.equal(grid.resources[0].slots[0].state, 'booked');
  assert.equal(grid.resources[0].slots[0].booking.id, 'occupied');
  assert.equal((await (await f.request('/operations/schedule/days?from=2026-11-01')).json()).days[0].state, 'closed');
});

test('Console date-strip API validates inputs and permits only console users', async t => {
  const f = setup(t);
  for (const actor of [null, f.player]) {
    f.role(actor);
    assert.equal((await f.request('/operations/schedule/days')).status, actor ? 403 : 401);
  }
  for (const actor of [f.staff, f.admin]) { f.role(actor); assert.equal((await f.request('/operations/schedule/days')).status, 200); }
  for (const query of ['from=2026-02-31', 'from=9999-12-31', 'activity=unknown']) assert.equal((await f.request('/operations/schedule/days?' + query)).status, 422);
});
