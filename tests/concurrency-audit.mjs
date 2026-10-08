// Real HTTP -> workerd -> local D1/R2, in a disposable synthetic database.
// Never loads local operator secrets, remote bindings, or email provider credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';
import ts from 'typescript';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { deriveClientHash } from '../public/js/core/password.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.resolve(process.env.CONCURRENCY_SOURCE_ROOT || root);
assert.ok(source === path.resolve(root) || source.startsWith(path.resolve(root, '.wrangler') + path.sep));
const port = Number(process.env.CONCURRENCY_PORT || 8830);
const seconds = Number(process.env.CONCURRENCY_SECONDS || 60);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(Number.isInteger(seconds) && seconds >= 0 && seconds <= 1800);
const baseline = process.env.CONCURRENCY_BASELINE === '1';
const largeUploads = process.env.CONCURRENCY_LARGE_UPLOADS === '1';
const transport = process.env.CONCURRENCY_TRANSPORT || 'miniflare';
assert.ok(['miniflare', 'wrangler'].includes(transport));
const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(path.join(root, '.wrangler'), { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, '.wrangler', 'concurrency-audit-'));
for (const dir of ['src', 'public', 'migrations', 'scripts', 'tests', 'db']) fs.cpSync(path.join(source, dir), path.join(scratch, dir), { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'worker-configuration.d.ts']) fs.copyFileSync(path.join(source, file), path.join(scratch, file));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const config = ts.parseConfigFileTextToJson('wrangler.jsonc', fs.readFileSync(path.join(source, 'wrangler.jsonc'), 'utf8')).config;
assert.ok(!config.d1_databases.some(v => v.remote) && !config.r2_buckets.some(v => v.remote));
assert.ok(!config.vars?.RESEND_API_KEY, 'Provider credentials prohibited in local audit bindings');
config.name = 'le-spinners-concurrency-local';
config.vars.APP_ORIGIN = base;
config.d1_databases[0].database_name = 'concurrency-local-only';
config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
config.r2_buckets[0].bucket_name = 'concurrency-local-only';
config.assets.run_worker_first.push('/__scheduled');
fs.writeFileSync(path.join(scratch, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
const devVars = fs.readFileSync(path.join(source, '.dev.vars.example'), 'utf8');
assert.ok(!/^RESEND_API_KEY\s*=/m.test(devVars));
fs.writeFileSync(path.join(scratch, '.dev.vars'), devVars);
fs.mkdirSync(path.join(scratch, '.wrangler'));
const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
let server, mf;
function wrangler(args) {
  assert.ok(args.includes('--local') && !args.includes('--remote'));
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: scratch, encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, CI: 'true' } });
  assert.ifError(r.error);
  fs.appendFileSync(path.join(scratch, '.wrangler/setup.log'), (r.stdout || '') + (r.stderr || ''));
  assert.equal(r.status, 0, 'Local setup/query failed; inspect ' + scratch);
  return r.stdout;
}
async function sql(text) {
  if (mf) {
    // Use the running runtime's binding. A synchronous second Wrangler process
    // blocks this HTTP coordinator and opens the same persistence separately.
    // Live fixture statements contain no embedded semicolons in SQL literals.
    const db = await mf.getD1Database('DB');
    const statements = text.split(';').map(value => value.trim()).filter(Boolean);
    return (await db.batch(statements.map(value => db.prepare(value)))).flatMap(r => r.results || []);
  }
  fs.writeFileSync(path.join(scratch, '.wrangler/query.sql'), text);
  return JSON.parse(wrangler(['d1', 'execute', 'DB', '--local', '--file', '.wrangler/query.sql', '--json'])).flatMap(r => r.results || []);
}
wrangler(['d1', 'migrations', 'apply', 'DB', '--local']);
wrangler(['d1', 'execute', 'DB', '--local', '--file', 'db/facility.sql']);
await sql(fs.readFileSync(path.join(source, 'db/seed.dev.sql'), 'utf8').split('-- END GENERATED USERS')[0].split(/-- BEGIN GENERATED USERS[^\r\n]*\r?\n/)[1]);
const seeds = ["UPDATE opening_hours SET is_open=1,open_min=0,close_min=1440; UPDATE settings SET value='' WHERE key IN ('staff_alert_emails','staff_alert_sms');"];
for (let i = 0; i < 50; i++) seeds.push(`INSERT INTO users(id,email,name,password_hash,password_salt,password_iterations,password_scheme,role,membership,status,created_at,updated_at) SELECT 'concurrent-${i}','concurrent-${i}@example.invalid','Synthetic Concurrent ${i}',password_hash,password_salt,password_iterations,password_scheme,'player','member','active',created_at,updated_at FROM users WHERE id='u_juan';`);
await sql(seeds.join('\n'));
await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(resolve)); });
const log = fs.openSync(path.join(scratch, '.wrangler/server.log'), 'a');
if (transport === 'wrangler') {
  server = spawn(process.execPath, [cli, 'dev', '--local', '--test-scheduled', '--port', String(port), '--inspector-port', '0'], { cwd: scratch, stdio: ['ignore', log, log], windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, CI: 'true' } });
} else {
  const bundle = path.join(scratch, '.wrangler', 'concurrency-worker.mjs');
  await build({ entryPoints: [path.join(scratch, 'src/worker/index.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: bundle });
  const syntheticBindings = Object.fromEntries(devVars.split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  class AuditLog extends Log { log(message) { fs.writeSync(log, String(message) + '\n'); } }
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'concurrency-direct-http', rootPath: scratch, modules: true, scriptPath: bundle,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags || [],
    host: '127.0.0.1', port, cf: false, unsafeTriggerHandlers: true, unsafeLocalExplorer: false,
    resourcePersistencePath: path.join(scratch, '.wrangler', 'state', 'v3'),
    d1Databases: { DB: config.d1_databases[0].database_id }, r2Buckets: { PROOFS: config.r2_buckets[0].bucket_name },
    bindings: { ...config.vars, ...syntheticBindings, APP_ORIGIN: base },
    serviceBindings: { ASSETS: async () => new Response('Static assets use the separate browser suite.', { status: 404 }) },
    log: new AuditLog(LogLevel.INFO), handleStructuredLogs: entry => fs.writeSync(log, JSON.stringify(entry) + '\n'),
  }));
}
const samples = [], scenarios = [], failures = [], sourceHashes = {};
for (const dir of ['src', 'public', 'migrations']) {
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else sourceHashes[path.relative(scratch, f).replaceAll('\\', '/')] = createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } };
  walk(path.join(scratch, dir));
}
let count = 0, active = 0, maxActive = 0, admin, cookies, soak;
const key = () => 'concurrency-audit-' + (++count);
const future = n => new Date(Date.now() + 480 * 60000 + n * 86400000).toISOString().slice(0, 10);
const slot = (i, day) => ({ resourceId: 'court-' + (1 + i % 3), date: future(day), starts: [Math.floor(i / 3) * 60] });
async function request(label, method, url, body, cookie = '', headers = {}) {
  const start = performance.now(); active++; maxActive = Math.max(maxActive, active);
  let status = 0, code;
  try {
    const form = body instanceof FormData;
    const runtimeUrl = mf && url.startsWith('/__scheduled') ? url.replace('/__scheduled', '/cdn-cgi/local/scheduled') : url;
    const r = await fetch(base + runtimeUrl, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: base } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? (form ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(30000) });
    status = r.status; const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    code = data?.error?.code;
    return { status, data, cookie: r.headers.getSetCookie().find(c => c.startsWith('ls_session='))?.split(';')[0] };
  } catch (e) { failures.push({ label, error: e.name, message: e.message }); throw e; }
  finally { active--; samples.push({ label, status, code, ms: performance.now() - start }); }
}
const get = (label, url, cookie) => request(label, 'GET', url, null, cookie);
const post = (label, url, body, cookie, headers) => request(label, 'POST', url, body, cookie, headers);
function okay(r, statuses = [200]) { assert.ok(statuses.includes(r.status), JSON.stringify({ status: r.status, data: r.data })); return r; }
async function login(email, portal = 'user') {
  const salt = okay(await post('salt', '/api/auth/salt', { email })).data;
  const hash = await deriveClientHash('demo-pass-2026', salt.salt, salt.iterations);
  const r = okay(await post('login', '/api/auth/' + portal + '/login', { email, clientHash: hash }));
  assert.ok(r.cookie); return r.cookie;
}
async function wave(label, jobs, check) {
  const start = performance.now();
  // Drain every launched request before disposal, including transport failures.
  const settled = await Promise.allSettled(jobs.map(job => job()));
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  const results = settled.map(result => result.value);
  const statuses = {}, codes = {};
  for (const r of results) { statuses[r.status] = (statuses[r.status] || 0) + 1; if (r.data?.error?.code) codes[r.data.error.code] = (codes[r.data.error.code] || 0) + 1; }
  const entry = { name: label, concurrency: jobs.length, elapsedMs: performance.now() - start, statuses, codes };
  scenarios.push(entry); console.log(JSON.stringify(entry));
  check?.(results); return results;
}
async function holds(n, day, label, withCron = false) {
  const jobs = Array.from({ length: n }, (_, i) => () => post(label, '/api/bookings', slot(i, day), cookies[i], { 'Idempotency-Key': key() }));
  if (withCron) jobs.push(() => get('cron', '/__scheduled?cron=*+*+*+*+*', admin));
  const responses = await wave(label, jobs, rs => {
    rs.slice(0, n).forEach(r => okay(r, baseline ? [201, 409] : [201]));
    if (!baseline) assert.equal(new Set(rs.slice(0, n).map(r => r.data.booking.id)).size, n, 'Distinct requests must create distinct bookings');
    if (withCron) okay(rs[n]);
  });
  return responses.flatMap((r, i) => r.status === 201 ? [{ booking: r.data.booking, cookie: cookies[i] }] : []);
}
async function release(bookings, label = 'release') {
  if (!bookings.length) return;
  await wave(label, bookings.map(({ booking, cookie }) => () => post(label, `/api/bookings/${booking.id}/release`, {}, cookie)), rs => rs.forEach(r => okay(r)));
}
async function proof(label, b, cookie, bytes) {
  const form = new FormData(); form.set('file', new File([bytes || fs.readFileSync(path.join(source, 'db/seed-proofs/juan.png'))], 'synthetic.png', { type: 'image/png' }));
  form.set('amountPesos', (b.amountDue / 100).toFixed(2));
  return post(label, `/api/bookings/${b.id}/proof`, form, cookie);
}
async function prepare(n, day, startIndex = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const cookie = cookies[(i + startIndex) % 50];
    const r = okay(await post('prepare hold', '/api/bookings', slot(i, day), cookie, { 'Idempotency-Key': key() }), [201]);
    out.push({ booking: r.data.booking, cookie });
  }
  return out;
}
async function approve(label, b, cookie = admin) {
  const detail = okay(await get('proof detail', `/api/admin/bookings/${b.id}`, admin)).data;
  return post(label, `/api/admin/bookings/${b.id}/approve`, { checklist: true, proofId: detail.proofs[0].id }, cookie);
}
async function invariantResults() {
  return sql(`
    SELECT 'live_overlap' AS finding,COUNT(*) AS candidates FROM booking_times a JOIN bookings ba ON ba.id=a.booking_id JOIN booking_times b ON a.booking_id<b.booking_id AND a.date=b.date AND a.resource_id=b.resource_id AND a.start_min<b.end_min AND a.end_min>b.start_min JOIN bookings bb ON bb.id=b.booking_id WHERE (ba.status IN ('CONFIRMED','PAYMENT_SUBMITTED') OR (ba.status IN ('TEMPORARY','REJECTED') AND ba.hold_expires_at>unixepoch('now')*1000)) AND (bb.status IN ('CONFIRMED','PAYMENT_SUBMITTED') OR (bb.status IN ('TEMPORARY','REJECTED') AND bb.hold_expires_at>unixepoch('now')*1000));
    SELECT 'duplicate_approval' AS finding,COUNT(*) AS candidates FROM (SELECT booking_id FROM booking_events WHERE type='approved' GROUP BY booking_id HAVING COUNT(*)>1);
    SELECT 'multiple_submitted_proofs' AS finding,COUNT(*) AS candidates FROM (SELECT booking_id FROM payment_proofs WHERE status='submitted' GROUP BY booking_id HAVING COUNT(*)>1);
    SELECT 'credit_ledger_mismatch' AS finding,COUNT(*) AS candidates FROM booking_credits c WHERE remaining!=(SELECT COALESCE(SUM(amount),0) FROM credit_transactions WHERE credit_id=c.id);
    SELECT 'missing_creation_event' AS finding,COUNT(*) AS candidates FROM bookings b WHERE NOT EXISTS(SELECT 1 FROM booking_events e WHERE e.booking_id=b.id AND e.type IN ('created','credit_booked','console_booked'));
    SELECT 'detached_proof_upload' AS finding,COUNT(*) AS candidates FROM payment_proofs p WHERE NOT EXISTS(SELECT 1 FROM storage_uploads s WHERE s.r2_key=p.r2_key AND s.state='attached');
    SELECT 'missing_expiry_event' AS finding,COUNT(*) AS candidates FROM bookings b WHERE b.status='EXPIRED' AND NOT EXISTS(SELECT 1 FROM booking_events e WHERE e.booking_id=b.id AND e.type='expired');
    SELECT 'slot_parent_mismatch' AS finding,COUNT(*) AS candidates FROM booking_slots s JOIN bookings b ON b.id=s.booking_id WHERE s.resource_id!=b.resource_id OR s.date!=b.date OR s.start_min<b.start_min OR s.end_min>b.end_min;
    SELECT 'proof_count' AS measurement,COUNT(*) AS count FROM payment_proofs;
    SELECT 'approved_count' AS measurement,COUNT(*) AS count FROM booking_events WHERE type='approved';
    SELECT 'expiry_count' AS measurement,COUNT(*) AS count FROM booking_events WHERE type='expired';
    PRAGMA quick_check; PRAGMA foreign_key_check;`);
}
function save(state, extra = {}) {
  const metrics = {};
  for (const label of new Set(samples.map(s => s.label))) {
    const rows = samples.filter(s => s.label === label), times = rows.map(s => s.ms).sort((a, b) => a - b);
    const p = x => times[Math.min(times.length - 1, Math.ceil(times.length * x) - 1)];
    metrics[label] = { requests: rows.length, p50: p(.5), p95: p(.95), p99: p(.99), max: times.at(-1), statuses: Object.fromEntries([...new Set(rows.map(r => r.status))].map(status => [status, rows.filter(r => r.status === status).length])) };
  }
  const result = { state, recordedAt: new Date().toISOString(), environment: 'isolated localhost HTTP -> workerd, real local D1/R2, synthetic accounts, no provider', transport, scratch, baseline, accounts: 50, maxActiveRequests: maxActive, requests: samples.length, soakSecondsRequested: seconds, largeUploads, sourceHashes, scenarios, metrics, failures, platform: { workerCpuMs: null, workerMemoryBytes: null, d1RowsRead: null, d1RowsWritten: null, deployedPlan: null }, ...extra };
  fs.writeFileSync(path.join(scratch, '.wrangler/results.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(root, '.wrangler', baseline ? 'concurrency-audit-baseline.json' : 'concurrency-audit-latest.json'), JSON.stringify(result, null, 2) + '\n');
}
// Valid, random-pixel static PNG near the 10 MiB proof cap; no AI or image provider.
function largePng() {
  const crc = b => { let c = 0xffffffff; for (const v of b) { c ^= v; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name), n = Buffer.alloc(4), tail = Buffer.alloc(4); n.writeUInt32BE(data.length); tail.writeUInt32BE(crc(Buffer.concat([type, data]))); return Buffer.concat([n, type, data, tail]); };
  const w = 1800, h = 1800, pixels = randomBytes(h * (w * 3 + 1)); for (let i = 0; i < h; i++) pixels[i * (w * 3 + 1)] = 0;
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
try {
  if (mf) {
    await mf.ready;
    assert.equal((await (await mf.getD1Database('DB')).prepare("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'concurrent-%'").first()).n, 50, 'Runtime must use the exact disposable seeded database');
  }
  let ready = false;
  for (let i = 0; i < 180; i++) { if (server && server.exitCode !== null) throw Error('Local server exited'); try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 250)); }
  assert.ok(ready);
  admin = await login('ana.reyes@lespinners.example', 'admin');
  // Password-equivalent values are derived independently, not supplied to production.
  const loginStart = performance.now();
  cookies = await Promise.all(Array.from({ length: 50 }, (_, i) => login(`concurrent-${i}@example.invalid`)));
  scenarios.push({ name: '50 concurrent independent sign-in flows, one shared IP', concurrency: 50, elapsedMs: performance.now() - loginStart, successfulSessions: cookies.length });
  for (const n of [10, 15, 20, 50]) {
    await wave(`availability ${n}`, cookies.slice(0, n).map(cookie => () => get('availability', `/api/availability?activity=pickleball&date=${future(1)}`, cookie)), rs => rs.forEach(r => okay(r)));
    await wave(`availability days ${n}`, cookies.slice(0, n).map(cookie => () => get('availability days', '/api/availability/days?activity=pickleball', cookie)), rs => rs.forEach(r => okay(r)));
    const bs = await holds(n, [10,15,20,50].indexOf(n) + 1, `distinct holds ${n}`);
    await release(bs);
  }
  for (const n of [10, 20, 50]) {
    const body = { resourceId: 'court-1', date: future(5), starts: [n] }; body.starts = [Math.floor(n / 10) * 120];
    const rs = await wave(`same slot ${n}`, cookies.slice(0, n).map(cookie => () => post('same slot', '/api/bookings', body, cookie, { 'Idempotency-Key': key() })), rs => { assert.equal(rs.filter(r => r.status === 201).length, 1); rs.forEach(r => { okay(r, [201, 409]); if (r.status === 409) assert.equal(r.data.error.code, 'SLOT_TAKEN'); }); });
    const index = rs.findIndex(r => r.status === 201); await release([{ booking: rs[index].data.booking, cookie: cookies[index] }]);
  }
  const repeatBody = slot(0, 6), repeatKey = key();
  const repeated = await wave('10 identical request keys', Array.from({ length: 10 }, () => () => post('key replay', '/api/bookings', repeatBody, cookies[49], { 'Idempotency-Key': repeatKey })), rs => { rs.forEach(r => okay(r, [201])); assert.equal(new Set(rs.map(r => r.data.booking.id)).size, 1); });
  await release([{ booking: repeated[0].data.booking, cookie: cookies[49] }]);
  const duplicate = await wave('10 same user different keys', Array.from({ length: 10 }, () => () => post('new key duplicate', '/api/bookings', slot(1, 6), cookies[48], { 'Idempotency-Key': key() })), rs => { assert.equal(rs.filter(r => r.status === 201).length, 1); rs.forEach(r => { okay(r, [201, 409, 422]); if (r.status === 422) assert.equal(r.data.error.code, 'OVERLAP_OWN'); if (r.status === 409) assert.ok(['SLOT_TAKEN', 'OVERLAP_OWN'].includes(r.data.error.code)); }); });
  await release([{ booking: duplicate.find(r => r.status === 201).data.booking, cookie: cookies[48] }]);
  // Existing records expire at the exact coordinates being reused. Expiry is real clock based.
  const old = await prepare(10, 7);
  await sql(old.map(({ booking }) => `UPDATE bookings SET hold_expires_at=unixepoch('now')*1000-1 WHERE id='${booking.id}';`).join('\n'));
  const replacement = await holds(10, 7, '10 holds while expiry cron runs', true);
  assert.equal(replacement.length, baseline ? replacement.length : 10);
  for (let pass = 0; pass < 3; pass++) okay(await get('expiry cron drain', '/__scheduled?cron=*+*+*+*+*', admin));
  const expiryState = await sql(`SELECT COUNT(*) AS expired FROM bookings WHERE id IN (${old.map(b => `'${b.booking.id}'`).join(',')}) AND status='EXPIRED'; SELECT COUNT(*) AS newer_live FROM bookings WHERE id IN (${replacement.map(b => `'${b.booking.id}'`).join(',') || "''"}) AND status='TEMPORARY';`);
  assert.equal(expiryState[0].expired, 10); assert.equal(expiryState[1].newer_live, replacement.length);
  await release(replacement);
  const payments = await prepare(10, 8);
  await wave('10 simultaneous proofs different bookings', payments.map(b => () => proof('proof upload', b.booking, b.cookie)), rs => rs.forEach(r => okay(r, [201])));
  await wave('10 simultaneous approvals', payments.map(b => () => approve('approval', b.booking)), rs => rs.forEach(r => okay(r)));
  // One proof can be persisted and one approval counted despite duplicate HTTP submissions.
  const [dupProof] = await prepare(1, 9, 47);
  await wave('10 simultaneous proofs same booking', Array.from({ length: 10 }, () => () => proof('duplicate proof', dupProof.booking, dupProof.cookie)), rs => { assert.equal(rs.filter(r => r.status === 201).length, 1); rs.forEach(r => { okay(r, [201, 409]); if (r.status === 409) assert.equal(r.data.error.code, 'ALREADY_SUBMITTED'); }); });
  await wave('10 simultaneous approvals same booking', Array.from({ length: 10 }, () => () => approve('duplicate approval', dupProof.booking)), rs => { assert.equal(rs.filter(r => r.status === 200).length, 1); rs.forEach(r => { okay(r, [200, 409]); if (r.status === 409) assert.equal(r.data.error.code, 'INVALID_STATUS'); }); });
  // Two-second windows expire during network/R2 work; an accepted proof must survive cron.
  const edge = await prepare(10, 10, 20);
  await sql(edge.map(({ booking }) => `UPDATE bookings SET hold_expires_at=unixepoch('now')*1000+2000 WHERE id='${booking.id}';`).join('\n'));
  const edgeResults = await wave('proof versus near expiry and overlapping cron', [...edge.map(b => () => proof('expiry proof', b.booking, b.cookie)), ...Array.from({ length: 3 }, () => () => get('overlapping cron', '/__scheduled?cron=*+*+*+*+*', admin))], rs => rs.forEach(r => okay(r, [200, 201, 409])));
  await new Promise(r => setTimeout(r, 2100));
  for (let pass = 0; pass < 3; pass++) okay(await get('expiry cron drain', '/__scheduled?cron=*+*+*+*+*', admin));
  const edgeRows = await sql(`SELECT id,status FROM bookings WHERE id IN (${edge.map(b => `'${b.booking.id}'`).join(',')});`);
  edge.forEach((b, i) => assert.equal(edgeRows.find(row => row.id === b.booking.id).status, edgeResults[i].status === 201 ? 'PAYMENT_SUBMITTED' : 'EXPIRED'));
  // Mixed simultaneous read/write/authenticated staff traffic, with preparation outside the wave.
  const mixed = await prepare(15, 11);
  for (const b of mixed.slice(5, 10)) okay(await proof('mixed prepare proof', b.booking, b.cookie), [201]);
  const mixedJobs = [
    ...mixed.slice(0, 5).map(b => () => proof('mixed proof', b.booking, b.cookie)),
    ...mixed.slice(5, 10).map(b => () => approve('mixed approval', b.booking)),
    ...mixed.slice(10).map(b => () => post('mixed cancellation', `/api/bookings/${b.booking.id}/release`, {}, b.cookie)),
    ...cookies.slice(15, 25).map(cookie => () => get('mixed availability', `/api/availability?activity=pickleball&date=${future(12)}`, cookie)),
    ...cookies.slice(25, 35).map(cookie => () => get('mixed dashboard', '/api/bookings?group=upcoming', cookie)),
    ...cookies.slice(35, 45).map(cookie => () => get('mixed session', '/api/auth/session', cookie)),
    ...cookies.slice(45, 50).map((cookie, i) => () => post('mixed hold', '/api/bookings', slot(i, 12), cookie, { 'Idempotency-Key': key() })),
    () => get('mixed staff dashboard', '/api/admin/dashboard', admin),
    () => get('mixed cron', '/__scheduled?cron=*+*+*+*+*', admin),
  ];
  await wave('mixed 50 players plus staff and cron', mixedJobs, rs => rs.forEach(r => okay(r, baseline ? [200, 201, 409] : [200, 201])));
  if (largeUploads) {
    const bytes = largePng(), bs = await prepare(10, 13, 10);
    scenarios.push({ name: 'near limit static PNG fixture', bytes: bytes.length, dimensions: [1800,1800] });
    await wave('10 near limit uploads', bs.map(b => () => proof('near limit proof', b.booking, b.cookie, bytes)), rs => rs.forEach(r => okay(r, [201])));
  }
  const soakStart = performance.now(); let rounds = 0;
  while (performance.now() - soakStart < seconds * 1000) {
    await wave('50 player polling soak round', cookies.map((cookie, i) => () => get('soak ' + (i % 4), [ `/api/availability?activity=pickleball&date=${future(14)}`, '/api/bookings?group=upcoming', '/api/notifications/badges', '/api/credits'][i % 4], cookie)), rs => rs.forEach(r => okay(r)));
    rounds++; save('running'); await new Promise(r => setTimeout(r, 1000));
  }
  soak = { elapsedSeconds: (performance.now() - soakStart) / 1000, rounds };
  const invariants = await invariantResults();
  for (const row of invariants) { if ('candidates' in row) assert.equal(row.candidates, 0, row.finding); else if ('quick_check' in row) assert.equal(row.quick_check, 'ok'); else if ('fkid' in row) assert.fail('Foreign key integrity violation'); }
  assert.ok(invariants.some(row => row.quick_check === 'ok'));
  if (!baseline) await wave('10 duplicate physical resource names', Array.from({ length: 10 }, (_, i) => () => post('resource create', '/api/admin/facilities', { activity: 'pickleball', name: i % 2 ? 'Concurrent Synthetic Court' : 'concurrent synthetic court' }, admin)), rs => { assert.equal(rs.filter(r => r.status === 201).length, 1); rs.forEach(r => { okay(r, [201,409]); if (r.status === 409) assert.equal(r.data.error.code, 'NAME_TAKEN'); }); });
  const serverLog = fs.readFileSync(path.join(scratch, '.wrangler/server.log'), 'utf8');
  const maintenanceFailures = (serverLog.match(/maintenance task failed/g) || []).length;
  assert.equal(maintenanceFailures, 0, 'Scheduled work must not silently fail');
  save('passed', { soak, invariants, maintenanceFailures, proxyRecoveredGetWarnings: (serverLog.match(/recovered on attempt/g) || []).length });
  console.log(JSON.stringify({ state: 'passed', scratch, requests: samples.length, maxActiveRequests: maxActive, soak }));
} catch (e) { failures.push({ name: e.name, message: e.message }); save('failed', { soak }); throw e; }
finally {
  if (server?.exitCode === null) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); else { try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); } } }
  await mf?.dispose();
  fs.closeSync(log);
}
