// Read-only current D1 integrity refresh. Only aggregate candidates and trigger DDL are retained.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const config = ts.parseConfigFileTextToJson('wrangler.jsonc', fs.readFileSync('wrangler.jsonc', 'utf8')).config;
if (config.name !== 'le-spinners' || config.d1_databases?.find(item => item.binding === 'DB')?.database_id !== '359085b7-5fbe-4d85-9db8-7ab2dc39ee57') {
  throw Error('Unexpected audit target');
}
const source = fs.readFileSync('migrations/0009_canonical_dates.sql', 'utf8');
const expected = [...source.matchAll(/CREATE TRIGGER\s+([a-z_]+)\b[\s\S]*?END;/g)]
  .map(match => ({ name: match[1], sql: match[0] }));
if (expected.length !== 10) throw Error('Expected ten canonical-date trigger definitions');
const normalize = sql => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
const slotNames = ['slot_parent_identity_mismatches', 'slots_outside_parent_span',
  'slot_parent_envelope_mismatches', 'intra_booking_slot_overlap_pairs'];
const slotQueries = fs.readFileSync('scripts/audit-schedule-inventory.sql', 'utf8').replace(/--[^\n]*/g, '')
  .split(';').map(query => query.trim()).filter(query => slotNames.some(name => query.includes(`'${name}'`)));
if (slotQueries.length !== 4) throw Error('Expected four aggregate slot integrity queries');
const triggerQuery = `SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name IN (${expected.map(item => `'${item.name}'`).join(',')}) ORDER BY name`;
const evidence = { timestamp: new Date().toISOString(), target: config.name, inventories: [], rowsWritten: 0, errors: [] };
const cli = path.resolve('node_modules/wrangler/bin/wrangler.js');
function execute(sql, file) {
  if (!/^SELECT\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH)\b/i.test(sql)) {
    throw Error('Only explicit read-only SELECT statements are allowed');
  }
  const result = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', '--remote', '--command', sql, '--json'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: 'true', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.status !== 0) throw Error(`Read-only D1 query failed (exit ${result.status ?? 'unknown'})`);
  let rows;
  try { rows = JSON.parse(result.stdout); }
  catch { throw Error('Read-only D1 query returned an unsupported JSON response'); }
  if (!Array.isArray(rows) || rows.some(row => row.success !== true || row.meta?.rows_written !== 0 || !Array.isArray(row.results))) {
    throw Error('D1 query did not confirm successful read-only execution');
  }
  evidence.inventories.push({ file, query: sql, refresh: true,
    results: rows.map(row => ({ success: row.success, results: row.results, rows_read: row.meta.rows_read, rows_written: row.meta.rows_written })) });
  return rows.flatMap(row => row.results);
}
try {
  const counts = slotQueries.flatMap(query => execute(query, 'scripts/audit-schedule-inventory.sql'));
  if (counts.length !== 4 || counts.some(row => !slotNames.includes(row.check_name) || !Number.isSafeInteger(row.candidates))) {
    throw Error('Invalid aggregate slot integrity result');
  }
  evidence.slotChecks = counts;
  evidence.slotChecksPassed = counts.every(row => row.candidates === 0);
  const actual = execute(triggerQuery, 'migrations/0009_canonical_dates.sql');
  evidence.canonicalDateTriggers = expected.map(trigger => {
    const deployed = actual.find(item => item.name === trigger.name);
    return { name: trigger.name, present: Boolean(deployed), matchesExpected: Boolean(deployed && normalize(deployed.sql) === normalize(trigger.sql)),
      actualSql: deployed?.sql ?? null };
  });
  evidence.canonicalDateSchemaPassed = evidence.canonicalDateTriggers.every(trigger => trigger.present && trigger.matchesExpected);
  if (!evidence.slotChecksPassed) evidence.errors.push({ check: 'slot integrity', error: 'Positive candidates require parent/slot and booking-history review before any repair' });
  if (!evidence.canonicalDateSchemaPassed) evidence.errors.push({ check: 'canonical dates', error: 'Missing or drifted date triggers require schema review before H01 acceptance' });
} catch (error) { evidence.errors.push({ error: error.message }); }
evidence.finishedAt = new Date().toISOString();
fs.writeFileSync('.wrangler/audit-integrity-live.json', JSON.stringify(evidence, null, 2) + '\n');
if (process.argv.includes('--append') && evidence.errors.length === 0) {
  const prior = JSON.parse(fs.readFileSync('.wrangler/audit-live-evidence.json', 'utf8'));
  prior.inventories.push(...evidence.inventories);
  prior.integrityRefreshTimestamp = evidence.finishedAt;
  prior.canonicalDateSchemaPassed = evidence.canonicalDateSchemaPassed;
  prior.canonicalDateTriggers = evidence.canonicalDateTriggers;
  fs.writeFileSync('.wrangler/audit-live-evidence.json', JSON.stringify(prior, null, 2) + '\n');
}
console.log(JSON.stringify({ timestamp: evidence.timestamp, finishedAt: evidence.finishedAt,
  successfulSelects: evidence.inventories.length, rowsWritten: evidence.rowsWritten, slotChecks: evidence.slotChecks,
  canonicalDateSchemaPassed: evidence.canonicalDateSchemaPassed,
  canonicalDateTriggers: evidence.canonicalDateTriggers?.map(({ name, present, matchesExpected }) => ({ name, present, matchesExpected })), errors: evidence.errors }, null, 2));
process.exitCode = evidence.errors.length ? 1 : 0;
