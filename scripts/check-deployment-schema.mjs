// Read-only deployment gate: code must never be released ahead of its D1 schema.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const flags = process.argv.slice(2);
if (flags.some(flag => flag !== '--local' && flag !== '--remote') || flags.length > 1) {
  throw Error('Use node scripts/check-deployment-schema.mjs [--remote|--local]. The default is --remote.');
}
const target = flags[0] ?? '--remote';
const config = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8')).config;
const database = config.d1_databases.find(binding => binding.binding === 'DB');
if (!database) throw Error('The configured Worker has no DB binding.');
const expected = readdirSync(path.resolve(root, database.migrations_dir ?? 'migrations')).filter(name => name.endsWith('.sql')).sort();
// Only migration names and table names are read; no account or booking rows.
const query = "SELECT name FROM d1_migrations ORDER BY id; SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('mutation_authorization_guard','payment_methods');";
const result = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', target, '--command', query, '--json'], {
  cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CI: 'true' },
});
if (result.error || result.status !== 0) {
  console.error('Deployment schema check could not read the configured database. Deployment has been stopped.');
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}
let response;
try { response = JSON.parse(result.stdout); } catch {
  console.error('Deployment schema check received an unexpected database response. Deployment has been stopped.');
  process.exit(1);
}
if (!Array.isArray(response) || response.length !== 2 || response.some(entry => entry.success !== true || !Array.isArray(entry.results))) {
  console.error('Deployment schema check received incomplete database results. Deployment has been stopped.');
  process.exit(1);
}
const applied = new Set(response[0].results.map(row => row.name));
const tables = new Set(response[1].results.map(row => row.name));
const pending = expected.filter(name => !applied.has(name));
const missingTables = ['mutation_authorization_guard', 'payment_methods'].filter(name => !tables.has(name));
if (pending.length || missingTables.length) {
  console.error('Deployment stopped: the configured database is missing required schema.');
  if (pending.length) console.error('Pending migrations: ' + pending.join(', '));
  if (missingTables.length) console.error('Missing tables: ' + missingTables.join(', '));
  console.error(`Apply the reviewed migrations with npm run db:migrate:${target === '--local' ? 'local' : 'remote'}, then rerun the deployment check.`);
  process.exit(1);
}
console.log(`Deployment schema ready (${target.slice(2)}): ${expected.length} migrations applied and required operation/payment tables present.`);
