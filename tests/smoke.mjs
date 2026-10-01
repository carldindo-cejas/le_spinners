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
    const h = { ...headers };
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

  async login(email, password = PASSWORD) {
    const r = await this.post('/api/auth/login', { email, clientHash: await this.proof(email, password) });
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

/** Triggers the Worker's scheduled() handler (needs `wrangler dev --test-scheduled`). */
async function runCron() {
  const res = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
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
const ana = new Client('ana');
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
  const a = await ana.login('ana.reyes@lespinners.example');
  check('staff can sign in', a.data.user.role === 'admin');
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

  const ok = await ana.post(`/api/admin/bookings/${juanBooking.id}/approve`, {});
  check('approve → CONFIRMED', ok.status === 200 && ok.data.booking.status === 'CONFIRMED', ok.data);
  check('records who approved', ok.data.booking.confirmedBy === 'Ana Reyes');
  const twice = await ana.post(`/api/admin/bookings/${juanBooking.id}/approve`, {});
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
  const rej = await ana.post(`/api/admin/bookings/${id}/reject`, { reason: 'Amount does not match the booking total.', keepHold: true });
  check('reject with resubmit window → REJECTED', rej.status === 200 && rej.data.booking.status === 'REJECTED', rej.data);
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
  const rej2 = await ana.post(`/api/admin/bookings/${id}/reject`, { reason: 'Screenshot is not readable.', keepHold: false });
  check('reject and release → EXPIRED', rej2.data.booking.status === 'EXPIRED', rej2.data);
  const free = await maria.get(`/api/availability?activity=table_tennis&date=${D}`);
  check('slot is free again', free.data.resources.find((r) => r.id === 'table-3').slots.find((x) => x.start === s.start)?.state === 'available');
}

section('Booking chat');
{
  const long = await juan.post(`/api/bookings/${juanBooking.id}/messages`, { body: 'x'.repeat(1001) });
  check('message over 1000 chars → 422', long.status === 422);
  const blank = await juan.post(`/api/bookings/${juanBooking.id}/messages`, { body: '   ' });
  check('blank message → 422', blank.status === 422);
  const sent = await juan.post(`/api/bookings/${juanBooking.id}/messages`, { body: 'Can I bring a guest? <b>hi</b>' });
  check('player message → 201', sent.status === 201, sent.data);
  check('message stored as plain text', sent.data.messages.at(-1)?.body === 'Can I bring a guest? <b>hi</b>');

  const inbox = await ana.get('/api/admin/messages');
  const conv = inbox.data.conversations.find((x) => x.bookingId === juanBooking.id);
  check('staff inbox shows the thread as unread', conv?.unread === 1, conv);
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

section('Cancellation');
{
  const late = sql(`SELECT id FROM bookings WHERE ref LIKE '%-909';`)[0].results[0].id;
  const soon = new Date(Date.now() + TZ_MS + 2 * 3_600_000);
  const date = soon.toISOString().slice(0, 10);
  const start = soon.getUTCHours() * 60;
  sql(`UPDATE bookings SET date = '${date}', start_min = ${start}, end_min = ${start + 60} WHERE id = '${late}';`);
  const tooLate = await kim.post(`/api/bookings/${late}/cancel`, {});
  check('cancel within 24 h → 422 CANCEL_WINDOW_CLOSED', tooLate.status === 422 && tooLate.data.error.code === 'CANCEL_WINDOW_CLOSED', tooLate.data);

  const ok = await juan.post(`/api/bookings/${juanBooking.id}/cancel`, { reason: 'Rain plans changed' });
  check('cancel more than 24 h ahead → CANCELLED', ok.status === 200 && ok.data.booking.status === 'CANCELLED', ok.data);
  const staffNotes = await ana.get('/api/admin/notifications?filter=unresolved');
  check('staff notified of the cancellation', staffNotes.data.notifications.some((x) => x.type === 'booking_cancelled' && x.bookingId === juanBooking.id));
}

section('Email / SMS queue and settings');
{
  const out = await ana.get('/api/admin/outbox');
  check('verification email queued with the right subject', out.data.items.some((o) => o.channel === 'email' && o.subject === 'Le Spinners — Booking Requires Payment Verification'));
  check('SMS queued (no provider yet)', out.data.items.some((o) => o.channel === 'sms' && o.status === 'queued'));
  const s = await ana.get('/api/admin/settings');
  check('admin can edit settings', s.data.canEdit === true && s.data.delivery.sms === 'queued');
  const bad = await ana.put('/api/admin/settings', { gcashNumber: '12345' });
  check('invalid GCash number → 422', bad.status === 422, bad.data);
  const good = await ana.put('/api/admin/settings', { gcashName: 'Le Spinners Recreational Hub', gcashNumber: '0917 123 4567' });
  check('valid settings update → 200', good.status === 200, good.data);
  const kimAdmin = await kim.get('/api/admin/settings');
  check('player cannot read staff settings → 403', kimAdmin.status === 403);
}

section('Pages and headers');
{
  const home = await fetch(`${BASE}/`, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } });
  check('player app loads', home.status === 200);
  check('player app sends a CSP', (home.headers.get('content-security-policy') ?? '').includes("script-src 'self'"), home.headers.get('content-security-policy'));
  const deep = await fetch(`${BASE}/admin/verify/some-id`, { headers: { Accept: 'text/html' } });
  const html = await deep.text();
  check('staff deep link serves the staff shell', deep.status === 200 && /Staff/i.test(html));
  check('staff shell sends a CSP + frame protection', (deep.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));
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
