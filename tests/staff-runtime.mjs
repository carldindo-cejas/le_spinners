// Exercises the production router and real local D1 in the disposable verify runtime.
import assert from 'node:assert/strict';
import { deriveClientHash, newPasswordCredentials } from '../public/js/core/password.js';
const base = process.env.BASE_URL || 'http://127.0.0.1:8810';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const adminPassword = 'demo-pass-2026', firstPassword = 'staff-runtime-first-pass', nextPassword = 'staff-runtime-next-pass';
async function request(method, path, body, cookie = '') {
  return fetch(base + path, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
const cookieOf = response => response.headers.getSetCookie().find(value => value.startsWith('ls_session='))?.split(';')[0] || '';
async function proof(email, password) {
  const response = await request('POST', '/api/auth/salt', { email }); assert.equal(response.status, 200);
  const params = await response.json(); return deriveClientHash(password, params.salt, params.iterations);
}
async function login(email, password, portal = 'staff') {
  return request('POST', `/api/auth/${portal}/login`, { email, clientHash: await proof(email, password) });
}
const adminEmail = 'ana.reyes@lespinners.example';
const administrator = await login(adminEmail, adminPassword, 'admin'); assert.equal(administrator.status, 200);
const adminCookie = cookieOf(administrator), email = `staff-runtime-${Date.now()}@example.invalid`;
const credentials = await newPasswordCredentials(firstPassword);
const creation = await request('POST', '/api/admin/staff', { name: 'Runtime Staff', email, password: credentials, status: 'active' }, adminCookie);
assert.equal(creation.status, 201); let account = (await creation.json()).staff; assert.equal(account.role, 'staff');
const staffOne = await login(email, firstPassword), staffTwo = await login(email, firstPassword);
assert.equal(staffOne.status, 200); assert.equal(staffTwo.status, 200);
const cookies = [cookieOf(staffOne), cookieOf(staffTwo)];
for (const [method, path, body] of [['GET', '/api/admin/staff'], ['POST', '/api/admin/staff', {}], ['PATCH', `/api/admin/staff/${account.id}`, {}], ['POST', `/api/admin/staff/${account.id}/reset-password`, {}]]) {
  assert.equal((await request(method, path, body, cookies[0])).status, 403);
  assert.equal((await request(method, path, body)).status, 401);
}
assert.equal((await request('GET', '/api/staff/settings', null, cookies[0])).status, 404);
assert.equal((await request('GET', '/api/admin/revenue/summary', null, cookies[0])).status, 403);
assert.equal('verifiedRevenueToday' in await (await request('GET', '/api/staff/summary', null, cookies[0])).json(), false);
async function update(fields) {
  const response = await request('PATCH', `/api/admin/staff/${account.id}`, { expectedAuthVersion: account.authVersion, expectedUpdatedAt: account.updatedAt, ...fields }, adminCookie);
  assert.equal(response.status, 200); account = (await response.json()).staff;
}
await update({ status: 'disabled' });
for (const cookie of cookies) assert.equal((await request('GET', '/api/staff/badges', null, cookie)).status, 401);
assert.equal((await login(email, firstPassword)).status, 403);
await update({ status: 'active' });
for (const cookie of cookies) assert.equal((await request('GET', '/api/staff/badges', null, cookie)).status, 401);
const fresh = await login(email, firstPassword); assert.equal(fresh.status, 200);
const reset = await request('POST', `/api/admin/staff/${account.id}/reset-password`, {
  expectedAuthVersion: account.authVersion, expectedUpdatedAt: account.updatedAt,
  currentClientHash: await proof(adminEmail, adminPassword), newPassword: await newPasswordCredentials(nextPassword),
}, adminCookie);
assert.equal(reset.status, 200);
assert.equal((await request('GET', '/api/staff/badges', null, cookieOf(fresh))).status, 401);
assert.equal((await login(email, firstPassword)).status, 401); assert.equal((await login(email, nextPassword)).status, 200);
assert.equal((await request('GET', '/api/admin/staff', null, adminCookie)).status, 200);
assert.equal((await request('POST', '/api/auth/logout', {}, adminCookie)).status, 200);
console.log('Staff management real D1/runtime passed: creation, role boundaries, login, deactivation, reactivation and password reset.');
