/** Public calendar integration checks against an ISOLATED local Wrangler database.
 * Prepare migrations + db/facility.sql in .wrangler/landing-test-state, then run:
 *   wrangler dev --local --persist-to .wrangler/landing-test-state --port 8791
 *   node tests/public-calendar.mjs
 * This seeds only that isolated store. Never point it at your normal dev server.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const base = process.env.CALENDAR_BASE_URL || 'http://127.0.0.1:8791';
assert.match(base,/^http:\/\/127\.0\.0\.1:\d+$/);
const store = process.env.CALENDAR_STORE || '.wrangler/landing-test-state';
assert.ok(store.startsWith('.wrangler/') && !store.includes('..'),'Use a disposable calendar store');
const facility = await (await fetch(`${base}/api/facility`)).json();
const date = (offset) => new Date(Date.parse(`${facility.today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const now = Date.now();
const tokens = { player: 'calendar-test-player-session-token-0001', staff: 'calendar-test-staff-session-token-0001', admin: 'calendar-test-admin-session-token-0001' };
const statements = [
  `UPDATE opening_hours SET is_open = 1, open_min = 0, close_min = 1440;`,
  `UPDATE resources SET status = 'active', open_play = 0;`,
  `UPDATE resources SET status = 'maintenance', maintenance_note = 'PRIVATE maintenance note' WHERE id = 'court-3';`,
  `UPDATE resources SET open_play = 1 WHERE id = 'table-3';`,
  `UPDATE resources SET status = 'disabled' WHERE id = 'table-2';`,
  `DELETE FROM booking_slots WHERE booking_id LIKE 'calendar-test-%';`,
  `DELETE FROM bookings WHERE id LIKE 'calendar-test-%';`,
  `DELETE FROM closures WHERE id LIKE 'calendar-test-%';`,
];
for (const [role, token] of Object.entries(tokens)) {
  statements.push(`INSERT OR IGNORE INTO users (id,email,name,password_hash,role,membership,created_at,updated_at) VALUES ('calendar-test-${role}','calendar-${role}@example.com','PRIVATE ${role} name','','${role}','member',${now},${now});`);
  statements.push(`INSERT OR REPLACE INTO sessions (id,user_id,created_at,expires_at,last_seen_at,auth_version) SELECT '${createHash('sha256').update(token).digest('hex')}',id,${now},${now + 3600000},${now},auth_version FROM users WHERE id='calendar-test-${role}';`);
}
for (const [key, start, end, status, expires] of [
  ['gap', 960, 1140, 'CONFIRMED', null],
  ['hold', 1020, 1080, 'TEMPORARY', now + 3600000],
  ['proof', 1140, 1200, 'PAYMENT_SUBMITTED', null],
  ['rejected', 1200, 1260, 'REJECTED', now + 3600000],
  ['expired', 1260, 1320, 'TEMPORARY', now - 1000],
  ['rejected-expired', 1320, 1380, 'REJECTED', now - 1000],
]) {
  statements.push(`INSERT INTO bookings (id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,hold_expires_at,created_at,updated_at,booker_name) VALUES ('calendar-test-${key}','PRIVATE-ref-${key}','calendar-test-player','court-1','${date(1)}',${start},${end},'${status}',123456,'member',${expires},${now},${now},'PRIVATE booker name');`);
}
for (const start of [960, 1080]) statements.push(`INSERT INTO booking_slots VALUES ('calendar-test-gap','court-1','${date(1)}',${start},${start + 60});`);
statements.push(`INSERT INTO closures (id,date,resource_id,start_min,end_min,reason,created_at) VALUES ('calendar-test-partial','${date(1)}','court-2',960,1020,'PRIVATE closure reason',${now}),('calendar-test-all','${date(2)}',NULL,NULL,NULL,'PRIVATE closure reason',${now});`);
writeFileSync('.wrangler/calendar-fixtures.sql', statements.join('\n'));
const seed = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--persist-to', store, '--file', '.wrangler/calendar-fixtures.sql'], { encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr || seed.stdout);

let checks = 0;
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks++; }
async function get(query, role) {
  const res = await fetch(`${base}/api/facility/calendar?${query}`, { headers: role ? { Cookie: `ls_session=${tokens[role]}` } : {} });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const res = await get(`date=${date(1)}`);
check('public access', res.status, 200);
check('network-only response', res.headers.get('cache-control'), 'no-store');
check('both sports', [...new Set(res.body.resources.map((r) => r.activity))].sort(), ['pickleball', 'table_tennis']);
check('disabled resource omitted', res.body.resources.some((r) => r.id === 'table-2'), false);
check('no private values', JSON.stringify(res.body).includes('PRIVATE'), false);
for (const r of res.body.resources) {
  check('resource field allowlist', Object.keys(r).sort(), ['activity', 'id', 'name', 'slots', 'status']);
  for (const s of r.slots) check('slot field allowlist', Object.keys(s).sort(), ['end', 'label', 'start', 'state']);
}
const slot = (id, start) => res.body.resources.find((r) => r.id === id).slots.find((s) => s.start === start).state;
check('confirmed first segment', slot('court-1', 960), 'booked');
check('gap occupied by a separate hold', slot('court-1', 1020), 'held');
check('confirmed second segment', slot('court-1', 1080), 'booked');
check('payment proof', slot('court-1', 1140), 'unavailable');
check('rejected resubmit window', slot('court-1', 1200), 'held');
check('expired hold reopens without cron', slot('court-1', 1260), 'available');
check('expired rejection reopens', slot('court-1', 1320), 'available');
check('partial closure', slot('court-2', 960), 'closed');
check('outside partial closure', slot('court-2', 1020), 'available');
check('maintenance', slot('court-3', 960), 'maintenance');
check('open play', slot('table-3', 960), 'open_play');
for (const role of Object.keys(tokens)) {
  const signed = await get(`date=${date(1)}`, role);
  check(`${role}: same anonymous resource data`, signed.body.resources, res.body.resources);
}
const tennis = await get(`date=${date(1)}&activity=table_tennis`);
check('sport filter', tennis.body.resources.every((r) => r.activity === 'table_tennis'), true);
const closed = await get(`date=${date(2)}`);
check('facility closure', closed.body.open, false);
check('closure overrides open play / maintenance', closed.body.resources.every((r) => r.slots.every((s) => s.state === 'closed')), true);
const today = await get(`date=${date(0)}`);
check('past times', today.body.resources[0].slots[0].state, 'past');
check('last allowed day', (await get(`date=${date(facility.rules.bookingWindowDays)}`)).status, 200);
for (const query of ['date=2026-02-30', 'date=nope', '', `date=${date(-1)}`, `date=${date(facility.rules.bookingWindowDays + 1)}`, `date=${date(1)}&activity=bad`]) {
  check(`invalid query: ${query}`, (await get(query)).status, 422);
}
check('private availability still requires login', (await fetch(`${base}/api/availability?activity=pickleball&date=${date(1)}`)).status, 401);
check('private bookings still require login', (await fetch(`${base}/api/bookings`)).status, 401);
console.log(`Public calendar: ${checks} checks passed (isolated local fixtures).`);
