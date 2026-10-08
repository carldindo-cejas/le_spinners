#!/usr/bin/env node
/**
 * API smoke test for the core flow and its privacy rules.
 *
 *   npm run db:reset:local      (fresh demo data)
 *   npm run dev:test            (in another terminal: wrangler dev --test-scheduled)
 *   npm run test:smoke
 *
 * Talks to the local dev server only. Uses `wrangler d1 execute --local` to
 * fast-forward the clock on a few bookings (expiry, warnings, the 24 h rule).
 *
 * Password sign-in only, against a deployed Worker (registers throwaway accounts,
 * then deletes them from the remote database):
 *   BASE_URL=https://le-spinners.example.workers.dev npm run test:smoke -- --auth-only
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveClientHash, newPasswordCredentials } from '../public/js/core/password.js';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = 'demo-pass-2026';
const TZ_MS = 8 * 3_600_000;
const AUTH_ONLY = process.argv.includes('--auth-only');
const REMOTE = !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE);
if (REMOTE && !AUTH_ONLY) {
  console.error('Against a deployed Worker only --auth-only is supported (the full run edits the database).');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];
const seenBodies = [];

function check(name, cond, info) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${info !== undefined ? `\n      ${typeof info === 'string' ? info : JSON.stringify(info).slice(0, 600)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }

  async req(method, path, { json, form, headers = {}, origin = BASE } = {}) {
    const h = { ...(method === 'POST' && /^\/api\/(?:admin\/|staff\/)?bookings$/.test(path) ? { 'Idempotency-Key': randomUUID() } : {}), ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (method !== 'GET' && method !== 'HEAD' && origin) h.Origin = origin;
    let body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    let res;
    try {
      res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
    } catch (err) {
      // A pooled keep-alive socket can be closed while a blocking step (wrangler d1 execute) runs.
      // ECONNRESET on a stale socket means the request never reached the server, so any method may retry.
      if (method !== 'GET' && err?.cause?.code !== 'ECONNRESET') throw err;
      res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
    }
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^ls_session=([^;]*)/.exec(c);
      if (m) this.cookie = m[1] ? `ls_session=${m[1]}` : '';
    }
    const type = res.headers.get('content-type') ?? '';
    let data;
    if (type.includes('application/json')) {
      data = await res.json();
      seenBodies.push(JSON.stringify(data));
    } else {
      data = new Uint8Array(await res.arrayBuffer());
    }
    return { status: res.status, data, headers: res.headers };
  }

  get(path, opts) {
    return this.req('GET', path, opts);
  }
  post(path, json, opts = {}) {
    return this.req('POST', path, { ...opts, json });
  }
  put(path, json, opts = {}) {
    return this.req('PUT', path, { ...opts, json });
  }

  /** Browser sign-in: fetch the salt, derive PBKDF2 locally, send only the clientHash. */
  async proof(email, password = PASSWORD) {
    const s = await this.post('/api/auth/salt', { email });
    if (s.status !== 200) throw new Error(`salt failed for ${email}: ${s.status} ${JSON.stringify(s.data)}`);
    return deriveClientHash(password, s.data.salt, s.data.iterations);
  }

  /** portal: 'user' (players), 'staff' or 'admin'. Each account signs in only through its own portal. */
  async login(email, password = PASSWORD, portal = 'user') {
    const r = await this.post(`/api/auth/${portal}/login`, { email, clientHash: await this.proof(email, password) });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
    this.user = r.data.user;
    return r;
  }
}

