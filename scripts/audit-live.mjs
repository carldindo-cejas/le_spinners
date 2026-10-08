// Read-only audit: SELECT/PRAGMA and Cloudflare metadata only. No provider sends.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = process.cwd();
const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const config = ts.parseConfigFileTextToJson('wrangler.jsonc', fs.readFileSync('wrangler.jsonc', 'utf8')).config;
if (config.name !== 'le-spinners' || config.d1_databases[0].database_id !== '359085b7-5fbe-4d85-9db8-7ab2dc39ee57') throw Error('Unexpected audit target');
const evidence = { timestamp: new Date().toISOString(), target: config.name, origin: config.vars.APP_ORIGIN, checks: [], inventories: [], errors: [] };
function outcome(data) {
  const failedChecks = data.checks.filter(check => check.passed !== true).map(check => check.name);
  const inventoryFailures = [];
  let candidateCounters = 0;
  for (const inventory of data.inventories) {
    if (!Array.isArray(inventory.results) || inventory.results.length === 0) {
      inventoryFailures.push({ file: inventory.file, reason: 'Missing query execution evidence' });
      continue;
    }
    for (const result of inventory.results) {
      if (result.success !== true || result.rows_written !== 0 || !Array.isArray(result.results)) {
        inventoryFailures.push({ file: inventory.file, reason: 'Query lacks successful zero-write evidence' });
        continue;
      }
      for (const row of result.results) {
        if ('candidates' in row) {
          candidateCounters++;
          if (!Number.isSafeInteger(row.candidates) || row.candidates !== 0) {
            inventoryFailures.push({ file: inventory.file, reason: 'Anomaly count requires review' });
          }
        }
      }
      if (/^PRAGMA\s+foreign_key_check/i.test(inventory.query) && result.results.length !== 0) {
        inventoryFailures.push({ file: inventory.file, reason: 'Foreign-key violations require review' });
      }
      if (/^PRAGMA\s+quick_check/i.test(inventory.query) &&
          (result.results.length !== 1 || result.results[0].quick_check !== 'ok')) {
        inventoryFailures.push({ file: inventory.file, reason: 'Database quick_check is not ok' });
      }
    }
  }
  const passed = data.errors.length === 0 && failedChecks.length === 0 && inventoryFailures.length === 0;
  return { passed, passedChecks: data.checks.length - failedChecks.length, failedChecks,
    inventoryExecutions: data.inventories.length, candidateCounters, inventoryFailures, executionErrorCount: data.errors.length };
}
if (process.argv.includes('--summarize-existing')) {
  const prior = JSON.parse(fs.readFileSync('.wrangler/audit-live-evidence.json', 'utf8'));
  const result = { timestamp: new Date().toISOString(), evidenceTimestamp: prior.timestamp,
    method: 'Offline evaluation of recorded evidence; no new requests', ...outcome(prior) };
  fs.writeFileSync('.wrangler/audit-live-outcome.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
function command(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CI: 'true' }, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw Error(`${args.slice(0, 3).join(' ')} failed (exit ${r.status})`);
  return r.stdout;
}
if (process.argv.includes('--retry-failed')) {
  const prior = JSON.parse(fs.readFileSync('.wrangler/audit-live-evidence.json', 'utf8'));
  prior.priorErrors = [...(prior.priorErrors || []), ...prior.errors];
  const failed = prior.errors; prior.errors = [];
  for (const { file, query } of failed) {
    if (!query || !/^(SELECT|WITH|PRAGMA (foreign_key_check|quick_check))\b/i.test(query) || /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH)\b/i.test(query)) throw Error('Retry requires a verified read-only query');
    try {
      const result = JSON.parse(command(['d1', 'execute', 'DB', '--remote', '--command', query, '--json']));
      if (result.some(r => r.meta?.rows_written > 0)) throw Error('Unexpected rows written');
      prior.inventories.push({ file, query, retry: true, results: result.map(r => ({ success: r.success, results: r.results, rows_read: r.meta?.rows_read, rows_written: r.meta?.rows_written })) });
    } catch (e) { prior.errors.push({ file, query, error: e.message }); }
  }
  prior.retryTimestamp = new Date().toISOString();
  fs.writeFileSync('.wrangler/audit-live-evidence.json', JSON.stringify(prior, null, 2) + '\n');
  console.log(JSON.stringify({ retried: failed.length, remainingErrors: prior.errors, results: prior.inventories.filter(r => r.retry).map(r => r.results) }, null, 2));
  process.exit(outcome(prior).passed ? 0 : 1);
}
if (process.argv.includes('--refresh-assets')) {
  const prior = JSON.parse(fs.readFileSync('.wrangler/audit-live-evidence.json', 'utf8'));
  prior.checks = prior.checks.filter(check => !check.name.startsWith('asset '));
  const deployed = JSON.parse(fs.readFileSync('.wrangler/releases/2026-10-07T14-04-34-785Z/candidate.json', 'utf8'));
  prior.sourceDriftFromDeployed = deployed.files.filter(entry => /^(src\\|public\\)/.test(entry.file) && fs.existsSync(entry.file) && crypto.createHash('sha256').update(fs.readFileSync(entry.file)).digest('hex') !== entry.sha256).map(entry => entry.file.replaceAll('\\', '/'));
  for (const file of ['public/sw.js', 'public/js/core/booking-time.js', 'public/js/core/history.js', 'public/js/admin/screens/messages.js', 'public/js/admin/screens/facilities.js']) {
    try {
      const r = await fetch(prior.origin + '/' + file.replace(/^public\//, ''), { signal: AbortSignal.timeout(20000) });
      const remote = Buffer.from(await r.arrayBuffer()), local = fs.readFileSync(file);
      prior.checks.push({ name: 'asset ' + file, passed: r.status === 200 && remote.equals(local), detail: { status: r.status, matches: remote.equals(local), localSha256: crypto.createHash('sha256').update(local).digest('hex'), remoteSha256: crypto.createHash('sha256').update(remote).digest('hex') } });
    } catch (e) { prior.checks.push({ name: 'asset ' + file, passed: false, detail: { error: e.message } }); }
  }
  prior.assetRefreshTimestamp = new Date().toISOString();
  fs.writeFileSync('.wrangler/audit-live-evidence.json', JSON.stringify(prior, null, 2) + '\n');
  console.log(JSON.stringify({ checks: prior.checks.map(({ name, passed }) => ({ name, passed })), sourceDriftFromDeployed: prior.sourceDriftFromDeployed }, null, 2));
  process.exit(outcome(prior).passed ? 0 : 1);
}
function metadata(name, args, select) {
  try { evidence[name] = select(JSON.parse(command(args))); }
  catch (e) { evidence.errors.push({ check: name, error: e.message }); }
}
metadata('deployments', ['deployments', 'list', '--json'], rows => rows.map(r => ({ id: r.id, created_on: r.created_on, versions: r.versions })));
metadata('database', ['d1', 'info', 'DB', '--json'], r => ({ uuid: r.uuid, name: r.name, file_size: r.file_size, num_tables: r.num_tables, version: r.version }));
metadata('secretNames', ['secret', 'list', '--format', 'json'], rows => rows.map(r => r.name));
for (const [name, args] of [
  ['r2PublicAccess', ['r2', 'bucket', 'dev-url', 'get', 'le-spinners-proofs']],
  ['r2CustomDomains', ['r2', 'bucket', 'domain', 'list', 'le-spinners-proofs']],
]) {
  try { evidence[name] = command(args).replace(/\x1b\[[0-9;]*m/g, '').trim(); }
  catch (e) { evidence.errors.push({ check: name, error: e.message }); }
}
const inventoryFiles = ['scripts/readiness-inventory.sql', 'scripts/auth-inventory.sql', 'scripts/storage-inventory.sql', 'scripts/outbox-inventory.sql'];
if (fs.existsSync('scripts/audit-schedule-inventory.sql')) inventoryFiles.push('scripts/audit-schedule-inventory.sql');
const extra = [
  "SELECT name, applied_at FROM d1_migrations ORDER BY id",
  "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM bookings) AS bookings, (SELECT COUNT(*) FROM booking_credits) AS credits, (SELECT COUNT(*) FROM credit_transactions WHERE kind='refund') AS refunds, (SELECT COUNT(*) FROM payment_proofs) AS proofs",
  'PRAGMA quick_check',
];
const queries = inventoryFiles.flatMap(file => fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean).map(sql => ({ file, sql }))).concat(extra.map(sql => ({ file: 'audit-summary', sql })));
for (const { file, sql } of queries) {
  if (!/^(SELECT|WITH|PRAGMA (foreign_key_check|quick_check))\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH)\b/i.test(sql)) throw Error('Non-read-only inventory statement');
  try {
    const result = JSON.parse(command(['d1', 'execute', 'DB', '--remote', '--command', sql, '--json']));
    if (result.some(r => r.meta?.rows_written > 0)) throw Error('Unexpected rows written');
    evidence.inventories.push({ file, query: sql, results: result.map(r => ({ success: r.success, results: r.results, rows_read: r.meta?.rows_read, rows_written: r.meta?.rows_written })) });
  } catch (e) { evidence.errors.push({ file, query: sql, error: e.message }); }
}
const origin = evidence.origin;
function record(name, passed, detail) { evidence.checks.push({ name, passed, detail }); }
await Promise.all(['/', '/staff/', '/admin/', '/revenue/', '/api/health', '/api/facility', '/api/auth/session', '/api/bookings', '/api/staff/summary', '/api/admin/revenue/accounting'].map(async route => {
  try {
    const r = await fetch(origin + route, { signal: AbortSignal.timeout(20000), redirect: 'manual' });
    const protectedRoute = ['/api/bookings', '/api/staff/summary', '/api/admin/revenue/accounting'].includes(route);
    const headers = Object.fromEntries(['content-security-policy', 'x-content-type-options', 'cache-control', 'x-request-id', 'access-control-allow-origin'].map(h => [h, r.headers.get(h)]));
    const expected = protectedRoute ? 401 : 200;
    record(route, r.status === expected && headers['x-content-type-options'] === 'nosniff' && Boolean(headers['content-security-policy']) && (!route.startsWith('/api/') || (headers['cache-control'] === 'no-store' && Boolean(headers['x-request-id']))), { status: r.status, headers });
    await r.body?.cancel();
  } catch (e) { record(route, false, { error: e.message }); }
}));
await Promise.all(['public/sw.js', 'public/js/core/booking-time.js', 'public/js/core/history.js', 'public/js/admin/screens/messages.js', 'public/js/admin/screens/facilities.js'].map(async file => {
  try {
    const r = await fetch(origin + '/' + file.replace(/^public\//, ''), { signal: AbortSignal.timeout(20000) });
    const remote = Buffer.from(await r.arrayBuffer()), local = fs.readFileSync(file);
    record('asset ' + file, r.status === 200 && remote.equals(local), { status: r.status, matches: remote.equals(local), localSha256: crypto.createHash('sha256').update(local).digest('hex'), remoteSha256: crypto.createHash('sha256').update(remote).digest('hex') });
  } catch (e) { record('asset ' + file, false, { error: e.message }); }
}));
// Origin rejection runs before authentication, request parsing, or route writes.
try {
  const r = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: 'https://audit.invalid', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
  const body = await r.json();
  record('cross-origin mutation rejected before auth', r.status === 403 && body.error?.code === 'BAD_ORIGIN' && !r.headers.has('access-control-allow-origin'), { status: r.status, code: body.error?.code, cors: r.headers.get('access-control-allow-origin') });
} catch (e) { record('cross-origin mutation rejected before auth', false, { error: e.message }); }
fs.writeFileSync('.wrangler/audit-live-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ checks: evidence.checks.map(({ name, passed }) => ({ name, passed })), inventoryQueries: evidence.inventories.length, errors: evidence.errors, database: evidence.database, secretNames: evidence.secretNames }, null, 2));
process.exitCode = outcome(evidence).passed ? 0 : 1;