function localDate(offsetDays = 0) {
  return new Date(Date.now() + TZ_MS + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Runs SQL against the LOCAL D1 database (same file the dev server uses), or the deployed one when REMOTE. */
function sql(statement) {
  mkdirSync(join(ROOT, '.wrangler', 'tmp'), { recursive: true });
  const rel = `.wrangler/tmp/smoke-${Date.now()}.sql`;
  writeFileSync(join(ROOT, rel), statement);
  const isWindows = process.platform === 'win32';
  const r = spawnSync(isWindows ? 'npx.cmd' : 'npx', ['wrangler', 'd1', 'execute', 'DB', REMOTE ? '--remote' : '--local', `--file=${rel}`, '--json', ...(REMOTE ? ['--yes'] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: isWindows,
    env: { ...process.env, CI: 'true' },
  });
  rmSync(join(ROOT, rel), { force: true });
  if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${r.stderr || r.stdout}`);
  const start = r.stdout.indexOf('[');
  return JSON.parse(r.stdout.slice(start));
}

/**
 * Every request here comes from one IP, so sign-in-heavy sections would trip the
 * real per-IP limits (30 sign-ins / 60 salt lookups per 15 minutes). Clear them first.
 */
function resetSignInLimits() {
  sql(`DELETE FROM rate_limits WHERE key LIKE 'login:%' OR key LIKE 'salt:%';`);
}

/** Triggers the Worker's scheduled() handler (needs `wrangler dev --test-scheduled`). */
async function runCron() {
  const url = `${BASE}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    // Same stale keep-alive socket case as Client.req: it follows a blocking sql() call.
    if (err?.cause?.code !== 'ECONNRESET') throw err;
    res = await fetch(url);
  }
  await res.arrayBuffer();
  await new Promise((r) => setTimeout(r, 400)); // the handler finishes in waitUntil
  return res.status;
}

function pngFile(name, bytes, type = 'image/png') {
  return new File([bytes], name, { type });
}

function proofForm(file, fields = {}) {
  const f = new FormData();
  if (file) f.append('file', file);
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

function findSlot(day, resourceId, state = 'available', skip = []) {
  const r = day.resources.find((x) => x.id === resourceId);
  return r?.slots.find((s) => s.state === state && !skip.includes(s.start));
}

// ── Images carrying the metadata that phones, editors and C2PA tools add ─────
const bin = (s) => Buffer.from(s, 'latin1');
const hasAny = (buf, tags) => tags.filter((t) => buf.includes(bin(t)));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([bin(type), bin(data)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Adds text, EXIF, C2PA, timestamp and private chunks after IHDR, and bytes after IEND. */
function dirtyPng(png) {
  const at = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([
    png.subarray(0, at),
    pngChunk('tEXt', 'Author\0PngTextTag'),
    pngChunk('eXIf', 'MM\0*PngExifTag'),
    pngChunk('caBX', 'jumbc2paPngManifestTag'),
    pngChunk('tIME', '\x07\xea\x09\x1e\x08\x00\x00'),
    pngChunk('prVt', 'PngPrivateTag'),
    png.subarray(at),
    bin('PngTrailerTag'),
  ]);
}

function jpegSegment(marker, data) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, bin(data)]);
}

/**
 * Adds what phones add (MPF, C2PA, maker data, a comment, a second image after
 * end-of-image) plus an ICC profile and Adobe flag, which must be kept.
 */
function dirtyJpeg(jpeg) {
  const at = jpeg[3] === 0xe0 ? 4 + jpeg.readUInt16BE(4) : 2;
  return Buffer.concat([
    jpeg.subarray(0, at),
    jpegSegment(0xe2, 'ICC_PROFILE\0\x01\x01KeepIccTag'),
    jpegSegment(0xe2, 'MPF\0MM\0*JpegMpfTag'),
    jpegSegment(0xeb, 'JP\0\0\0\x01jumbc2paJpegManifestTag'),
    jpegSegment(0xec, 'Ducky\0JpegDuckyTag'),
    jpegSegment(0xee, 'Adobe\0d\0\0\0\0\x01'),
    jpegSegment(0xfe, 'JpegCommentTag'),
    jpeg.subarray(at),
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe1, 'Exif\0\0JpegTrailerCamTag'),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A 1×1 extended WebP (VP8X + ALPH + VP8). */
const TINY_WEBP = Buffer.from('UklGRkoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAARBxAR/Q9ERP8DAABWUDggGAAAABQBAJ0BKgEAAQAAAP4AAA3AAP7mtQAAAA==', 'base64');

function riffChunk(fourcc, data) {
  const d = bin(data);
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(d.length, 4);
  return Buffer.concat([head, d, Buffer.alloc(d.length & 1)]);
}

/** TINY_WEBP with EXIF, XMP, C2PA and private chunks, and bytes after the RIFF container. */
function dirtyWebp() {
  const body = Buffer.concat([
    bin('WEBP'),
    TINY_WEBP.subarray(12),
    riffChunk('EXIF', 'MM\0*WebpExifTag'),
    riffChunk('XMP ', '<x:xmpmeta>WebpXmpTag</x:xmpmeta>'),
    riffChunk('C2PA', 'jumbc2paWebpManifestTag'),
    riffChunk('prVt', 'WebpPrivateTag'),
  ]);
  body[12] |= 0x0c; // VP8X flags: EXIF + XMP present
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, bin('WebpTrailerTag')]);
}

// ───────────────────────────────────────────────────────────────────────────

const juan = new Client('juan');
const pedro = new Client('pedro');
const maria = new Client('maria');
const kim = new Client('kim');
const ana = new Client('ana'); // admin
const rhea = new Client('rhea'); // staff
const anon = new Client('anon');

section('Health');
{
  const h = await anon.get('/api/health');
  check('health responds', h.status === 200 && h.data.ok === true, h);
  check('API responses are not cached', h.headers.get('cache-control') === 'no-store');
}

section('Password sign-in (browser PBKDF2 + Worker HMAC)');
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; // unique per test run
const createdEmails = [];
{
  const email = `smoke-${run}@example.com`;
  const ghostEmail = `ghost-${run}@example.com`;
  const pw1 = 'first-Password-2026';
  const pw2 = 'second-Password-2026';
  const player = new Client('smoke-player');
  const keys = (o) => Object.keys(o ?? {}).sort().join(',');

  // Salt: the same shape whether or not the account exists.
  const ghost = await anon.post('/api/auth/salt', { email: ghostEmail });
  check('salt for an unknown email → 200 {iterations, salt, scheme}', ghost.status === 200 && keys(ghost.data) === 'iterations,salt,scheme', ghost.data);
  check('scheme client_pbkdf2_hmac_v1 with 600 000 iterations', ghost.data.scheme === 'client_pbkdf2_hmac_v1' && ghost.data.iterations === 600000, ghost.data);
  check('salt is 16 bytes, base64url', /^[A-Za-z0-9_-]{22}$/.test(ghost.data.salt ?? ''), ghost.data);
  const ghostAgain = await anon.post('/api/auth/salt', { email: `  GHOST-${run}@Example.com ` });
  check('unknown-email salt is stable (emails are normalized)', ghostAgain.data.salt === ghost.data.salt);
  const ghost2 = await anon.post('/api/auth/salt', { email: `ghost2-${run}@example.com` });
  check('different unknown emails get different salts', ghost2.data.salt !== ghost.data.salt);

  // Registration
  const creds = await newPasswordCredentials(pw1);
  const weak = await player.post('/api/auth/register', { name: 'Smoke Test', email, password: { ...creds, iterations: 100000 } });
  check('registration with fewer iterations → 422', weak.status === 422, weak.data);
  const plain = await anon.post('/api/auth/register', { name: 'Plain Text', email: `plain-${run}@example.com`, password: 'plaintext-password' });
  check('a plaintext password is refused → 422', plain.status === 422, plain.data);
  const reg = await player.post('/api/auth/register', { name: 'Smoke Test', email, password: creds });
  if (reg.status === 201) createdEmails.push(email);
  check('registration → 201 and signed in', reg.status === 201 && reg.data.user?.email === email, reg.data);
  const regJson = JSON.stringify(reg.data);
  check('registration response has no salt, hash or clientHash', !regJson.includes(creds.salt) && !regJson.includes(creds.clientHash) && !/password/i.test(regJson));

  const real = await anon.post('/api/auth/salt', { email });
  check('salt for a real account has the same shape', real.status === 200 && keys(real.data) === keys(ghost.data));
  check('real account returns its stored salt', real.data.salt === creds.salt);

  // Login
  const fresh = new Client('smoke-fresh');
  const ok = await fresh.login(email, pw1);
  check('login with the right password → 200', ok.status === 200 && ok.data.user.email === email);
  check('login response has no password fields', !/password|salt|clientHash/i.test(JSON.stringify(ok.data)));
  const bad = await anon.post('/api/auth/login', { email, clientHash: await anon.proof(email, 'wrong-password') });
  check('wrong password → 401 INVALID_CREDENTIALS', bad.status === 401 && bad.data.error.code === 'INVALID_CREDENTIALS', bad.data);
  const unknown = await anon.post('/api/auth/login', { email: ghostEmail, clientHash: await anon.proof(ghostEmail, pw1) });
  check('unknown email gets the same 401 and message', unknown.status === 401 && unknown.data.error.code === bad.data.error.code && unknown.data.error.message === bad.data.error.message);
  const legacy = await anon.post('/api/auth/login', { email, password: pw1 });
  check('the old plaintext login body is refused → 422', legacy.status === 422, legacy.data);
  const junk = await anon.post('/api/auth/login', { email, clientHash: 'not-a-hash' });
  check('malformed clientHash → 422', junk.status === 422, junk.data);

  // Change password
  const wrongCurrent = await fresh.post('/api/me/password', {
    currentClientHash: await fresh.proof(email, 'not-my-password'),
    newPassword: await newPasswordCredentials(pw2),
  });
  check('wrong current password → 422 on currentPassword', wrongCurrent.status === 422 && !!wrongCurrent.data.error.details?.currentPassword, wrongCurrent.data);
  const sameSalt = await fresh.post('/api/me/password', {
    currentClientHash: await fresh.proof(email, pw1),
    newPassword: { ...creds, clientHash: await deriveClientHash(pw2, creds.salt) },
  });
  check('reusing the old salt → 422', sameSalt.status === 422, sameSalt.data);
  const next = await newPasswordCredentials(pw2);
  const changed = await fresh.post('/api/me/password', { currentClientHash: await fresh.proof(email, pw1), newPassword: next });
  check('change password → 200', changed.status === 200, changed.data);
  const afterSalt = await anon.post('/api/auth/salt', { email });
  check('password change stores the new salt', afterSalt.data.salt === next.salt && next.salt !== creds.salt);
  const stale = await player.get('/api/auth/me');
  check('other sessions are signed out', stale.data.user === null);
  const still = await fresh.get('/api/auth/me');
  check('this session stays signed in', still.data.user?.email === email);
  const oldPw = await anon.post('/api/auth/login', { email, clientHash: await anon.proof(email, pw1) });
  check('old password no longer works → 401', oldPw.status === 401);
  const newPw = await new Client('smoke-new').login(email, pw2);
  check('login after password change → 200', newPw.status === 200);

  // Throttling (no permanent lockout): 8 failed sign-ins per email per 15 minutes, then 429.
  const target = `throttle-${run}@example.com`;
  const junkHash = 'A'.repeat(43);
  const statuses = [];
  for (let i = 0; i < 9; i++) statuses.push((await anon.post('/api/auth/login', { email: target, clientHash: junkHash })).status);
  check('8 failed sign-ins → 401, the 9th → 429', statuses.slice(0, 8).every((x) => x === 401) && statuses[8] === 429, statuses);
  const saltStatuses = [];
  for (let i = 0; i < 21; i++) saltStatuses.push((await anon.post('/api/auth/salt', { email: target })).status);
  check('salt lookups are throttled too (20 per email, then 429)', saltStatuses.slice(0, 20).every((x) => x === 200) && saltStatuses[20] === 429, saltStatuses);
}

if (AUTH_ONLY) {
  if (createdEmails.length) {
    const list = createdEmails.map((e) => `'${e}'`).join(', ');
    sql(`DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM users WHERE email IN (${list}));
DELETE FROM users WHERE email IN (${list});
DELETE FROM rate_limits WHERE key LIKE '%-${run}@%';`);
    console.log(`\n  (removed ${createdEmails.length} test account(s) from the ${REMOTE ? 'deployed' : 'local'} database)`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(`Failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(failed ? 1 : 0);
}

section('Seeded accounts');
{
  await juan.login('juan.delacruz@example.com');
  await pedro.login('pedro.cruz@example.com');
  await maria.login('maria.santos@example.com');
  await kim.login('kim.aquino@example.com');
  const a = await ana.login('ana.reyes@lespinners.example', PASSWORD, 'admin');
  check('admin can sign in at the admin portal', a.data.user.role === 'admin' && a.data.home === '/admin/');
  const r = await rhea.login('rhea.lim@lespinners.example', PASSWORD, 'staff');
  check('staff can sign in at the staff portal', r.data.user.role === 'staff' && r.data.home === '/staff/');
  check('session cookie is HttpOnly + SameSite=Lax', /HttpOnly/i.test(a.headers.get('set-cookie') ?? '') && /SameSite=Lax/i.test(a.headers.get('set-cookie') ?? ''));
  check('seeded admin signs in with the demo password', a.status === 200);

  const me = await juan.get('/api/auth/me');
  check('me returns the signed-in player', me.data.user?.email === 'juan.delacruz@example.com' && me.data.user.membership === 'member');
  const anonMe = await anon.get('/api/auth/me');
  check('me without a session is null', anonMe.status === 200 && anonMe.data.user === null);

  const crossSite = await juan.post('/api/bookings', { resourceId: 'court-1', date: localDate(3), start: 1080 }, { origin: 'https://evil.example' });
  check('cross-site POST is blocked (BAD_ORIGIN)', crossSite.status === 403 && crossSite.data.error.code === 'BAD_ORIGIN', crossSite.data);

  const unauth = await anon.get('/api/bookings');
  check('bookings need sign-in → 401', unauth.status === 401);
  const playerAdmin = await juan.get('/api/admin/summary');
  check('player on an admin endpoint → 403', playerAdmin.status === 403);
  const playerSettings = await juan.put('/api/admin/settings', { gcashNumber: '0917 000 0000' });
  check('player cannot change settings → 403', playerSettings.status === 403);
}

section('Role-based sign-in (each account only through its own portal)');
{
  resetSignInLimits();
  const accounts = {
    user: 'juan.delacruz@example.com',
    staff: 'rhea.lim@lespinners.example',
    admin: 'ana.reyes@lespinners.example',
  };
  for (const [role, email] of Object.entries(accounts)) {
    for (const portal of ['user', 'staff', 'admin']) {
      const c = new Client(`matrix-${role}-${portal}`);
      const res = await c.post(`/api/auth/${portal}/login`, { email, clientHash: await c.proof(email) });
      const cookie = res.headers.get('set-cookie') ?? '';
      if (role === portal) {
        check(`${role} account → ${portal} portal: allowed`, res.status === 200 && res.data.user.email === email && /ls_session=[^;]+/.test(cookie), res.data);
      } else {
        check(`${role} account → ${portal} portal: denied, no session`, res.status === 401 && res.data.error.code === 'INVALID_CREDENTIALS' && !/ls_session=[^;]+/.test(cookie), res.data);
        const me = await c.get('/api/auth/session');
        check('  …and the browser stays signed out', me.data.user === null);
      }
    }
  }
  // A wrong-portal attempt looks exactly like a wrong password.
  const wrongPw = await anon.post('/api/auth/staff/login', { email: accounts.staff, clientHash: await anon.proof(accounts.staff, 'not-the-password') });
  const wrongPortal = await anon.post('/api/auth/staff/login', { email: accounts.admin, clientHash: await anon.proof(accounts.admin) });
  check('wrong portal and wrong password give the same status, code and message',
    wrongPw.status === wrongPortal.status && wrongPw.data.error.code === wrongPortal.data.error.code && wrongPw.data.error.message === wrongPortal.data.error.message);
  const legacy = await anon.post('/api/auth/login', { email: accounts.admin, clientHash: await anon.proof(accounts.admin) });
  check('the original /api/auth/login is the player portal (admin denied)', legacy.status === 401);
  const legacyPlayer = await new Client('legacy').post('/api/auth/login', { email: accounts.user, clientHash: await anon.proof(accounts.user) });
  check('the original /api/auth/login still signs players in', legacyPlayer.status === 200);
  const forged = await anon.post('/api/auth/user/login', { email: accounts.admin, clientHash: await anon.proof(accounts.admin), role: 'player' });
  check('a role in the request body is ignored', forged.status === 401);

  // A denied attempt never replaces the session already in the browser.
  const keep = new Client('keep');
  await keep.login(accounts.user);
  const denied = await keep.post('/api/auth/admin/login', { email: accounts.staff, clientHash: await keep.proof(accounts.staff) });
  const still = await keep.get('/api/auth/session');
  check('denied sign-in keeps the existing player session', denied.status === 401 && still.data.user?.email === accounts.user, still.data);

  const sess = await rhea.get('/api/auth/session');
  check('session reports the role and its dashboard', sess.data.user?.role === 'staff' && sess.data.home === '/staff/', sess.data);
}

section('API authorization by role');
{
  const expect = async (name, client, method, path, status, json) => {
    const res = await client.req(method, path, json !== undefined ? { json } : {});
    check(`${name} → ${status}`, res.status === status, `${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
    return res;
  };
  // No session
  await expect('anonymous on /api/staff/summary', anon, 'GET', '/api/staff/summary', 401);
  await expect('anonymous on /api/admin/summary', anon, 'GET', '/api/admin/summary', 401);
  // Players
  await expect('player on /api/staff/dashboard', juan, 'GET', '/api/staff/dashboard', 403);
  await expect('player on /api/staff/bookings', juan, 'GET', '/api/staff/bookings', 403);
  await expect('player approving through /api/staff', juan, 'POST', '/api/staff/bookings/b_maria/approve', 403, {});
  await expect('player rejecting through /api/staff', juan, 'POST', '/api/staff/bookings/b_maria/reject', 403, { reason: 'Nope nope' });
  await expect('player adding a court', juan, 'POST', '/api/staff/facilities', 403, { activity: 'pickleball', name: 'Hacker Court' });
  // Staff: operations yes, admin namespace no
  await expect('staff on /api/staff/dashboard', rhea, 'GET', '/api/staff/dashboard', 200);
  await expect('staff on /api/staff/bookings', rhea, 'GET', '/api/staff/bookings', 200);
  await expect('staff on /api/staff/rules', rhea, 'GET', '/api/staff/rules', 200);
  await expect('staff on /api/admin/summary', rhea, 'GET', '/api/admin/summary', 403);
  await expect('staff reading /api/admin/settings', rhea, 'GET', '/api/admin/settings', 403);
  await expect('staff changing settings', rhea, 'PUT', '/api/admin/settings', 403, { gcashNumber: '0917 000 0000' });
  await expect('staff reading the outbox', rhea, 'GET', '/api/admin/outbox', 403);
  await expect('staff changing prices (admin endpoint)', rhea, 'PATCH', '/api/admin/resources/court-1', 403, { priceMember: 1 });
  await expect('staff changing prices (staff endpoint)', rhea, 'PATCH', '/api/staff/facilities/court-1', 403, { priceMember: 1 });
  await expect('staff on player booking endpoints', rhea, 'GET', '/api/bookings', 403);
  await expect('staff creating a hold', rhea, 'POST', '/api/bookings', 403, { resourceId: 'court-1', date: localDate(4), start: 1080 });
  await expect('staff on the player inbox', rhea, 'GET', '/api/notifications', 403);
  const rules = await rhea.get('/api/staff/rules');
  check('staff rules carry no alert recipients', !JSON.stringify(rules.data).includes('@') && typeof rules.data.alerts.emailRecipients === 'number', rules.data);
  // Admin keeps everything
  await expect('admin on /api/staff/summary', ana, 'GET', '/api/staff/summary', 200);
  await expect('admin on /api/admin/summary', ana, 'GET', '/api/admin/summary', 200);
  await expect('admin on /api/admin/settings', ana, 'GET', '/api/admin/settings', 200);
  await expect('admin on player booking endpoints', ana, 'GET', '/api/bookings', 403);
  // Shared: own profile, no self-promotion
  await expect('staff reads own profile', rhea, 'GET', '/api/me', 200);
  const promote = await rhea.req('PATCH', '/api/me', { json: { name: 'Rhea Lim', role: 'admin' } });
  check('profile update ignores a role field', promote.status === 200 && promote.data.user.role === 'staff', promote.data);
  const after = sql(`SELECT role FROM users WHERE email = 'rhea.lim@lespinners.example';`)[0].results[0];
  check('staff role unchanged in the database', after.role === 'staff', after);
  const forbiddenLogged = sql(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'forbidden_access';`)[0].results[0];
  check('forbidden attempts are audited', forbiddenLogged.n > 0, forbiddenLogged);
}

section('Facility and availability (privacy)');
const D = localDate(6);
let slotA;
{
  const pub = await anon.get('/api/facility');
  check('facility info is public', pub.status === 200 && pub.data.resources.length >= 6, pub.data);
  check('GCash details hidden when signed out', pub.data.gcash === null);
  const f = await juan.get('/api/facility');
  check('GCash details shown when signed in', f.data.gcash?.number === '0917 123 4567');

  const day = await pedro.get(`/api/availability?activity=pickleball&date=${D}`);
  check('availability loads', day.status === 200 && day.data.resources.length > 0, day.data);
  const text = JSON.stringify(day.data);
  check('availability has no names or emails', !/Maria|Pedro|Juan|Kim|Santos|@/.test(text));
  check('non-member sees the non-member rate', day.data.resources[0].price === 60000, day.data.resources[0]);
  const jd = await juan.get(`/api/availability?activity=pickleball&date=${D}`);
  check('member sees the member rate', jd.data.resources[0].price === 50000);
  slotA = findSlot(day.data, 'court-1');
  check('found an available Court 1 slot', Boolean(slotA));

  const past = await juan.get(`/api/availability?activity=pickleball&date=${localDate(-1)}`);
  check('past dates are refused', past.status === 422 && past.data.error.code === 'DATE_PAST');
  const far = await juan.get(`/api/availability?activity=pickleball&date=${localDate(20)}`);
  check('dates beyond 14 days are refused', far.status === 422 && far.data.error.code === 'OUTSIDE_WINDOW');
  const days = await juan.get('/api/availability/days?activity=table_tennis');
  check('date strip has 15 days', days.data.days?.length === 15, days.data);

  const maint = await juan.get(`/api/availability?activity=pickleball&date=${localDate(1)}`);
  const c3 = maint.data.resources.find((r) => r.id === 'court-3');
  check('Court 3 shows maintenance', c3?.status === 'maintenance' && c3.slots.every((s) => s.state === 'maintenance' || s.state === 'past'), c3);
  const holdMaint = await juan.post('/api/bookings', { resourceId: 'court-3', date: localDate(1), start: c3?.slots.at(-1)?.start ?? 1260 });
  check('cannot book a court under maintenance', holdMaint.status === 422 && holdMaint.data.error.code === 'MAINTENANCE', holdMaint.data);
}

section('Temporary holds and double booking');
let juanBooking;
{
  const r = await juan.post('/api/bookings', { resourceId: 'court-1', date: D, start: slotA.start, status: 'CONFIRMED', amountDue: 1 });
  juanBooking = r.data.booking;
  check('hold created → 201 TEMPORARY', r.status === 201 && juanBooking?.status === 'TEMPORARY', r.data);
  check('client cannot set status or amount', juanBooking?.amountDue === 50000);
  const left = (juanBooking?.holdExpiresAt ?? 0) - r.data.now;
  check('hold lasts 10 minutes', left > 9.5 * 60_000 && left <= 10 * 60_000, left);
  check('payment info returned while holding', r.data.payment?.gcashNumber === '0917 123 4567');
  check('reference looks like LS-YYYYMMDD-NNN', /^LS-\d{8}-\d{3}$/.test(juanBooking?.ref ?? ''), juanBooking?.ref);

  const clash = await pedro.post('/api/bookings', { resourceId: 'court-1', date: D, start: slotA.start });
  check('same slot for another player → 409 SLOT_TAKEN', clash.status === 409 && clash.data.error.code === 'SLOT_TAKEN', clash.data);
  check('conflict offers alternatives', Array.isArray(clash.data.error.details?.alternatives) && clash.data.error.details.alternatives.length > 0, clash.data.error);
  check('conflict does not reveal who holds it', !/Juan|juan/.test(JSON.stringify(clash.data)));

  const pv = await pedro.get(`/api/availability?activity=pickleball&date=${D}`);
  check('others see "held"', findSlot(pv.data, 'court-1', 'held')?.start === slotA.start);
  const jv = await juan.get(`/api/availability?activity=pickleball&date=${D}`);
  const mine = jv.data.resources.find((x) => x.id === 'court-1').slots.find((s) => s.start === slotA.start);
  check('owner sees "mine"', mine?.state === 'mine' && mine.booking?.id === juanBooking.id, mine);

  const overlap = await juan.post('/api/bookings', { resourceId: 'court-2', date: D, start: slotA.start });
  check('own overlapping booking → 422 OVERLAP_OWN', overlap.status === 422 && overlap.data.error.code === 'OVERLAP_OWN', overlap.data);

  const second = await juan.post('/api/bookings', { resourceId: 'court-2', date: D, start: slotA.start + 60 });
  check('second hold allowed', second.status === 201, second.data);
  const third = await juan.post('/api/bookings', { resourceId: 'court-2', date: D, start: slotA.start + 120 });
  check('third open hold → 422 TOO_MANY_HOLDS', third.status === 422 && third.data.error.code === 'TOO_MANY_HOLDS', third.data);
  const rel = await juan.post(`/api/bookings/${second.data.booking.id}/release`, {});
  check('player can release a hold', rel.status === 200 && rel.data.booking.status === 'CANCELLED', rel.data);

  // Race: several players grab the same fresh slot at the same moment.
  const freeSlot = findSlot(pv.data, 'court-2', 'available', [slotA.start, slotA.start + 60]);
  const racers = [pedro, maria, kim];
  const results = await Promise.all(racers.map((p) => p.post('/api/bookings', { resourceId: 'court-2', date: D, start: freeSlot.start })));
  const wins = results.filter((x) => x.status === 201);
  check('race: exactly one player wins the slot', wins.length === 1, results.map((x) => x.status));
  for (const [i, x] of results.entries()) if (x.status === 201) await racers[i].post(`/api/bookings/${x.data.booking.id}/release`, {});
}

section('Several times in one booking (gaps allowed, no limit)');
{
  const MD = localDate(12);
  const openOn = async (client, activity, id) => {
    const res = await client.get(`/api/availability?activity=${activity}&date=${MD}`);
    return res.data.resources.find((x) => x.id === id).slots.filter((s) => s.state === 'available').map((s) => s.start);
  };
  const open = await openOn(pedro, 'pickleball', 'court-1');
  check('Court 1 has at least 4 open slots that day', open.length >= 4, open);
  const [o0, o1, o2, o3] = open;
  const facility = await pedro.get('/api/facility');
  check('no "how long" limit in the rules any more', facility.data.rules && !('maxSlots' in facility.data.rules), facility.data.rules);

  const empty = await pedro.post('/api/bookings', { resourceId: 'court-1', date: MD, starts: [] });
  check('no times picked → 422', empty.status === 422, empty.data);
  const offGrid = await pedro.post('/api/bookings', { resourceId: 'court-1', date: MD, starts: [o0, o0 + 30] });
  check('a time off the slot grid → 422 INVALID_SLOT', offGrid.status === 422 && offGrid.data.error.code === 'INVALID_SLOT', offGrid.data);

  // Two slots back to back, then a gap, then one more.
  const gap = await pedro.post('/api/bookings', { resourceId: 'court-1', date: MD, starts: [o3, o0, o1] });
  const g = gap.data.booking;
  check('booking with a gap → 201 TEMPORARY', gap.status === 201 && g?.status === 'TEMPORARY', gap.data);
  check('back-to-back slots merge, the gap stays out', JSON.stringify(g?.segments) === JSON.stringify([{ start: o0, end: o1 + 60 }, { start: o3, end: o3 + 60 }]), g?.segments);
  check('span covers first start to last end', g?.start === o0 && g?.end === o3 + 60, { start: g?.start, end: g?.end });
  check('price is per slot (3 × ₱600)', g?.amountDue === 180000, g?.amountDue);
  check('duration counts booked time only (3 hours)', g?.durationMin === 180 && g?.durationLabel === '3 hours', { min: g?.durationMin, label: g?.durationLabel });
  check('time label lists both ranges', (g?.timeLabel ?? '').includes(', '), g?.timeLabel);
  const pn = await pedro.get('/api/notifications');
  check('player notice lists every time', pn.data.notifications.some((n) => n.type === 'hold_created' && n.body.includes(', ')), pn.data.notifications.map((n) => n.body));

  const mv = await openOn(maria, 'pickleball', 'court-1');
  check('others no longer see the booked slots as open', ![o0, o1, o3].some((s) => mv.includes(s)), mv);
  check('the gap stays open for others', mv.includes(o2), mv);
  const mday = await maria.get(`/api/availability?activity=pickleball&date=${MD}`);
  const ms = mday.data.resources.find((x) => x.id === 'court-1').slots;
  check('others see the booked slots "held"', [o0, o1, o3].every((s) => ms.find((x) => x.start === s)?.state === 'held'), ms);

  const sched = await ana.get(`/api/admin/schedule?date=${MD}&activity=pickleball`);
  const ss = sched.data.resources.find((x) => x.id === 'court-1').slots;
  check('staff grid shows the booking on its slots only', [o0, o1, o3].every((s) => ss.find((x) => x.start === s)?.booking?.id === g.id) && !ss.find((x) => x.start === o2)?.booking, ss.map((x) => [x.start, x.booking?.id ?? null]));

  // A closure inside the gap doesn't touch the booking; one on a booked slot does.
  const inGap = await rhea.post('/api/staff/availability/closures', { date: MD, resourceId: 'court-1', start: o2, end: o2 + 60, reason: 'Net repair' });
  check('closing only the gap → 201, no affected bookings', inGap.status === 201 && inGap.data.affected?.length === 0, inGap.data);
  if (inGap.status === 201) {
    const del = await rhea.req('DELETE', `/api/staff/availability/closures/${inGap.data.id}`, { json: {} });
    check('gap closure removed again', del.status === 200, del.data);
  }
  const onSlot = await rhea.post('/api/staff/availability/closures', { date: MD, resourceId: 'court-1', start: o3, end: o3 + 60, reason: 'Net repair' });
  check('closing a booked slot → 409 lists the booking', onSlot.status === 409 && onSlot.data.error.details?.affected?.some((x) => x.id === g.id), onSlot.data);
  check('affected list shows every booked range', onSlot.data.error?.details?.affected?.find((x) => x.id === g.id)?.timeLabel?.includes(', '), onSlot.data.error?.details?.affected);

  // The gap can be booked by someone else; the booked slots can't.
  const inTheGap = await maria.post('/api/bookings', { resourceId: 'court-1', date: MD, starts: [o2] });
  check('another player can book the gap → 201', inTheGap.status === 201, inTheGap.data);
  if (inTheGap.status === 201) await maria.post(`/api/bookings/${inTheGap.data.booking.id}/release`, {});
  const taken = await maria.post('/api/bookings', { resourceId: 'court-1', date: MD, starts: [o2, o3] });
  check('picking a booked slot among others → 409 SLOT_TAKEN', taken.status === 409 && taken.data.error.code === 'SLOT_TAKEN', taken.data);
  const alts = taken.data.error?.details?.alternatives ?? [];
  check('alternatives are full picks with every time', alts.length > 0 && alts.every((a) => Array.isArray(a.starts) && a.starts.length >= 1), alts);
  check('offers the times still open on Court 1', alts.some((a) => a.resourceId === 'court-1' && JSON.stringify(a.starts) === JSON.stringify([o2])), alts);
  check('alternatives never include a taken slot', alts.every((a) => a.resourceId !== 'court-1' || !a.starts.some((s) => [o0, o1, o3].includes(s))), alts);

  // No limit on how many: every open slot on another court in one booking.
  const all = await openOn(maria, 'pickleball', 'court-2');
  const big = await maria.post('/api/bookings', { resourceId: 'court-2', date: MD, starts: all });
  check(`all ${all.length} open slots in one booking → 201`, big.status === 201 && big.data.booking?.durationMin === all.length * 60, big.data);
  check('price × every slot', big.data.booking?.amountDue === all.length * 50000, big.data.booking?.amountDue);
  if (big.status === 201) await maria.post(`/api/bookings/${big.data.booking.id}/release`, {});

  // Older clients send start + slots (in a row).
  const t = await openOn(juan, 'table_tennis', 'table-1');
  const legacy = await juan.post('/api/bookings', { resourceId: 'table-1', date: MD, start: t[0], slots: 2 });
  check('start + slots still books slots in a row', legacy.status === 201 && legacy.data.booking?.end === t[0] + 120 && legacy.data.booking?.segments?.length === 1, legacy.data);
  if (legacy.status === 201) await juan.post(`/api/bookings/${legacy.data.booking.id}/release`, {});

  const rel = await pedro.post(`/api/bookings/${g.id}/release`, {});
  check('a booking with gaps can be released', rel.status === 200 && rel.data.booking.status === 'CANCELLED', rel.data);
  const after = await openOn(maria, 'pickleball', 'court-1');
  check('releasing frees every booked slot', [o0, o1, o3].every((s) => after.includes(s)), after);
}

section('Other players cannot see or touch this booking');
{
  const peek = await pedro.get(`/api/bookings/${juanBooking.id}`);
  check("another player's booking → 404", peek.status === 404);
  const chat = await pedro.get(`/api/bookings/${juanBooking.id}/messages`);
  check("another player's chat → 404", chat.status === 404);
  const post = await pedro.post(`/api/bookings/${juanBooking.id}/messages`, { body: 'hello' });
  check("cannot post in another player's chat → 404", post.status === 404);
  const upload = await pedro.req('POST', `/api/bookings/${juanBooking.id}/proof`, { form: proofForm(pngFile('x.png', readFileSync(join(ROOT, 'db/seed-proofs/pedro.png')))) });
  check("cannot upload proof to another player's booking → 404", upload.status === 404);
  const release = await pedro.post(`/api/bookings/${juanBooking.id}/release`, {});
  check("cannot release another player's hold → 404", release.status === 404);
  const list = await pedro.get('/api/bookings');
  check("another player's bookings are not listed", !list.data.bookings.some((b) => b.id === juanBooking.id));
  const patch = await juan.req('PATCH', `/api/bookings/${juanBooking.id}`, { json: { status: 'CONFIRMED' } });
  check('no endpoint lets a player set status', patch.status === 404);
}

section('Payment proof upload');
let juanProofUrl;
{
  const path = `/api/bookings/${juanBooking.id}/proof`;
  const fake = await juan.req('POST', path, { form: proofForm(pngFile('receipt.png', new TextEncoder().encode('<script>alert(1)</script>'))) });
  check('text disguised as .png → 422 UNSUPPORTED_FILE_TYPE', fake.status === 422 && fake.data.error.code === 'UNSUPPORTED_FILE_TYPE', fake.data);
  const pdf = await juan.req('POST', path, { form: proofForm(pngFile('receipt.pdf', new TextEncoder().encode('%PDF-1.7 fake'), 'application/pdf')) });
  check('PDF → 422', pdf.status === 422);
  const empty = await juan.req('POST', path, { form: proofForm(pngFile('empty.png', new Uint8Array(0))) });
  check('empty file → 422', empty.status === 422, empty.data);
  const none = await juan.req('POST', path, { form: proofForm(null, { gcashRef: '123' }) });
  check('missing file → 422 FILE_REQUIRED', none.status === 422 && none.data.error.code === 'FILE_REQUIRED', none.data);
  const big = new Uint8Array(10 * 1024 * 1024 + 20);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const tooBig = await juan.req('POST', path, { form: proofForm(pngFile('big.png', big)) });
  check('over 10 MB → 413 FILE_TOO_LARGE', tooBig.status === 413 && tooBig.data.error?.code === 'FILE_TOO_LARGE', tooBig.status);
  const badAmount = await juan.req('POST', path, { form: proofForm(pngFile('r.png', readFileSync(join(ROOT, 'db/seed-proofs/juan.png'))), { amountPesos: 'five hundred' }) });
  check('bad amount → 422 with a field message', badAmount.status === 422 && badAmount.data.error.details?.amountPesos, badAmount.data);

  const ok = await juan.req('POST', path, {
    form: proofForm(pngFile('gcash.png', dirtyPng(readFileSync(join(ROOT, 'db/seed-proofs/juan.png')))), { gcashRef: '1234 567 89', amountPesos: '₱500.00' }),
  });
  check('valid screenshot → 201 PAYMENT_SUBMITTED', ok.status === 201 && ok.data.booking?.status === 'PAYMENT_SUBMITTED', ok.data);
  check('timer stops (no hold expiry)', ok.data.booking?.holdExpiresAt === null);
  check('amount stored in centavos', ok.data.proofs?.[0]?.amountClaimed === 50000, ok.data.proofs);
  check('timeline says "Payment proof submitted"', ok.data.timeline?.some((e) => e.label === 'Payment proof submitted'));
  juanProofUrl = ok.data.proofs?.[0]?.url;
  check('proof comes with a signed link', /^\/api\/files\/proofs\/p_[\w-]+\?exp=\d+&sig=[\w-]+$/.test(juanProofUrl ?? ''), juanProofUrl);

  const again = await juan.req('POST', path, { form: proofForm(pngFile('gcash.png', readFileSync(join(ROOT, 'db/seed-proofs/juan.png')))) });
  check('second upload → 409 ALREADY_SUBMITTED', again.status === 409 && again.data.error.code === 'ALREADY_SUBMITTED', again.data);

  const pv = await pedro.get(`/api/availability?activity=pickleball&date=${D}`);
  const s = pv.data.resources.find((x) => x.id === 'court-1').slots.find((x) => x.start === slotA.start);
  check('others now see "unavailable" (not who is paying)', s?.state === 'unavailable', s);

  const notes = await juan.get('/api/notifications');
  check('player notified "Payment proof submitted"', notes.data.notifications.some((n) => n.title === 'Payment proof submitted' && n.body.startsWith('Waiting for admin verification')));
}

section('Private proof links');
{
  const own = await juan.get(juanProofUrl);
  check('owner can view the screenshot', own.status === 200 && own.headers.get('content-type') === 'image/png', own.status);
  check('screenshot is never cached', own.headers.get('cache-control') === 'private, no-store');
  const png = Buffer.from(own.data);
  const pngLeft = hasAny(png, ['PngTextTag', 'PngExifTag', 'caBX', 'c2pa', 'tEXt', 'tIME', 'PngPrivateTag', 'PngTrailerTag']);
  check('stored PNG has no text, EXIF, C2PA, private chunks or trailing bytes', pngLeft.length === 0, pngLeft);
  check('stored PNG still has its image data and ends with IEND', png.includes(bin('IDAT')) && png.subarray(-8, -4).toString('latin1') === 'IEND');
  const other = await pedro.get(juanProofUrl);
  check('another player with the same link → 404', other.status === 404, other.status);
  const noSession = await anon.get(juanProofUrl);
  check('link without a session → 401', noSession.status === 401);
  const tampered = await juan.get(juanProofUrl.replace(/sig=[\w-]{4}/, 'sig=AAAA'));
  check('tampered signature → 403', tampered.status === 403, tampered.status);
  const id = /proofs\/([^?]+)/.exec(juanProofUrl)[1];
  const expired = await juan.get(`/api/files/proofs/${id}?exp=${Date.now() - 1000}&sig=abc`);
  check('expired link → 403 LINK_EXPIRED', expired.status === 403 && expired.data.error.code === 'LINK_EXPIRED');
  const staff = await ana.get(juanProofUrl);
  check('staff can view the screenshot', staff.status === 200);

  // Metadata stripping: a phone-style JPEG (camera + GPS EXIF, MPF, C2PA, a
  // second image after the end marker) comes back with only what draws it.
  const mh = await maria.get(`/api/availability?activity=table_tennis&date=${D}`);
  const t = findSlot(mh.data, 'table-2');
  const hold = await maria.post('/api/bookings', { resourceId: 'table-2', date: D, start: t.start });
  const jpeg = dirtyJpeg(readFileSync(join(ROOT, 'tests/fixtures/exif-sample.jpg')));
  check('fixture has EXIF with GPS', jpeg.includes(bin('Exif')) && jpeg.includes(bin('TestCam')));
  const up = await maria.req('POST', `/api/bookings/${hold.data.booking.id}/proof`, { form: proofForm(pngFile('photo.jpg', jpeg, 'image/jpeg'), { amountPesos: '250' }) });
  check('JPEG accepted', up.status === 201, up.data);
  const stored = await maria.get(up.data.proofs[0].url);
  const storedBuf = Buffer.from(stored.data);
  const jpegLeft = hasAny(storedBuf, ['Exif', 'TestCam', 'JpegMpfTag', 'c2pa', 'JpegDuckyTag', 'JpegCommentTag', 'JpegTrailerCamTag']);
  check('stored JPEG has no EXIF, GPS, MPF, C2PA, maker data, comment or trailing image', stored.status === 200 && jpegLeft.length === 0, jpegLeft);
  check('stored JPEG keeps its colour profile and Adobe flag', storedBuf.includes(bin('KeepIccTag')) && storedBuf.includes(bin('Adobe')));
  check('stored JPEG is still a whole JPEG', storedBuf[0] === 0xff && storedBuf[1] === 0xd8 && storedBuf.at(-2) === 0xff && storedBuf.at(-1) === 0xd9);

  // Same for WebP (on another day, so it can't overlap Kim's hold in the expiry test).
  const KD = localDate(9);
  const kh = await kim.get(`/api/availability?activity=table_tennis&date=${KD}`);
  const kt = findSlot(kh.data, 'table-1');
  const khold = await kim.post('/api/bookings', { resourceId: 'table-1', date: KD, start: kt.start });
  const wup = await kim.req('POST', `/api/bookings/${khold.data.booking.id}/proof`, { form: proofForm(pngFile('shot.webp', dirtyWebp(), 'image/webp'), { amountPesos: '250' }) });
  check('WebP accepted', wup.status === 201, wup.data);
  const wstored = await kim.get(wup.data.proofs[0].url);
  const webp = Buffer.from(wstored.data);
  const webpLeft = hasAny(webp, ['WebpExifTag', 'WebpXmpTag', 'c2pa', 'WebpPrivateTag', 'WebpTrailerTag']);
  check('stored WebP has no EXIF, XMP, C2PA, private chunks or trailing bytes', wstored.headers.get('content-type') === 'image/webp' && webpLeft.length === 0, webpLeft);
  check('stored WebP is a well-formed container with its image data', webp.readUInt32LE(4) === webp.length - 8 && (webp[20] & 0x0c) === 0 && webp.includes(bin('ALPH')) && webp.includes(bin('VP8 ')));
}

section('Staff verification');
{
  const sum = await ana.get('/api/admin/summary');
  check('dashboard loads', sum.status === 200, sum.data);
  const item = sum.data.verification.find((v) => v.id === juanBooking.id);
  check('booking is in the verification queue', Boolean(item));
  check('queue shows amount check "match"', item?.proof?.amountCheck === 'match', item?.proof);
  const pedroItem = sum.data.verification.find((v) => v.ref.endsWith('-906'));
  check('seeded Pedro proof flagged "differs"', pedroItem?.proof?.amountCheck === 'differs', pedroItem?.proof);
  check('staff see player names', item?.user?.name === 'Juan Dela Cruz');

  const detail = await ana.get(`/api/admin/bookings/${juanBooking.id}`);
  check('staff detail has the proof link', detail.data.proofs?.[0]?.url?.startsWith('/api/files/proofs/'), detail.data);
  check('staff detail offers approve/reject', detail.data.actions?.canApprove && detail.data.actions?.canReject);

  const noReason = await ana.post(`/api/admin/bookings/${juanBooking.id}/reject`, { reason: '' });
  check('reject without a reason → 422', noReason.status === 422 && noReason.data.error.details?.reason, noReason.data);

  const unchecked = await ana.post(`/api/admin/bookings/${juanBooking.id}/approve`, {});
  check('approve without the checklist → 422', unchecked.status === 422 && unchecked.data.error.details?.checklist, unchecked.data);
  const halfChecked = await ana.post(`/api/admin/bookings/${juanBooking.id}/approve`, { checklist: false });
  check('approve with the checklist unticked → 422', halfChecked.status === 422, halfChecked.data);
  const ok = await ana.post(`/api/admin/bookings/${juanBooking.id}/approve`, { checklist: true, proofId: detail.data.proofs[0].id });
  check('approve → CONFIRMED', ok.status === 200 && ok.data.booking.status === 'CONFIRMED', ok.data);
  check('records who approved', ok.data.booking.confirmedBy === 'Ana Reyes');
  check('online booking is marked "Online"', ok.data.booking.bookedBy?.source === 'online' && ok.data.booking.bookedBy?.name === null, ok.data.booking.bookedBy);
  const twice = await ana.post(`/api/admin/bookings/${juanBooking.id}/approve`, { checklist: true, proofId: detail.data.proofs[0].id });
  check('approving twice → 409 INVALID_STATUS', twice.status === 409 && twice.data.error.code === 'INVALID_STATUS');

  const jb = await juan.get(`/api/bookings/${juanBooking.id}`);
  check('player sees CONFIRMED', jb.data.booking.status === 'CONFIRMED');
  check('player timeline hides staff names', !JSON.stringify(jb.data.timeline).includes('Ana'), jb.data.timeline);
  const notes = await juan.get('/api/notifications');
  check('player notified "Payment verified"', notes.data.notifications.some((n) => n.type === 'payment_verified' && n.title === 'Payment verified'));
  const pv = await pedro.get(`/api/availability?activity=pickleball&date=${D}`);
  check('others see "booked"', pv.data.resources.find((x) => x.id === 'court-1').slots.find((x) => x.start === slotA.start)?.state === 'booked');
}

section('Reject, resubmit, reject and release');
{
  const pv = await pedro.get(`/api/availability?activity=table_tennis&date=${D}`);
  const s = findSlot(pv.data, 'table-3');
  const hold = await pedro.post('/api/bookings', { resourceId: 'table-3', date: D, start: s.start });
  const id = hold.data.booking.id;
  const png = readFileSync(join(ROOT, 'db/seed-proofs/pedro.png'));
  await pedro.req('POST', `/api/bookings/${id}/proof`, { form: proofForm(pngFile('p.png', png), { amountPesos: '250' }) });
  const rej = await rhea.post(`/api/staff/bookings/${id}/reject`, { proofId: await latestProofId(rhea,id), reason: 'Amount does not match the booking total.', keepHold: true });
  check('staff reject with resubmit window → REJECTED', rej.status === 200 && rej.data.booking.status === 'REJECTED', rej.data);
  check('the rejection is recorded with the staff member', rej.data.booking.rejectedBy === 'Rhea Lim' && rej.data.timeline.some((e) => e.type === 'rejected' && e.actor === 'Rhea Lim'), rej.data.booking);
  const left = rej.data.booking.holdExpiresAt - rej.data.now;
  check('player gets 10 minutes to resubmit', left > 9.5 * 60_000 && left <= 10 * 60_000, left);
  const mine = await pedro.get(`/api/bookings/${id}`);
  check('player sees the reason', mine.data.booking.rejectReason === 'Amount does not match the booking total.');
  check('player can submit new proof', mine.data.booking.canSubmitProof === true);
  const other = await maria.get(`/api/availability?activity=table_tennis&date=${D}`);
  check('slot stays held during the resubmit window', other.data.resources.find((r) => r.id === 'table-3').slots.find((x) => x.start === s.start)?.state === 'held');
  const notes = await pedro.get('/api/notifications');
  check('player notified of the rejection', notes.data.notifications.some((n) => n.type === 'proof_rejected'));
  const chat = await pedro.get(`/api/bookings/${id}/messages`);
  check('reason posted in the booking chat', chat.data.messages.some((m) => m.sender === 'staff' && m.body.startsWith('Amount does not match')));

  const again = await pedro.req('POST', `/api/bookings/${id}/proof`, { form: proofForm(pngFile('p2.png', png), { amountPesos: '300' }) });
  check('resubmitted proof → PAYMENT_SUBMITTED', again.status === 201 && again.data.booking.status === 'PAYMENT_SUBMITTED', again.data);
  const noReason = await rhea.post(`/api/staff/bookings/${id}/reject`, { reason: '' });
  check('staff reject without a reason → 422', noReason.status === 422, noReason.data);
  const stillPending = await pedro.get(`/api/bookings/${id}`);
  check('…and the booking is still waiting for verification', stillPending.data.booking.status === 'PAYMENT_SUBMITTED');
  const staffProof = await rhea.get(stillPending.data.proofs[0].url);
  check('staff can view the payment screenshot', staffProof.status === 200);
  const otherPlayer = await juan.get(stillPending.data.proofs[0].url);
  check("another player can't view it", otherPlayer.status === 404);
  const rej2 = await ana.post(`/api/admin/bookings/${id}/reject`, { proofId: stillPending.data.proofs[0].id, reason: 'Screenshot is not readable.', keepHold: false });
  check('reject and release → EXPIRED', rej2.data.booking.status === 'EXPIRED', rej2.data);
  const free = await maria.get(`/api/availability?activity=table_tennis&date=${D}`);
  check('slot is free again', free.data.resources.find((r) => r.id === 'table-3').slots.find((x) => x.start === s.start)?.state === 'available');
}

section('Booking chat');
{
  const long = await juan.post(`/api/bookings/${juanBooking.id}/messages`, { body: 'x'.repeat(121) });
  check('message over 120 chars → 422', long.status === 422);
  const atLimit = await juan.post(`/api/bookings/${juanBooking.id}/messages`, { body: 'x'.repeat(120) });
  check('message of exactly 120 chars → 201', atLimit.status === 201, atLimit.data);
  const blank = await juan.post(`/api/bookings/${juanBooking.id}/messages`, { body: '   ' });
  check('blank message → 422', blank.status === 422);
  const sent = await juan.post(`/api/bookings/${juanBooking.id}/messages`, { body: 'Can I bring a guest? <b>hi</b>' });
  check('player message → 201', sent.status === 201, sent.data);
  check('message stored as plain text', sent.data.messages.at(-1)?.body === 'Can I bring a guest? <b>hi</b>');

  const inbox = await ana.get('/api/admin/messages');
  const conv = inbox.data.conversations.find((x) => x.bookingId === juanBooking.id);
  check('staff inbox shows the thread as unread', conv?.unread === 2, conv);
  const badges = await ana.get('/api/admin/badges');
  check('staff badge counts unread chats', badges.data.unreadChats >= 1, badges.data);
  const opened = await ana.get(`/api/admin/bookings/${juanBooking.id}/messages`);
  check('staff can open the thread', opened.status === 200 && opened.data.messages.some((m) => m.senderName === 'Juan Dela Cruz'));
  await new Promise((r) => setTimeout(r, 300));
  const inbox2 = await ana.get('/api/admin/messages');
  check('opening marks it read', inbox2.data.conversations.find((x) => x.bookingId === juanBooking.id)?.unread === 0);

  await ana.post(`/api/admin/bookings/${juanBooking.id}/messages`, { body: 'Yes, guests are welcome.' });
  const jb = await juan.get('/api/notifications/badges');
  check('player badge shows 1 unread chat', jb.data.chats === 1, jb.data);
  const jm = await juan.get(`/api/bookings/${juanBooking.id}/messages`);
  const staffMsg = jm.data.messages.find((m) => m.body === 'Yes, guests are welcome.');
  check('player sees "Ana · Le Spinners" (first name only)', staffMsg?.senderName === 'Ana · Le Spinners', staffMsg);
  await new Promise((r) => setTimeout(r, 300));
  const jb2 = await juan.get('/api/notifications/badges');
  check('reading clears the badge', jb2.data.chats === 0, jb2.data);
}

section('Expiry, warnings and cron');
{
  const kv = await kim.get(`/api/availability?activity=pickleball&date=${D}`);
  const s = findSlot(kv.data, 'court-2', 'available', []);
  const hold = await kim.post('/api/bookings', { resourceId: 'court-2', date: D, start: s.start });
  const id = hold.data.booking.id;
  sql(`UPDATE bookings SET hold_expires_at = ${Date.now() + 60_000} WHERE id = '${id}';`);
  check('cron endpoint runs', (await runCron()) === 200);
  const warned = await kim.get('/api/notifications');
  check('2-minute warning sent', warned.data.notifications.some((n) => n.type === 'hold_expiring' && n.title === 'Your temporary reservation will expire soon'), warned.data.notifications.map((n) => n.type));

  sql(`UPDATE bookings SET hold_expires_at = ${Date.now() - 1000} WHERE id = '${id}';`);
  const detail = await kim.get(`/api/bookings/${id}`);
  check('lapsed hold reads as EXPIRED even before cron', detail.data.booking.status === 'EXPIRED', detail.data.booking.status);
  const late = await kim.req('POST', `/api/bookings/${id}/proof`, { form: proofForm(pngFile('late.png', readFileSync(join(ROOT, 'db/seed-proofs/juan.png')))) });
  check('proof after expiry → 409 HOLD_EXPIRED', late.status === 409 && late.data.error.code === 'HOLD_EXPIRED', late.data);
  await runCron();
  const rows = sql(`SELECT status FROM bookings WHERE id = '${id}';`);
  check('cron marks it EXPIRED in the database', rows[0]?.results?.[0]?.status === 'EXPIRED', rows);
  const n = await kim.get('/api/notifications');
  check('player notified the booking expired', n.data.notifications.some((x) => x.type === 'booking_expired'));
  const free = await pedro.get(`/api/availability?activity=pickleball&date=${D}`);
  check('expired slot is available again', free.data.resources.find((r) => r.id === 'court-2').slots.find((x) => x.start === s.start)?.state === 'available');
  const again = await pedro.post('/api/bookings', { resourceId: 'court-2', date: D, start: s.start });
  check('someone else can now book it', again.status === 201, again.data);
  await pedro.post(`/api/bookings/${again.data.booking.id}/release`, {});
}

section('No cancellation once booked or paid');
{
  const confirmed = await juan.post(`/api/bookings/${juanBooking.id}/cancel`, { reason: 'Rain plans changed' });
  check('player cancelling a confirmed booking → 409 NOT_CANCELLABLE', confirmed.status === 409 && confirmed.data.error.code === 'NOT_CANCELLABLE', confirmed.data);
  const kept = await juan.get(`/api/bookings/${juanBooking.id}`);
  check('…the booking stays CONFIRMED and offers no cancel', kept.data.booking.status === 'CONFIRMED' && kept.data.booking.canCancel === false, kept.data.booking);
  const staffConfirmed = await ana.post(`/api/admin/bookings/${juanBooking.id}/cancel`, { reason: 'Testing the policy' });
  check('staff cancelling a confirmed booking → 409 NOT_CANCELLABLE', staffConfirmed.status === 409 && staffConfirmed.data.error.code === 'NOT_CANCELLABLE', staffConfirmed.data);
  const pending = await rhea.post('/api/staff/bookings/b_maria/cancel', { reason: 'Testing the policy' });
  check('staff cancelling a booking with submitted payment → 409', pending.status === 409 && pending.data.error.code === 'NOT_CANCELLABLE', pending.data);
  const detail = await ana.get(`/api/admin/bookings/${juanBooking.id}`);
  check('staff detail offers no cancel for a confirmed booking', detail.data.actions.canCancel === false, detail.data.actions);
  // A booking cancelled after payment before this policy (legacy data) is still reported apart in Revenue.
  sql(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = ${Date.now()}, cancel_reason = 'Legacy cancellation' WHERE id = '${juanBooking.id}';`);
}

section('Revenue (admin only)');
{
  const expect = async (name, client, path, status) => {
    const res = await client.get(path);
    check(`${name} → ${status}`, res.status === status, `${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
    return res;
  };
  await expect('anonymous on revenue summary', anon, '/api/admin/revenue/summary', 401);
  await expect('player on revenue summary', juan, '/api/admin/revenue/summary', 403);
  await expect('staff on revenue summary', rhea, '/api/admin/revenue/summary', 403);
  await expect('staff on the ledger', rhea, '/api/admin/revenue/ledger', 403);
  await expect('staff on the CSV export', rhea, '/api/admin/revenue/export', 403);
  await expect('no revenue under /api/staff', rhea, '/api/staff/revenue/summary', 404);

  // Facility-time boundaries, computed independently of the Worker.
  const today = localDate();
  const dayMs = (d) => Date.parse(`${d}T00:00:00Z`) - TZ_MS;
  const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const monday = shift(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const starts = { day: today, week: monday, month: `${today.slice(0, 7)}-01`, year: `${today.slice(0, 4)}-01-01` };
  const sqlSum = (from, to, statuses = "'CONFIRMED','COMPLETED'") =>
    sql(`SELECT COALESCE(SUM(amount_due),0) AS amt, COUNT(*) AS n FROM bookings WHERE status IN (${statuses}) AND payment_method != 'none' AND confirmed_at >= ${from} AND confirmed_at < ${to};`)[0].results[0];

  // Kim's seeded payment moves to 23:59 yesterday (facility time): yesterday, not today.
  const kimRow = sql(`SELECT confirmed_at, amount_due FROM bookings WHERE id = 'b_kim';`)[0].results[0];
  sql(`UPDATE bookings SET confirmed_at = ${dayMs(today) - 60_000} WHERE id = 'b_kim';`);
  const s = await expect('admin on revenue summary', ana, '/api/admin/revenue/summary', 200);
  const per = Object.fromEntries((s.data.periods ?? []).map((p) => [p.key, p]));
  check('four periods: day, week, month, year', ['day', 'week', 'month', 'year'].every((k) => per[k]), Object.keys(per));
  for (const [k, from] of Object.entries(starts)) {
    const want = sqlSum(dayMs(from), Date.now() + 60_000);
    check(`${k} total matches verified payments since ${from}`, per[k]?.collected === want.amt && per[k]?.payments === want.n, { got: per[k]?.collected, want });
  }
  check('a payment verified at 23:59 yesterday is not today', per.day.previous.full >= kimRow.amount_due && sqlSum(dayMs(today), Date.now() + 60_000).amt === per.day.collected, per.day);
  const weekStartsMonday = per.week.from === monday;
  check('weeks start on Monday', weekStartsMonday, per.week.from);
  const pendingSql = sql(`SELECT COALESCE(SUM(amount_due),0) AS amt, COUNT(*) AS n FROM bookings WHERE status = 'PAYMENT_SUBMITTED';`)[0].results[0];
  check('pending proofs are reported apart, never as revenue', s.data.pendingVerification.amount === pendingSql.amt && s.data.pendingVerification.count === pendingSql.n, s.data.pendingVerification);
  check('no NaN or Infinity in the comparisons', !/NaN|Infinity/.test(JSON.stringify(s.data)));
  check('a zero baseline gives no percentage', s.data.periods.every((p) => (p.previous.toDate === 0 ? p.change.pct === null : typeof p.change.pct === 'number')), s.data.periods.map((p) => p.change));
  check('a legacy cancelled-after-payment booking is not collected revenue', s.data.periods.find((p) => p.key === 'year').cancelledAfterPayment.count >= 1);
  sql(`UPDATE bookings SET confirmed_at = ${kimRow.confirmed_at} WHERE id = 'b_kim';`);

  // Reject → resubmit → approve: one booking, one payment, counted once.
  const before = (await ana.get('/api/admin/revenue/summary')).data.periods.find((p) => p.key === 'day');
  const pv = await pedro.get(`/api/availability?activity=table_tennis&date=${D}`);
  const slot = findSlot(pv.data, 'table-2');
  const hold = await pedro.post('/api/bookings', { resourceId: 'table-2', date: D, start: slot.start });
  const bid = hold.data.booking.id;
  const png = readFileSync(join(ROOT, 'db/seed-proofs/pedro.png'));
  await pedro.req('POST', `/api/bookings/${bid}/proof`, { form: proofForm(pngFile('a.png', png), { amountPesos: '1' }) });
  const mid = (await ana.get('/api/admin/revenue/summary')).data.periods.find((p) => p.key === 'day');
  check('a proof waiting for verification adds nothing', mid.collected === before.collected);
  await ana.post(`/api/admin/bookings/${bid}/reject`, { proofId: await latestProofId(ana,bid), reason: 'Amount does not match.', keepHold: true });
  const rej = (await ana.get('/api/admin/revenue/summary')).data.periods.find((p) => p.key === 'day');
  check('a rejected proof adds nothing', rej.collected === before.collected);
  await pedro.req('POST', `/api/bookings/${bid}/proof`, { form: proofForm(pngFile('b.png', png), { amountPesos: '300' }) });
  const approved = await ana.post(`/api/admin/bookings/${bid}/approve`, { checklist: true, proofId: await latestProofId(ana,bid) });
  const after = (await ana.get('/api/admin/revenue/summary')).data.periods.find((p) => p.key === 'day');
  check('two proofs, one approval → counted once', approved.status === 200 && after.collected === before.collected + hold.data.booking.amountDue && after.payments === before.payments + 1, { before: before.collected, after: after.collected, due: hold.data.booking.amountDue });

  // Ledger: rows, statuses, search, totals that agree with the cards.
  const ref = hold.data.booking.ref;
  const found = await ana.get(`/api/admin/revenue/ledger?from=${today}&to=${today}&q=${encodeURIComponent(ref)}`);
  check('search by reference finds the booking once', found.status === 200 && found.data.total === 1 && found.data.rows[0]?.payStatus === 'paid' && found.data.rows[0]?.countsAsRevenue === true, found.data);
  check('ledger row shows method, verifier and the latest GCash ref field', found.data.rows[0]?.methodLabel === 'GCash' && found.data.rows[0]?.verifiedBy === 'Ana Reyes', found.data.rows[0]);
  check('ledger exposes no storage keys or proof links', !/r2_key|proofs\/|\/api\/files/.test(JSON.stringify(found.data)));
  const day = await ana.get(`/api/admin/revenue/ledger?from=${today}&to=${today}&size=50`);
  check('ledger "collected" for today equals the daily card', day.data.totals.collected === after.collected && day.data.totals.collectedCount === after.payments, { ledger: day.data.totals, card: after.collected });
  const statuses = new Set(day.data.rows.map((r) => r.payStatus));
  check('ledger lists pending and cancelled-after-payment rows too', statuses.has('pending') && statuses.has('cancelled_paid'), [...statuses]);
  check('…but only "paid" rows count as revenue', day.data.rows.every((r) => r.countsAsRevenue === (r.payStatus === 'paid')));
  const byEmail = await ana.get(`/api/admin/revenue/ledger?from=${today}&to=${today}&q=maria.santos`);
  check('search by customer email', byEmail.data.rows.length >= 1 && byEmail.data.rows.every((r) => r.user.email === 'maria.santos@example.com'), byEmail.data.rows.map((r) => r.user.email));
  const onlyPaid = await ana.get(`/api/admin/revenue/ledger?from=${today}&to=${today}&status=paid&type=table_tennis`);
  check('status + type filters combine', onlyPaid.data.rows.length >= 1 && onlyPaid.data.rows.every((r) => r.payStatus === 'paid' && r.activity === 'table_tennis'), onlyPaid.data.rows);
  const sortedAmt = await ana.get(`/api/admin/revenue/ledger?from=${today}&to=${today}&sort=amount&dir=asc&size=50`);
  const amts = sortedAmt.data.rows.map((r) => r.amount);
  check('sorting by amount (server side)', amts.every((a, i) => i === 0 || amts[i - 1] <= a), amts);
  const p1 = await ana.get(`/api/admin/revenue/ledger?from=${today}&to=${today}&size=10&page=1`);
  check('default page size 10, with total and page count', p1.data.size === 10 && p1.data.pages === Math.max(1, Math.ceil(p1.data.total / 10)) && p1.data.rows.length === Math.min(10, p1.data.total), p1.data);
  const past = await ana.get(`/api/admin/revenue/ledger?from=${today}&to=${today}&page=999`);
  check('a page past the end serves the last page', past.status === 200 && past.data.page === past.data.pages, past.data.page);
  for (const [name, qs] of [
    ['page size 7', 'size=7'],
    ['unknown sort column', 'sort=password_hash'],
    ['unknown payment status', 'status=refunded'],
    ['unknown payment method', 'method=cash'],
    ['start after end', `from=${today}&to=${shift(today, -1)}`],
    ['impossible date', 'from=2026-02-30&to=2026-03-01'],
    ['page 0', 'page=0'],
    ['SQL in the sort direction', 'dir=desc;DROP%20TABLE%20bookings'],
  ]) {
    const r = await ana.get(`/api/admin/revenue/ledger?${qs}`);
    check(`ledger rejects ${name} → 422`, r.status === 422, `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  }
  const empty = await ana.get('/api/admin/revenue/ledger?from=2001-01-01&to=2001-01-31');
  check('a period with no payments → empty ledger, zero totals', empty.status === 200 && empty.data.total === 0 && empty.data.rows.length === 0 && empty.data.totals.collected === 0);

  // CSV export: same rows and accounting, formulas defused, audited.
  sql(`UPDATE users SET name = '=HYPERLINK("x")' WHERE id = 'u_maria';`);
  const csv = await ana.get(`/api/admin/revenue/export?from=${today}&to=${today}`);
  const text = new TextDecoder().decode(csv.data);
  const lines = text.replace(/^\uFEFF/, '').trim().split('\r\n');
  check('export is a CSV download', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') ?? '') && /attachment; filename="le-spinners-revenue-/.test(csv.headers.get('content-disposition') ?? ''));
  check('export has the same rows as the ledger', lines.length === day.data.total + 1, { lines: lines.length, ledger: day.data.total });
  check('export reports its parts (1,000 rows each) and a version', csv.headers.get('x-export-rows') === String(day.data.total) && csv.headers.get('x-export-parts') === String(Math.max(1, Math.ceil(day.data.total / 1000))) && /^\d+-\d+$/.test(csv.headers.get('x-export-version') ?? ''), Object.fromEntries(csv.headers));
  const beyond = await ana.get(`/api/admin/revenue/export?from=${today}&to=${today}&part=2`);
  check('asking for a part past the end → 422', beyond.status === 422, beyond.status);
  const v1 = csv.headers.get('x-export-version');
  sql(`UPDATE bookings SET updated_at = updated_at + 1 WHERE id = '${bid}';`);
  const again = await ana.get(`/api/admin/revenue/export?from=${today}&to=${today}`);
  check('the export version changes when a listed booking changes', again.headers.get('x-export-version') !== v1, [v1, again.headers.get('x-export-version')]);
  const paidAmt = lines.slice(1).filter((l) => l.includes('"Yes"')).reduce((sum, l) => sum + Math.round(Number(/"([\d.]+)","GCash"/.exec(l)?.[1] ?? 0) * 100), 0);
  check('export "collected" total matches the ledger', paidAmt === day.data.totals.collected, { csv: paidAmt, ledger: day.data.totals.collected });
  check('spreadsheet formulas in names are defused', text.includes(`"'=HYPERLINK(""x"")"`) && !text.includes('",=HYPERLINK'));
  sql(`UPDATE users SET name = 'Maria Santos' WHERE id = 'u_maria';`);
  const exported = sql(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'revenue_exported';`)[0].results[0];
  check('exports are written to the audit log', exported.n >= 1);
  const staffCsv = await rhea.get(`/api/admin/revenue/export?from=${today}&to=${today}`);
  check('staff cannot export → 403 (no CSV)', staffCsv.status === 403 && !(staffCsv.headers.get('content-type') ?? '').includes('csv'));

  // Page shell
  const page = await fetch(`${BASE}/revenue/?range=30d`, { headers: { Accept: 'text/html' } });
  const pageHtml = await page.text();
  check('/revenue/ serves the admin console shell', page.status === 200 && /Admin console/.test(pageHtml) && pageHtml.includes('/js/admin/app.js'));
  check('/revenue/ sends a CSP + frame protection', (page.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));
  const rr = await fetch(`${BASE}/revenue`, { redirect: 'manual' });
  check('/revenue redirects to /revenue/', rr.status === 301 && rr.headers.get('location')?.endsWith('/revenue/'));
}

section('Console bookings (personal bookings on site)');
{
  const CD = localDate(13);
  const day = await ana.get(`/api/admin/schedule?date=${CD}&activity=table_tennis`);
  const t = day.data.resources.find((x) => x.id === 'table-1').slots;
  const i = t.findIndex((s, k) => s.state === 'available' && t[k + 1]?.state === 'available');
  const start = t[i].start;

  const asPlayer = await juan.post('/api/staff/bookings', { resourceId: 'table-1', date: CD, start, rate: 'member', payment: 'none' });
  check('player cannot make a console booking → 403', asPlayer.status === 403, asPlayer.status);
  const badPay = await ana.post('/api/admin/bookings', { resourceId: 'table-1', date: CD, start, rate: 'member', payment: 'gcash', bookerName: 'Lito Ramos' });
  check('console booking must be paid on site or free → 422', badPay.status === 422, badPay.data);
  const noName = await ana.post('/api/admin/bookings', { resourceId: 'table-1', date: CD, start, rate: 'member', payment: 'none' });
  check('console booking needs the booker\'s name → 422', noName.status === 422 && Boolean(noName.data.error?.details?.bookerName), noName.data);
  const blankName = await rhea.post('/api/staff/bookings', { resourceId: 'table-1', date: CD, start, rate: 'member', payment: 'none', bookerName: '   ' });
  check('a blank booker name → 422', blankName.status === 422 && Boolean(blankName.data.error?.details?.bookerName), blankName.data);

  const paid = await ana.post('/api/admin/bookings', { resourceId: 'table-1', date: CD, starts: [start, start + 60], rate: 'non_member', payment: 'on_site', bookerName: '  Lito Ramos ' });
  const b = paid.data.booking;
  check('admin books on site → 201 CONFIRMED', paid.status === 201 && b?.status === 'CONFIRMED', paid.data);
  check('booked under the admin\'s own account', b?.user?.name === 'Ana Reyes');
  check('records the booker\'s name, trimmed', b?.bookerName === 'Lito Ramos', b?.bookerName);
  const grid = await ana.get(`/api/admin/schedule?date=${CD}&activity=table_tennis`);
  check('staff schedule shows the booker\'s name on the slot', grid.data.resources.find((x) => x.id === 'table-1').slots.find((s) => s.start === start)?.booking?.userName === 'Lito Ramos');
  const found = await ana.get('/api/admin/bookings?scope=all&q=Lito%20Ram');
  check('bookings search finds the booker\'s name', found.data.bookings.some((x) => x.id === b.id), found.data.bookings?.map((x) => x.ref));
  check('records the author: Admin · Ana Reyes', b?.bookedBy?.source === 'admin' && b.bookedBy.label === 'Admin' && b.bookedBy.name === 'Ana Reyes', b?.bookedBy);
  check('paid on site, 2 × ₱300', b?.paymentMethod === 'on_site' && b?.amountDue === 60000, { m: b?.paymentMethod, a: b?.amountDue });
  check('no approval step: confirmed by the author', b?.confirmedBy === 'Ana Reyes' && paid.data.actions?.canApprove === false);
  check('timeline says "Booked on site"', paid.data.timeline?.some((e) => e.type === 'console_booked' && e.actor === 'Ana Reyes'), paid.data.timeline);

  const pv = await pedro.get(`/api/availability?activity=table_tennis&date=${CD}`);
  const ps = pv.data.resources.find((x) => x.id === 'table-1').slots;
  check('players see both hours as booked, with no name', ps.find((s) => s.start === start)?.state === 'booked' && ps.find((s) => s.start === start + 60)?.state === 'booked' && !/Ana|Lito/.test(JSON.stringify(pv.data)));
  const clash = await pedro.post('/api/bookings', { resourceId: 'table-1', date: CD, start: start + 60 });
  check('players cannot book over it → 409', clash.status === 409, clash.data);

  const dayCard = async () => (await ana.get('/api/admin/revenue/summary')).data.periods.find((p) => p.key === 'day');
  const beforeFree = await dayCard();
  const staffFree = await rhea.post('/api/staff/bookings', { resourceId: 'table-2', date: CD, start, rate: 'member', payment: 'none', bookerName: 'Rhea Lim' });
  const afterFree = await dayCard();
  check('a free console booking is not counted as a payment on the revenue cards', afterFree.payments === beforeFree.payments && afterFree.collected === beforeFree.collected, { before: beforeFree, after: afterFree });
  const fb = staffFree.data.booking;
  check('staff book on site free of charge → 201', staffFree.status === 201 && fb?.status === 'CONFIRMED' && fb?.amountDue === 0 && fb?.paymentMethod === 'none', staffFree.data);
  check('records the author: Staff · name', fb?.bookedBy?.source === 'staff' && Boolean(fb.bookedBy.name), fb?.bookedBy);
  const sameTime = await rhea.post('/api/staff/bookings', { resourceId: 'table-3', date: CD, start, rate: 'member', payment: 'none', bookerName: 'Rhea Lim' });
  check('staff cannot double-book themselves → 422 OVERLAP_OWN', sameTime.status === 422 && sameTime.data.error.code === 'OVERLAP_OWN', sameTime.data);

  const ledger = await ana.get(`/api/admin/revenue/ledger?from=${localDate()}&to=${localDate()}&q=${b.ref}`);
  const row = ledger.data.rows?.find((r) => r.id === b.id);
  check('paid-on-site booking is revenue, method "Paid on site"', row?.payStatus === 'paid' && row?.methodLabel === 'Paid on site' && row?.amount === 60000, ledger.data);
  check('ledger row carries the booker\'s name', row?.bookerName === 'Lito Ramos', row);
  const byBooker = await ana.get(`/api/admin/revenue/ledger?from=${localDate()}&to=${localDate()}&q=Lito`);
  check('ledger search finds the booker\'s name', byBooker.data.rows?.some((r) => r.id === b.id), byBooker.data.rows);
  const free = await ana.get(`/api/admin/revenue/ledger?from=${localDate()}&to=${localDate()}&q=${fb.ref}`);
  check('free console booking is not in the ledger', !free.data.rows?.some((r) => r.id === fb.id), free.data.rows);
  const onSite = await ana.get(`/api/admin/revenue/ledger?from=${localDate()}&to=${localDate()}&method=on_site`);
  check('ledger filters by method', onSite.status === 200 && onSite.data.rows.every((r) => r.method === 'on_site') && onSite.data.rows.some((r) => r.id === b.id), onSite.data);

  const list = await ana.get(`/api/admin/bookings?date=${CD}`);
  check('bookings list carries the author', list.data.bookings.some((x) => x.id === b.id && x.bookedBy?.label === 'Admin'));
  const cancel = await ana.post(`/api/admin/bookings/${b.id}/cancel`, { reason: 'Testing cancel' });
  check('confirmed console booking follows the no-cancel rule → 409', cancel.status === 409, cancel.data);
}

section('Email / SMS queue and settings');
{
  const out = await ana.get('/api/admin/outbox');
  check('verification email queued with the right subject', out.data.items.some((o) => o.channel === 'email' && o.subject === 'Le Spinners — Booking Requires Payment Verification'));
  check('SMS queued (no provider yet)', out.data.items.some((o) => o.channel === 'sms' && o.status === 'queued'));
  check('SMS explicitly reports unsupported delivery', out.data.items.some(o => o.channel === 'sms' && o.deliveryState === 'unsupported'));
  check('disabled email is visible in queue health', out.data.emailEnabled === false && typeof out.data.summary.ready === 'number');
  const storage = await ana.get('/api/admin/storage-health');
  check('admin can inspect upload recovery without private file keys', storage.status === 200 && typeof storage.data.cleanupPending === 'number' && !JSON.stringify(storage.data).includes('r2_key'));
  check('legacy file scanning is disabled in isolated tests', storage.data.legacyScanEnabled === false);
  check('staff reading upload recovery → 403', (await rhea.get('/api/admin/storage-health')).status === 403);
  check('player reading upload recovery → 403', (await juan.get('/api/admin/storage-health')).status === 403);
  const s = await ana.get('/api/admin/settings');
  check('admin can edit settings', s.data.canEdit === true && s.data.delivery.sms === 'queued');
  const bad = await ana.put('/api/admin/settings', { gcashNumber: '12345' });
  check('invalid GCash number → 422', bad.status === 422, bad.data);
  const good = await ana.put('/api/admin/settings', { gcashName: 'Le Spinners Recreational Hub', gcashNumber: '0917 123 4567' });
  check('valid settings update → 200', good.status === 200, good.data);
  const kimAdmin = await kim.get('/api/admin/settings');
  check('player cannot read staff settings → 403', kimAdmin.status === 403);
}

section('Facility management (staff)');
{
  const D3 = localDate(3);
  const juanC2 = 'b_juan_c2'; // confirmed: Court 2, in 3 days, 6–7 PM
  const list = await rhea.get('/api/staff/facilities');
  check('staff list courts and tables', list.status === 200 && list.data.resources.length >= 6, list.data);
  const c2 = list.data.resources.find((x) => x.id === 'court-2');
  check('Court 2 shows its upcoming bookings', c2?.upcomingBookings >= 1, c2);

  // Add a court: prices copy from the same activity; staff can't set them.
  const name = `Court Smoke ${run}`.slice(0, 38);
  const priced = await rhea.post('/api/staff/facilities', { activity: 'pickleball', name, priceMember: 100, priceNonMember: 100 });
  check('staff adding a court with prices → 403', priced.status === 403, priced.data);
  const created = await rhea.post('/api/staff/facilities', { activity: 'pickleball', name });
  check('staff add a court → 201, prices copied', created.status === 201 && created.data.resource.priceMember === 50000 && created.data.resource.priceNonMember === 60000, created.data);
  const dup = await rhea.post('/api/staff/facilities', { activity: 'pickleball', name: name.toUpperCase() });
  check('duplicate name → 409 NAME_TAKEN', dup.status === 409 && dup.data.error.code === 'NAME_TAKEN', dup.data);
  const newId = created.data.resource?.id;
  const renamed = await rhea.req('PATCH', `/api/staff/facilities/${newId}`, { json: { name: `${name} B` } });
  check('staff rename a court', renamed.status === 200 && renamed.data.resource.name === `${name} B`, renamed.data);
  const off = await rhea.req('PATCH', `/api/staff/facilities/${newId}`, { json: { status: 'disabled' } });
  check('disabling a court with no bookings needs no confirmation', off.status === 200 && off.data.affected.length === 0, off.data);

  // Maintenance on Court 2 affects Juan's confirmed booking.
  const maint = { status: 'maintenance', maintenanceNote: 'Net repair', maintenanceUntil: localDate(5) };
  const ask = await rhea.req('PATCH', '/api/staff/facilities/court-2', { json: maint });
  const affected = ask.data.error?.details?.affected ?? [];
  check('maintenance over a booking → 409 AFFECTS_BOOKINGS', ask.status === 409 && ask.data.error.code === 'AFFECTS_BOOKINGS', ask.data);
  check('the affected list names the confirmed booking', affected.some((b) => b.id === juanC2 && b.status === 'CONFIRMED'), affected);
  const unchanged = await rhea.get('/api/staff/facilities');
  check('nothing changed before confirmation', unchanged.data.resources.find((x) => x.id === 'court-2').status === 'active');
  const partial = await rhea.req('PATCH', '/api/staff/facilities/court-2', { json: { ...maint, confirmAffected: ['b_someone_else'] } });
  check('confirming the wrong bookings → still 409', partial.status === 409, partial.data);
  const ok = await rhea.req('PATCH', '/api/staff/facilities/court-2', { json: { ...maint, confirmAffected: affected.map((b) => b.id) } });
  check('confirmed → maintenance applied', ok.status === 200 && ok.data.resource.status === 'maintenance', ok.data);
  const kept = await juan.get(`/api/bookings/${juanC2}`);
  check('the confirmed booking is kept, not cancelled', kept.data.booking.status === 'CONFIRMED', kept.data.booking);
  const blocked = await pedro.get(`/api/availability?activity=pickleball&date=${D3}`);
  check('players see Court 2 in maintenance', blocked.data.resources.find((x) => x.id === 'court-2')?.status === 'maintenance');
  const holdBlocked = await pedro.post('/api/bookings', { resourceId: 'court-2', date: D3, start: 1020 });
  check('no new holds on a court in maintenance → 422', holdBlocked.status === 422 && holdBlocked.data.error.code === 'MAINTENANCE', holdBlocked.data);
  const pastUntil = await rhea.req('PATCH', '/api/staff/facilities/court-2', { json: { maintenanceUntil: localDate(0) } });
  check('back-on date must be after today → 422', pastUntil.status === 422, pastUntil.data);
  const back = await rhea.req('PATCH', '/api/staff/facilities/court-2', { json: { status: 'active' } });
  check('ending maintenance needs no confirmation', back.status === 200 && back.data.resource.status === 'active', back.data);
  const audited = sql(`SELECT detail FROM audit_log WHERE action = 'resource_updated' AND entity_id = 'court-2' ORDER BY id DESC LIMIT 2;`)[0].results;
  check('the change is audited with the affected booking', audited.some((a) => (a.detail ?? '').includes('affected')), audited);

  // Open play on Court 2: free for all, shown to players, never bookable.
  const opAsk = await rhea.req('PATCH', '/api/staff/facilities/court-2', { json: { status: 'open_play' } });
  const opAffected = opAsk.data.error?.details?.affected ?? [];
  check('open play over a booking → 409 AFFECTS_BOOKINGS', opAsk.status === 409 && opAffected.some((b) => b.id === juanC2), opAsk.data);
  const opOk = await rhea.req('PATCH', '/api/staff/facilities/court-2', { json: { status: 'open_play', confirmAffected: opAffected.map((b) => b.id) } });
  check('confirmed → open play applied', opOk.status === 200 && opOk.data.resource.status === 'open_play', opOk.data);
  check('open play is stored as an active court with the flag', sql(`SELECT status, open_play FROM resources WHERE id = 'court-2';`)[0].results[0]?.open_play === 1);
  const opDay = await pedro.get(`/api/availability?activity=pickleball&date=${D3}`);
  const opCourt = opDay.data.resources.find((x) => x.id === 'court-2');
  check('players see Court 2 as open play', opCourt?.status === 'open_play' && opCourt.slots.every((s) => s.state === 'open_play' || s.state === 'past'), opCourt);
  const opFacility = await pedro.get('/api/facility');
  check('the facility list marks it open play', opFacility.data.resources.find((x) => x.id === 'court-2')?.status === 'open_play');
  const opHold = await pedro.post('/api/bookings', { resourceId: 'court-2', date: D3, start: 1020 });
  check('no holds on an open play court → 422 OPEN_PLAY', opHold.status === 422 && opHold.data.error.code === 'OPEN_PLAY', opHold.data);
  const opKept = await juan.get(`/api/bookings/${juanC2}`);
  check('the booking on the open play court is kept', opKept.data.booking.status === 'CONFIRMED');
  const opEnd = await rhea.req('PATCH', '/api/staff/facilities/court-2', { json: { status: 'active' } });
  check('ending open play needs no confirmation', opEnd.status === 200 && opEnd.data.resource.status === 'active', opEnd.data);
  check('ending open play clears the flag', sql(`SELECT open_play FROM resources WHERE id = 'court-2';`)[0].results[0]?.open_play === 0);

  // Closures
  const avail = await rhea.get('/api/staff/availability');
  check('staff read weekly hours and closures', avail.status === 200 && avail.data.hours.length === 7, avail.data);
  const past = await rhea.post('/api/staff/availability/closures', { date: localDate(-1), reason: 'Too late' });
  check('closure in the past → 422', past.status === 422, past.data);
  const badRange = await rhea.post('/api/staff/availability/closures', { date: D3, start: 1080, end: 1020, reason: 'Backwards' });
  check('closure ending before it starts → 422', badRange.status === 422, badRange.data);
  const cl = { date: D3, resourceId: 'court-2', start: 1020, end: 1200, reason: 'Private event' };
  const clAsk = await rhea.post('/api/staff/availability/closures', cl);
  const clAffected = clAsk.data.error?.details?.affected ?? [];
  check('closure over a booking → 409 AFFECTS_BOOKINGS', clAsk.status === 409 && clAffected.some((b) => b.id === juanC2), clAsk.data);
  const clOk = await rhea.post('/api/staff/availability/closures', { ...cl, confirmAffected: clAffected.map((b) => b.id) });
  check('confirmed closure → 201', clOk.status === 201 && clOk.data.affected.length >= 1, clOk.data);
  const closedSlot = await pedro.get(`/api/availability?activity=pickleball&date=${D3}`);
  check('players see the closed slot', closedSlot.data.resources.find((x) => x.id === 'court-2').slots.find((x) => x.start === 1020)?.state === 'closed');
  const kept2 = await juan.get(`/api/bookings/${juanC2}`);
  check('the booking under the closure is kept', kept2.data.booking.status === 'CONFIRMED');
  const otherCourt = await rhea.post('/api/staff/availability/closures', { date: D3, resourceId: 'court-3', start: 1080, end: 1140, reason: 'Coaching clinic' });
  check('closure with no bookings needs no confirmation', otherCourt.status === 201 && otherCourt.data.affected.length === 0, otherCourt.data);
  for (const id of [clOk.data.id, otherCourt.data.id]) {
    const del = await rhea.req('DELETE', `/api/staff/availability/closures/${id}`, { json: {} });
    check('staff remove an upcoming closure', del.status === 200, del.data);
  }

  // Weekly hours: closing earlier on Juan's weekday affects his 6 PM booking.
  const weekday = new Date(`${D3}T00:00:00Z`).getUTCDay();
  const day = avail.data.hours[weekday];
  const early = { isOpen: true, open: day.open, close: 1080 };
  const hAsk = await rhea.put(`/api/staff/availability/hours/${weekday}`, early);
  const hAffected = hAsk.data.error?.details?.affected ?? [];
  check('earlier closing over a booking → 409 AFFECTS_BOOKINGS', hAsk.status === 409 && hAffected.some((b) => b.id === juanC2), hAsk.data);
  const odd = await rhea.put(`/api/staff/availability/hours/${weekday}`, { isOpen: true, open: 965, close: 1320 });
  check('hours off the half-hour → 422', odd.status === 422, odd.data);
  const inverted = await rhea.put(`/api/staff/availability/hours/${weekday}`, { isOpen: true, open: 1320, close: 960 });
  check('closing before opening → 422', inverted.status === 422, inverted.data);
  const hOk = await rhea.put(`/api/staff/availability/hours/${weekday}`, { ...early, confirmAffected: hAffected.map((b) => b.id) });
  check('confirmed hours change → 200', hOk.status === 200, hOk.data);
  const restore = await rhea.put(`/api/staff/availability/hours/${weekday}`, { isOpen: day.isOpen, open: day.open, close: day.close });
  check('hours restored', restore.status === 200, restore.data);
  const kept3 = await juan.get(`/api/bookings/${juanC2}`);
  check('the booking is still confirmed after the hours change', kept3.data.booking.status === 'CONFIRMED');
}

// ── Disruptions: operator cancellations and booking credits (REBOOKING.md) ──

const startsOpen = async (client, activity, date, resourceId) => {
  const res = await client.get(`/api/availability?activity=${activity}&date=${date}`);
  return res.data.resources.find((x) => x.id === resourceId).slots.filter((s) => s.state === 'available').map((s) => s.start);
};
const PAY_PNG = readFileSync(join(ROOT, 'db/seed-proofs/juan.png'));
async function latestProofId(client,bookingId) {
  return (await client.get(`/api/${client === rhea ? 'staff' : 'admin'}/bookings/${bookingId}`)).data.proofs[0].id;
}
async function payAndConfirm(player, booking) {
  const up = await player.req('POST', `/api/bookings/${booking.id}/proof`, { form: proofForm(pngFile('pay.png', PAY_PNG), { amountPesos: (booking.amountDue / 100).toFixed(2) }) });
  if (up.status !== 201) throw new Error(`proof upload failed: ${up.status} ${JSON.stringify(up.data)}`);
  const ok = await ana.post(`/api/admin/bookings/${booking.id}/approve`, { checklist: true, proofId: up.data.proofs[0].id });
  if (ok.status !== 200) throw new Error(`approve failed: ${ok.status} ${JSON.stringify(ok.data)}`);
  return ok.data;
}
async function confirmedBooking(player, resourceId, date, starts) {
  const hold = await player.post('/api/bookings', { resourceId, date, starts });
  if (hold.status !== 201) throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.data)}`);
  await payAndConfirm(player, hold.data.booking);
  return (await player.get(`/api/bookings/${hold.data.booking.id}`)).data.booking;
}
let keyN = 0;
const newKey = () => `smoke-${run}-${++keyN}`;
const applyPreview = (client, p, ns = 'staff', key = newKey()) =>
  client.req('POST', `/api/${ns}/disruptions`, { json: { ...p.input, previewToken: p.previewToken }, headers: { 'Idempotency-Key': key } });
const resetBookingLimits = () => sql(`DELETE FROM rate_limits WHERE key LIKE 'proof:%' OR key LIKE 'hold:%';`);

section('Cancel & credit: one booking');
let juanCredit;
let cancelledRef;
{
  resetBookingLimits();
  const DA = localDate(8);
  const open = await startsOpen(juan, 'pickleball', DA, 'court-1');
  const b = await confirmedBooking(juan, 'court-1', DA, [open[0]]);
  check('setup: Juan has a confirmed ₱500 booking', b.status === 'CONFIRMED' && b.amountDue === 50000, b);
  const body = { scope: { kind: 'bookings', bookingIds: [b.id] }, category: 'equipment_failure', reason: 'Net post broke' };

  // Customers can't cancel, and can't reach the operator tools either.
  const asPlayer = await juan.post('/api/staff/disruptions/preview', body);
  check('player previewing a disruption → 403', asPlayer.status === 403, asPlayer.status);
  const playerCancel = await juan.post(`/api/bookings/${b.id}/cancel`, { reason: 'Changed plans' });
  check('player cancel still → 409 NOT_CANCELLABLE', playerCancel.status === 409 && playerCancel.data.error.code === 'NOT_CANCELLABLE', playerCancel.data);

  const extra = await rhea.post('/api/staff/disruptions/preview', { ...body, creditAmount: 999999 });
  check('unknown money fields are refused → 422', extra.status === 422, extra.data);
  const custReq = await rhea.post('/api/staff/disruptions/preview', { ...body, category: 'customer_request' });
  check("staff can't cancel at a customer's request (admin only) → 403", custReq.status === 403, custReq.data);
  const noComp = await rhea.post('/api/staff/disruptions/preview', { ...body, compensation: 'none' });
  check('staff cannot cancel without a credit → 403', noComp.status === 403, noComp.data);

  const pv = await rhea.post('/api/staff/disruptions/preview', body);
  const p = pv.data.preview;
  const item = p?.items?.[0];
  check('preview → cancel with a full ₱500 credit', pv.status === 200 && item?.action === 'cancel' && item.credit === 50000 && p.totals.credit === 50000, pv.data);
  check('the preview pins the time it applies from', Number.isInteger(p?.input?.scope?.effectiveFrom), p?.input);
  check('a preview changes nothing', (await juan.get(`/api/bookings/${b.id}`)).data.booking.status === 'CONFIRMED');

  const noKey = await rhea.post('/api/staff/disruptions', { ...p.input, previewToken: p.previewToken });
  check('confirming without an Idempotency-Key → 400', noKey.status === 400, noKey.data);
  const stale = await rhea.req('POST', '/api/staff/disruptions', { json: { ...p.input, previewToken: 'a'.repeat(64) }, headers: { 'Idempotency-Key': newKey() } });
  check('a stale preview → 409 DISRUPTION_CHANGED with a fresh one', stale.status === 409 && stale.data.error.code === 'DISRUPTION_CHANGED' && stale.data.error.details?.preview?.previewToken === p.previewToken, stale.data);

  const key = newKey();
  const done = await applyPreview(rhea, p, 'staff', key);
  check('confirm → 201 with the outcome', done.status === 201 && done.data.items?.[0]?.outcome === 'cancelled' && done.data.items[0].credit === 50000, done.data);
  const again = await applyPreview(rhea, p, 'staff', key);
  check('double-click (same key) → the same disruption, nothing new', again.status === 200 && again.data.replay === true && again.data.disruption?.id === done.data.disruption?.id, again.data);
  const reused = await rhea.req('POST', '/api/staff/disruptions', { json: { ...p.input, reason: 'Something else', previewToken: p.previewToken }, headers: { 'Idempotency-Key': key } });
  check('same key, different change → 409 IDEMPOTENCY_KEY_REUSED', reused.status === 409 && reused.data.error.code === 'IDEMPOTENCY_KEY_REUSED', reused.data);
  const credits = sql(`SELECT id, amount, remaining FROM booking_credits WHERE source_booking_id = '${b.id}';`)[0].results;
  check('exactly one ₱500 credit for the booking', credits.length === 1 && credits[0].amount === 50000 && credits[0].remaining === 50000, credits);
  juanCredit = credits[0];
  cancelledRef = b.ref;

  const d = await juan.get(`/api/bookings/${b.id}`);
  check('player sees it cancelled by Le Spinners', d.data.booking.status === 'CANCELLED' && d.data.booking.cancelledBy === 'staff' && d.data.booking.disrupted === true, d.data.booking);
  check('…with the credit and the reason', d.data.credit?.disruptions?.[0]?.credit === 50000 && d.data.credit.disruptions[0].reason === 'Net post broke' && d.data.booking.creditIssued === 50000, d.data.credit);
  check('…and no staff name or internal note', !('by' in (d.data.credit?.disruptions?.[0] ?? {})) && !('staffNote' in (d.data.credit?.disruptions?.[0] ?? {})));
  const n = await juan.get('/api/notifications');
  check('player notified with the credit', n.data.notifications.some((x) => x.type === 'booking_disrupted' && x.bookingId === b.id && x.body.includes('₱500 booking credit')), n.data.notifications.slice(0, 3));
  const chat = await juan.get(`/api/bookings/${b.id}/messages`);
  check('a system message lands in the booking chat', chat.data.messages.some((m) => m.kind === 'system' && m.body.startsWith('Booking cancelled by Le Spinners')));
  const mine = await juan.get('/api/credits');
  check('Booking credits: ₱500 available', mine.status === 200 && mine.data.summary.available === 50000 && mine.data.credits.some((c) => c.id === juanCredit.id && c.state === 'available'), mine.data);
  check('the bookings list carries the credit total', (await juan.get('/api/bookings')).data.credits?.available === 50000);
  const email = sql(`SELECT subject FROM outbox WHERE booking_id = '${b.id}' AND subject LIKE '%Booking cancelled%';`)[0].results;
  check('cancellation email queued', email.length === 1, email);
  const audited = sql(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'disruption_applied' AND entity_id = '${done.data.disruption.id}';`)[0].results[0];
  check('audited in the same transaction', audited.n === 1, audited);

  const twice = await rhea.post('/api/staff/disruptions/preview', body);
  check('the cancelled booking is no longer affected', twice.status === 200 && twice.data.preview.items.length === 0 && twice.data.preview.notAffected[0]?.reason === 'ended', twice.data);
  const nothing = await applyPreview(rhea, twice.data.preview);
  check('…and confirming changes nothing → 422 NOTHING_TO_DO', nothing.status === 422 && nothing.data.error.code === 'NOTHING_TO_DO', nothing.data);
  const staffView = await rhea.get(`/api/staff/bookings/${b.id}`);
  check('staff detail: no second cancel & credit; shows who did it', staffView.data.actions.canDisrupt === false && staffView.data.credit?.disruptions?.[0]?.by === 'Rhea Lim', staffView.data.credit);
}

section('Rebook with the credit');
{
  const DA = localDate(8);
  const open = await startsOpen(juan, 'pickleball', DA, 'court-2');
  const q = await juan.get(`/api/bookings/quote?resourceId=court-2&starts=${open[0]}`);
  check('quote: ₱500, all of it paid by credit', q.status === 200 && q.data.price === 50000 && q.data.creditApplied === 50000 && q.data.amountDue === 0, q.data);
  const wrong = await juan.post('/api/bookings', { resourceId: 'court-2', date: DA, starts: [open[0]], useCredit: true, expectedCredit: 100 });
  check('the app showed a different credit → 409 CREDIT_CHANGED', wrong.status === 409 && wrong.data.error.code === 'CREDIT_CHANGED' && wrong.data.error.details?.creditApplied === 50000, wrong.data);
  const r = await juan.post('/api/bookings', { resourceId: 'court-2', date: DA, starts: [open[0]], useCredit: true, expectedCredit: 50000, amountDue: 0, status: 'CONFIRMED' });
  const nb = r.data.booking;
  check('booked with credit → CONFIRMED at once, nothing to pay', r.status === 201 && nb?.status === 'CONFIRMED' && nb.amountDue === 0 && nb.creditApplied === 50000 && nb.paymentMethodLabel === 'Paid with credit', r.data);
  check('the replacement names the original booking', r.data.credit?.creditUses?.sources?.[0]?.sourceRef === cancelledRef, r.data.credit);
  const after = await juan.get('/api/credits');
  check('the credit is used up', after.data.summary.available === 0 && after.data.credits.find((c) => c.id === juanCredit.id)?.state === 'used', after.data);
  const hist = await juan.get(`/api/credits/${juanCredit.id}`);
  check('credit history: issued, then used (player view)', hist.status === 200 && hist.data.history.map((h) => h.kind).join(',') === 'issue,redeem' && hist.data.history[0].actor === 'Le Spinners', hist.data.history);
  const peek = await pedro.get(`/api/credits/${juanCredit.id}`);
  check("another player's credit → 404", peek.status === 404, peek.status);
  const ledger = await ana.get(`/api/admin/revenue/ledger?from=${localDate()}&to=${localDate()}&q=${nb.ref}`);
  check('a credit-paid booking is not new cash in Revenue', ledger.status === 200 && !ledger.data.rows.some((x) => x.id === nb.id), ledger.data.rows);
  const noCredit = await juan.post('/api/bookings', { resourceId: 'court-2', date: DA, starts: [open[1]], useCredit: true });
  check('no credit left → an ordinary hold for the full price', noCredit.status === 201 && noCredit.data.booking.status === 'TEMPORARY' && noCredit.data.booking.amountDue === 50000 && noCredit.data.booking.creditApplied === 0, noCredit.data);
  if (noCredit.status === 201) await juan.post(`/api/bookings/${noCredit.data.booking.id}/release`, {});
}

section('Credit with a GCash top-up, returned credit and double spending');
{
  resetBookingLimits();
  const DT = localDate(9);
  // Pedro (non-member) gets a ₱600 credit: a closure on Court 3 cancels his confirmed booking.
  const c3 = await startsOpen(pedro, 'pickleball', DT, 'court-3');
  const orig = await confirmedBooking(pedro, 'court-3', DT, [c3[0]]);
  const pv = await rhea.post('/api/staff/disruptions/preview', { scope: { kind: 'window', date: DT, start: c3[0], end: c3[0] + 60, resourceId: 'court-3' }, category: 'maintenance', reason: 'Lights failed' });
  check('window preview finds the booking and plans the closure', pv.data.preview?.items?.length === 1 && pv.data.preview.items[0].credit === 60000 && pv.data.preview.closures.length === 1, pv.data);
  const ap = await applyPreview(rhea, pv.data.preview);
  check('applied: ₱600 credit, closure saved with it', ap.status === 201 && ap.data.disruption.creditedTotal === 60000 && ap.data.closures.length === 1, ap.data);
  const credit = sql(`SELECT id FROM booking_credits WHERE source_booking_id = '${orig.id}';`)[0].results[0];

  const c1 = await startsOpen(pedro, 'pickleball', DT, 'court-1');
  const two = [c1[0], c1[1]]; // 2 × ₱600 = ₱1,200
  const hold = await pedro.post('/api/bookings', { resourceId: 'court-1', date: DT, starts: two, useCredit: true, expectedCredit: 60000 });
  const hb = hold.data.booking;
  check('top-up: a hold for the ₱600 difference, ₱600 credit applied', hold.status === 201 && hb?.status === 'TEMPORARY' && hb.amountDue === 60000 && hb.creditApplied === 60000, hold.data);
  const reserved = await pedro.get(`/api/credits/${credit.id}`);
  check('the hold reserves the credit', reserved.data.credit?.remaining === 0 && reserved.data.credit.reserved === 60000, reserved.data.credit);
  const rel = await pedro.post(`/api/bookings/${hb.id}/release`, {});
  const back = sql(`SELECT remaining FROM booking_credits WHERE id = '${credit.id}';`)[0].results[0];
  check('releasing the hold returns the credit', rel.status === 200 && back.remaining === 60000, { rel: rel.status, back });
  const pn = await pedro.get('/api/notifications');
  check('player told the credit is back', pn.data.notifications.some((x) => x.type === 'credit_restored' && x.bookingId === hb.id));

  // The hold lapses: expiry and return commit together, and only once even with the cron safety net.
  const hold2 = await pedro.post('/api/bookings', { resourceId: 'court-1', date: DT, starts: two, useCredit: true, expectedCredit: 60000 });
  sql(`UPDATE bookings SET hold_expires_at = ${Date.now() - 1000} WHERE id = '${hold2.data.booking.id}';`);
  await runCron();
  await runCron();
  const ex = sql(`SELECT b.status, c.remaining, (SELECT COUNT(*) FROM credit_transactions t WHERE t.booking_id = b.id AND t.kind = 'release') AS releases
                    FROM bookings b, booking_credits c WHERE b.id = '${hold2.data.booking.id}' AND c.id = '${credit.id}';`)[0].results[0];
  check('expired hold → EXPIRED, credit returned exactly once', ex?.status === 'EXPIRED' && ex.remaining === 60000 && ex.releases === 1, ex);

  // Paid and verified: only the GCash part is revenue.
  const hold3 = await pedro.post('/api/bookings', { resourceId: 'court-1', date: DT, starts: two, useCredit: true, expectedCredit: 60000 });
  await payAndConfirm(pedro, hold3.data.booking);
  const conf = (await pedro.get(`/api/bookings/${hold3.data.booking.id}`)).data.booking;
  check('top-up verified → CONFIRMED, "GCash + credit"', conf.status === 'CONFIRMED' && conf.paymentMethodLabel === 'GCash + credit' && conf.totalValue === 120000, conf);
  const row = (await ana.get(`/api/admin/revenue/ledger?from=${localDate()}&to=${localDate()}&q=${conf.ref}`)).data.rows?.[0];
  check('revenue counts the ₱600 cash only', row?.amount === 60000 && row.creditApplied === 60000 && row.payStatus === 'paid', row);
  const kept = sql(`SELECT COUNT(*) AS n FROM credit_transactions WHERE booking_id = '${hold3.data.booking.id}' AND kind = 'release';`)[0].results[0];
  check('a confirmed top-up keeps its credit (no release)', kept.n === 0, kept);

  // Two tabs spend the same credit at once: exactly one wins, the other changes nothing.
  const gift = await ana.req('POST', '/api/admin/credits', { json: { userId: 'u_pedro', amount: 30000, reason: 'Sorry for the wait' }, headers: { 'Idempotency-Key': newKey() } });
  check('admin issues a ₱300 credit by hand', gift.status === 201 && gift.data.credit?.remaining === 30000, gift.data);
  const t = (await startsOpen(pedro, 'table_tennis', DT, 'table-1')).filter((s) => s >= two[1] + 60);
  const race = await Promise.all([
    pedro.post('/api/bookings', { resourceId: 'table-1', date: DT, starts: [t[0]], useCredit: true, expectedCredit: 30000 }),
    pedro.post('/api/bookings', { resourceId: 'table-1', date: DT, starts: [t[1]], useCredit: true, expectedCredit: 30000 }),
  ]);
  check('race: exactly one booking spends the credit', race.filter((x) => x.status === 201).length === 1 && race.some((x) => x.status === 409 && x.data.error.code === 'CREDIT_CHANGED'), race.map((x) => `${x.status} ${x.data?.error?.code ?? x.data?.booking?.status ?? ''}`));
  const giftRow = sql(`SELECT remaining FROM booking_credits WHERE id = '${gift.data.credit?.id}';`)[0].results[0];
  check('…and the credit is spent once', giftRow?.remaining === 0, giftRow);
}

section('Closure over many bookings (window disruption)');
let windowDisruption;
{
  resetBookingLimits();
  const DW = localDate(10);
  const [s0, s1, s2, s3, s4] = await startsOpen(juan, 'pickleball', DW, 'court-1');
  const bConf = await confirmedBooking(juan, 'court-1', DW, [s0]); // member ₱500
  const bGap = await confirmedBooking(pedro, 'court-1', DW, [s2, s4]); // non-member 2 × ₱600, gap at s3
  const bAfter = await confirmedBooking(maria, 'court-1', DW, [s3]); // starts when the window ends
  const bTable = await confirmedBooking(pedro, 'table-1', DW, [s0]); // other activity
  const bHold = (await maria.post('/api/bookings', { resourceId: 'court-2', date: DW, starts: [s0] })).data.booking;
  const subHold = (await kim.post('/api/bookings', { resourceId: 'court-3', date: DW, starts: [s0] })).data.booking;
  await kim.req('POST', `/api/bookings/${subHold.id}/proof`, { form: proofForm(pngFile('k.png', PAY_PNG), { amountPesos: (subHold.amountDue / 100).toFixed(2) }) });
  const free = (await rhea.post('/api/staff/bookings', { resourceId: 'court-2', date: DW, starts: [s1], rate: 'member', payment: 'none', bookerName: 'Rhea Lim' })).data.booking;
  check('setup: seven bookings on the day', [bConf, bGap, bAfter, bTable, bHold, subHold, free].every((b) => b?.id), [bConf, bGap, bAfter, bTable, bHold, subHold, free].map((b) => b?.status));

  const body = { scope: { kind: 'window', date: DW, start: s0, end: s3, activity: 'pickleball' }, category: 'weather', reason: 'Heavy rain', staffNote: 'Gutter overflow on Court 2' };
  const pv = await rhea.post('/api/staff/disruptions/preview', body);
  const items = pv.data.preview?.items ?? [];
  const by = (id) => items.find((i) => i.bookingId === id);
  check('only overlapping pickleball bookings are affected', items.length === 5 && !by(bAfter.id) && !by(bTable.id), items.map((i) => i.ref));
  check('confirmed, not started → cancel, ₱500 credit', by(bConf.id)?.action === 'cancel' && by(bConf.id).credit === 50000, by(bConf.id));
  check('partly inside, not started → cancel in full by default, staff may keep', by(bGap.id)?.action === 'cancel' && by(bGap.id).canChoose === true && by(bGap.id).credit === 120000, by(bGap.id));
  check('unpaid hold → released, no credit', by(bHold.id)?.action === 'cancel' && by(bHold.id).credit === 0 && by(bHold.id).flags.some((f) => f.key === 'hold'), by(bHold.id));
  check('proof waiting → deferred, ₱600 once verified', by(subHold.id)?.action === 'defer' && by(subHold.id).projectedCredit === 60000, by(subHold.id));
  check('free staff booking → no credit', by(free.id)?.action === 'cancel' && by(free.id).credit === 0 && by(free.id).flags.some((f) => f.key === 'free'), by(free.id));
  check('closures planned for every pickleball court', (pv.data.preview?.closures ?? []).length >= 3, pv.data.preview?.closures);

  // Pedro's booking keeps 8 PM: only the closed hour is credited.
  const pv2 = await rhea.post('/api/staff/disruptions/preview', { ...body, overrides: [{ bookingId: bGap.id, action: 'keep' }] });
  const gap2 = pv2.data.preview?.items?.find((i) => i.bookingId === bGap.id);
  check('keep → only the closed hour is credited (₱600 of ₱1,200)', gap2?.action === 'keep' && gap2.credit === 60000 && pv2.data.preview.totals.credit === 110000, gap2);
  const ap = await applyPreview(rhea, pv2.data.preview);
  windowDisruption = ap.data.disruption?.id;
  check('applied → 201', ap.status === 201, ap.data);
  const st = Object.fromEntries(sql(`SELECT id, status, compensated_amount FROM bookings WHERE id IN ('${[bConf, bGap, bAfter, bTable, bHold, subHold, free].map((b) => b.id).join("','")}');`)[0].results.map((r) => [r.id, r]));
  check('cancelled: the confirmed booking, the hold, the free booking', st[bConf.id].status === 'CANCELLED' && st[bHold.id].status === 'CANCELLED' && st[free.id].status === 'CANCELLED', st);
  check('kept and partly credited: the booking with the gap', st[bGap.id].status === 'CONFIRMED' && st[bGap.id].compensated_amount === 60000, st[bGap.id]);
  check('untouched: the booking after the window, the table, the proof waiting', st[bAfter.id].status === 'CONFIRMED' && st[bTable.id].status === 'CONFIRMED' && st[subHold.id].status === 'PAYMENT_SUBMITTED', st);
  const blocked = await maria.post('/api/bookings', { resourceId: 'court-1', date: DW, starts: [s1] });
  check('the closed window takes no new bookings → 422 CLOSED', blocked.status === 422 && blocked.data.error.code === 'CLOSED', blocked.data);
  const seen = await pedro.get(`/api/availability?activity=pickleball&date=${DW}`);
  check('players see the closed window as closed', seen.data.resources.find((x) => x.id === 'court-2').slots.find((x) => x.start === s1)?.state === 'closed', seen.data.resources.find((x) => x.id === 'court-2').slots);
  check('hold owner told "Your hold ended"', (await maria.get('/api/notifications')).data.notifications.some((x) => x.bookingId === bHold.id && x.title === 'Your hold ended'));
  check('proof owner told a credit follows verification', (await kim.get('/api/notifications')).data.notifications.some((x) => x.bookingId === subHold.id && x.type === 'disruption_pending'));
  const badges = await rhea.get('/api/staff/badges');
  check('staff badge counts the booking still to finish', badges.data.disruptionsOpen >= 1, badges.data);
  const note = sql(`SELECT resolved_at FROM notifications WHERE type = 'disruption' AND link = '/admin/disruptions/${windowDisruption}';`)[0].results[0];
  check('staff summary notice stays open while one is pending', note && note.resolved_at === null, note);

  // Verifying the waiting payment finishes the job: cancelled, ₱600 credit.
  const approved = await rhea.post(`/api/staff/bookings/${subHold.id}/approve`, { checklist: true, proofId: await latestProofId(rhea,subHold.id) });
  check('approving the waiting payment cancels it with its credit', approved.status === 200 && approved.data.resolvedDisruptions?.[0]?.outcome === 'cancelled' && approved.data.resolvedDisruptions[0].credit === 60000 && approved.data.booking.status === 'CANCELLED', approved.data.resolvedDisruptions ?? approved.data);
  const after = await rhea.get(`/api/staff/disruptions/${windowDisruption}`);
  check('disruption detail: five bookings, nothing left open', after.data.items?.length === 5 && after.data.disruption.openCount === 0 && after.data.disruption.creditedTotal === 170000, after.data.disruption);
  const note2 = sql(`SELECT resolved_at FROM notifications WHERE type = 'disruption' AND link = '/admin/disruptions/${windowDisruption}';`)[0].results[0];
  check('…and the staff notice is resolved', note2?.resolved_at != null, note2);
  const list = await rhea.get('/api/staff/disruptions');
  check('history lists it with its scope', list.data.disruptions?.some((x) => x.id === windowDisruption && x.scopeLabel === 'All pickleball courts'), list.data.disruptions?.slice(0, 2));
  const playerView = await juan.get(`/api/bookings/${bConf.id}`);
  check('players never see the internal note', !JSON.stringify(playerView.data).includes('Gutter overflow'));
}

section('Partial disruption of a booking in progress');
{
  resetBookingLimits();
  const DP = localDate(11);
  const open = await startsOpen(maria, 'pickleball', DP, 'court-2');
  const b = await confirmedBooking(maria, 'court-2', DP, [open[0], open[1]]); // member, 2 × ₱500
  // Move it to today, started an hour ago.
  const nowLocal = new Date(Date.now() + TZ_MS);
  const nowMin = nowLocal.getUTCHours() * 60 + nowLocal.getUTCMinutes();
  const start = Math.max(0, nowMin - 60);
  const end = Math.min(1440, start + 120);
  // References are numbered per date, so the moved booking takes a reference of today's date too.
  sql(`UPDATE bookings SET date = '${localDate()}', start_min = ${start}, end_min = ${end}, ref = 'LS-${localDate().replaceAll('-', '')}-990' WHERE id = '${b.id}';
       UPDATE booking_slots SET date = '${localDate()}', start_min = ${start}, end_min = ${end} WHERE booking_id = '${b.id}';`);
  const body = { scope: { kind: 'bookings', bookingIds: [b.id] }, category: 'unsafe_conditions', reason: 'Wet surface' };
  const pv = await rhea.post('/api/staff/disruptions/preview', body);
  const it = pv.data.preview?.items?.[0];
  check('in progress → keep, credit only the unplayed part', it?.action === 'keep' && it.flags.some((f) => f.key === 'in_progress') && it.affectedMin > 0 && it.affectedMin < it.bookedMin, it);
  check('credit = ⌊paid × unplayed ÷ booked⌋', it?.credit === Math.floor((100000 * it.affectedMin) / it.bookedMin), it);
  const ap = await applyPreview(rhea, pv.data.preview);
  const row = sql(`SELECT status, compensated_amount FROM bookings WHERE id = '${b.id}';`)[0].results[0];
  check('the booking stays CONFIRMED with the credit recorded', ap.status === 201 && row.status === 'CONFIRMED' && row.compensated_amount === it.credit, { ap: ap.status, row });
  const again = await rhea.post('/api/staff/disruptions/preview', body);
  check('those minutes are never credited twice', again.data.preview?.items?.length === 0 && again.data.preview.notAffected[0]?.reason === 'already_compensated', again.data);
  const retro = { ...body, scope: { ...body.scope, effectiveFrom: Date.now() - 2 * 86_400_000 } };
  const staffRetro = await rhea.post('/api/staff/disruptions/preview', retro);
  check('staff recording an earlier day → 403 RETRO_NOT_ALLOWED', staffRetro.status === 403 && staffRetro.data.error.code === 'RETRO_NOT_ALLOWED', staffRetro.data);
  const adminRetro = await ana.post('/api/admin/disruptions/preview', retro);
  check('admins may, within 7 days', adminRetro.status === 200, adminRetro.data);
}

section('Admin credit tools');
{
  resetBookingLimits();
  const asStaff = await rhea.req('POST', '/api/admin/credits', { json: { userId: 'u_juan', amount: 10000, reason: 'Goodwill' }, headers: { 'Idempotency-Key': newKey() } });
  check('staff issuing a credit → 403', asStaff.status === 403, asStaff.status);
  const noKey = await ana.post('/api/admin/credits', { userId: 'u_juan', amount: 10000, reason: 'Goodwill' });
  check('a manual credit needs an Idempotency-Key → 400', noKey.status === 400, noKey.data);
  const toStaff = await ana.req('POST', '/api/admin/credits', { json: { userId: 'u_rhea', amount: 10000, reason: 'Goodwill' }, headers: { 'Idempotency-Key': newKey() } });
  check('credits only go to player accounts → 404', toStaff.status === 404, toStaff.data);
  const k = newKey();
  const g = await ana.req('POST', '/api/admin/credits', { json: { userId: 'u_juan', amount: 25000, reason: 'Late payment verified' }, headers: { 'Idempotency-Key': k } });
  const g2 = await ana.req('POST', '/api/admin/credits', { json: { userId: 'u_juan', amount: 25000, reason: 'Late payment verified' }, headers: { 'Idempotency-Key': k } });
  const made = sql(`SELECT COUNT(*) AS n FROM booking_credits WHERE idempotency_key = '${k}';`)[0].results[0];
  check('manual credit → 201; a retry with the same key adds nothing', g.status === 201 && g2.data.credit?.id === g.data.credit?.id && made.n === 1, { g: g.status, g2: g2.data, made });
  const id = g.data.credit.id;
  const refundOptions = { headers: { 'Idempotency-Key': `smoke-refund-${id}` } };
  const tooMuch = await ana.post(`/api/admin/credits/${id}/refund`, { amount: 99900, method: 'cash' }, refundOptions);
  check('refund above the balance → 422', tooMuch.status === 422, tooMuch.data);
  const noRef = await ana.post(`/api/admin/credits/${id}/refund`, { amount: 5000, method: 'gcash' }, refundOptions);
  check('a GCash refund needs its reference → 422', noRef.status === 422, noRef.data);
  const refund = await ana.post(`/api/admin/credits/${id}/refund`, { amount: 5000, method: 'gcash', reference: '1234 567 890' }, refundOptions);
  check('refund recorded: ₱200 left, reference kept', refund.status === 200 && refund.data.credit.remaining === 20000 && refund.data.history.some((h) => h.kind === 'refund' && (h.note ?? '').includes('1234 567 890')), refund.data);
  const replay = await ana.post(`/api/admin/credits/${id}/refund`, { amount: 5000, method: 'gcash', reference: '1234 567 890' }, refundOptions);
  check('refund replay preserves one debit and original operation result', replay.status === 200 && replay.data.credit.remaining === 20000 && replay.data.history.filter(h => h.kind === 'refund').length === 1 && replay.data.refund.transactionId === refund.data.refund.transactionId, replay.data);
  const changedRefund = await ana.post(`/api/admin/credits/${id}/refund`, { amount: 6000, method: 'cash' }, refundOptions);
  check('refund key cannot be reused for a different amount or method', changedRefund.status === 409 && changedRefund.data.error.code === 'IDEMPOTENCY_KEY_REUSED', changedRefund.data);

  // A pending top-up hold reserves the credit: no void until it is settled.
  const summary = (await juan.get('/api/credits')).data.summary.available;
  const DV = localDate(11);
  const open = await startsOpen(juan, 'pickleball', DV, 'court-1');
  const h = await juan.post('/api/bookings', { resourceId: 'court-1', date: DV, starts: [open[0], open[1]], useCredit: true });
  check('top-up hold uses all of Juan\'s credit', h.status === 201 && h.data.booking.status === 'TEMPORARY' && h.data.booking.creditApplied === summary && summary < 100000, { summary, b: h.data.booking });
  const pending = await ana.post(`/api/admin/credits/${id}/void`, { reason: 'Issued twice by mistake' });
  check('void while a hold uses it → 409 CREDIT_PENDING', pending.status === 409 && pending.data.error.code === 'CREDIT_PENDING', pending.data);
  await juan.post(`/api/bookings/${h.data.booking.id}/release`, {});
  const voided = await ana.post(`/api/admin/credits/${id}/void`, { reason: 'Issued twice by mistake' });
  check('void → state voided, nothing left', voided.status === 200 && voided.data.credit.state === 'voided' && voided.data.credit.remaining === 0, voided.data);
  const twice = await ana.post(`/api/admin/credits/${id}/void`, { reason: 'Again' });
  check('void again → 409 CREDIT_EMPTY', twice.status === 409 && twice.data.error.code === 'CREDIT_EMPTY', twice.data);
  const seen = await juan.get('/api/credits');
  check('the player sees it voided, with the reason in a notice', seen.data.credits.some((c) => c.id === id && c.state === 'voided') && (await juan.get('/api/notifications')).data.notifications.some((x) => x.type === 'credit_changed' && x.body.includes('Issued twice by mistake')));
  const search = await rhea.get('/api/staff/credits?q=Juan');
  check('staff can search credits', search.status === 200 && search.data.credits.some((c) => c.id === id && c.user.name === 'Juan Dela Cruz'), search.data);
  const detail = await rhea.get(`/api/staff/credits/${id}`);
  check('staff see the full history with names', detail.data.history?.map((x) => x.kind).join(',') === 'issue,refund,redeem,release,void' && detail.data.history[0].actor === 'Ana Reyes', detail.data.history);
  const noPost = await rhea.post('/api/staff/credits', { userId: 'u_juan', amount: 1, reason: 'Nope nope' });
  check('no credit-issuing route under /api/staff → 404', noPost.status === 404, noPost.status);
}

section('Booking credit invariants');
{
  const drift = sql(`SELECT c.id FROM booking_credits c
                      WHERE c.remaining != (SELECT COALESCE(SUM(t.amount), 0) FROM credit_transactions t WHERE t.credit_id = c.id)
                         OR c.remaining < 0 OR c.remaining > c.amount;`)[0].results;
  check('every credit balance equals its ledger', drift.length === 0, drift);
  const over = sql(`SELECT id FROM bookings WHERE compensated_amount > amount_due + credit_applied;`)[0].results;
  check('no booking was credited more than was paid for it', over.length === 0, over);
  const doubled = sql(`SELECT related_txn_id FROM credit_transactions WHERE kind = 'release' GROUP BY related_txn_id HAVING COUNT(*) > 1;`)[0].results;
  check('no redemption was returned twice', doubled.length === 0, doubled);
  const orphan = sql(`SELECT r.id FROM credit_transactions r LEFT JOIN credit_transactions t ON t.id = r.related_txn_id
                       WHERE r.kind = 'release' AND (t.id IS NULL OR t.kind != 'redeem' OR t.amount != -r.amount);`)[0].results;
  check('every return matches the redemption it undoes', orphan.length === 0, orphan);
  const dup = sql(`SELECT source_booking_id FROM booking_credits WHERE disruption_id IS NOT NULL GROUP BY source_booking_id, disruption_id HAVING COUNT(*) > 1;`)[0].results;
  check('one credit per booking per disruption', dup.length === 0, dup);
  const credited = sql(`SELECT b.id FROM bookings b WHERE b.status IN ('CONFIRMED', 'PAYMENT_SUBMITTED') AND EXISTS (
                          SELECT 1 FROM closures c JOIN booking_times t ON t.booking_id = b.id
                           WHERE c.disruption_id IS NOT NULL AND c.date = t.date AND (c.resource_id IS NULL OR c.resource_id = t.resource_id)
                             AND c.start_min < t.end_min AND c.end_min > t.start_min AND c.created_at > b.created_at
                             AND NOT EXISTS (SELECT 1 FROM disruption_items di WHERE di.booking_id = b.id AND di.disruption_id = c.disruption_id));`)[0].results;
  check('no live booking sits unhandled in a disruption closure', credited.length === 0, credited);
}

section('Logout and revoked sessions');
{
  resetSignInLimits();
  const s = new Client('logout-staff');
  await s.login('rhea.lim@lespinners.example', PASSWORD, 'staff');
  const saved = s.cookie;
  check('staff session works', (await s.get('/api/staff/badges')).status === 200);
  const out = await s.post('/api/auth/logout', {});
  check('logout → 200 and clears the cookie', out.status === 200 && s.cookie === '');
  const replay = new Client('replay');
  replay.cookie = saved;
  check('the old cookie no longer works (401)', (await replay.get('/api/staff/badges')).status === 401);
  check('…and the session reads as signed out', (await replay.get('/api/auth/session')).data.user === null);
  const exp = new Client('expired-staff');
  await exp.login('rhea.lim@lespinners.example', PASSWORD, 'staff');
  sql(`UPDATE sessions SET expires_at = ${Date.now() - 1000} WHERE user_id = 'u_rhea' AND created_at = (SELECT MAX(created_at) FROM sessions WHERE user_id = 'u_rhea');`);
  check('an expired staff session → 401', (await exp.get('/api/staff/badges')).status === 401);
}

section('Pages and headers');
{
  const home = await fetch(`${BASE}/`, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } });
  check('player app loads', home.status === 200);
  check('player app sends a CSP', (home.headers.get('content-security-policy') ?? '').includes("script-src 'self'"), home.headers.get('content-security-policy'));
  const deep = await fetch(`${BASE}/admin/verify/some-id`, { headers: { Accept: 'text/html' } });
  const html = await deep.text();
  check('admin deep link serves the admin shell', deep.status === 200 && /Admin console/.test(html));
  check('admin shell sends a CSP + frame protection', (deep.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));
  const staffDeep = await fetch(`${BASE}/staff/verify/some-id`, { headers: { Accept: 'text/html' } });
  const staffHtml = await staffDeep.text();
  check('staff deep link serves the staff shell', staffDeep.status === 200 && /Staff console/.test(staffHtml) && staffHtml.includes('/staff/manifest.webmanifest'));
  check('staff shell sends a CSP + frame protection', (staffDeep.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));
  const staffLogin = await fetch(`${BASE}/staff/login/`, { headers: { Accept: 'text/html' } });
  check('/staff/login/ serves the staff shell', staffLogin.status === 200 && /Staff console/.test(await staffLogin.text()));
  const adminLogin = await fetch(`${BASE}/admin/login/`, { headers: { Accept: 'text/html' } });
  check('/admin/login/ serves the admin shell', adminLogin.status === 200 && /Admin console/.test(await adminLogin.text()));
  const userLogin = await fetch(`${BASE}/login/`, { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } });
  check('/login/ serves the player app', userLogin.status === 200 && (await userLogin.text()).includes('/js/player/app.js'));
  for (const app of ['admin', 'staff']) {
    const m = await fetch(`${BASE}/${app}/manifest.webmanifest`);
    const body = await m.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* served as HTML */
    }
    check(`/${app}/manifest.webmanifest is the JSON manifest, not the shell`, m.status === 200 && parsed?.start_url === `/${app}/`, body.slice(0, 80));
  }
  const staffRedirect = await fetch(`${BASE}/staff`, { redirect: 'manual' });
  check('/staff redirects to /staff/', staffRedirect.status === 301 && staffRedirect.headers.get('location')?.endsWith('/staff/'));
  const redirect = await fetch(`${BASE}/admin`, { redirect: 'manual' });
  check('/admin redirects to /admin/', redirect.status === 301 && redirect.headers.get('location')?.endsWith('/admin/'));
  const missing = await anon.get('/api/nope');
  check('unknown API path → JSON 404', missing.status === 404 && missing.data.error.code === 'NOT_FOUND');
}

section('Wording');
{
  const all = seenBodies.join('\n');
  check('the API never says "Payment received"', !/payment received/i.test(all));
  const stored = sql(`SELECT password_hash FROM users WHERE password_hash != '';`)[0].results;
  check('no stored password HMAC appears in any response', stored.length > 0 && stored.every((u) => !all.includes(u.password_hash)));
  check('no password column names in any response', !/password_(hash|salt|scheme|iterations)/.test(all));
  check('no storage keys in any response', !all.includes('proofs/b_') && !all.includes('r2_key'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`Failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
