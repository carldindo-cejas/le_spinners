#!/usr/bin/env node
/**
 * Rebuilds the LOCAL development database and file bucket from scratch:
 *   1. deletes local D1 + R2 state under .wrangler/state
 *   2. applies migrations/
 *   3. loads db/facility.sql (courts and tables) and db/seed.dev.sql (demo people and bookings)
 *   4. uploads the demo payment screenshots to the local R2 bucket
 *
 * Never touches your Cloudflare account. Usage:  npm run db:reset:local
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPepper, localPepper } from './lib/passwords.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// The demo account hashes in db/seed.dev.sql are keyed with the dev pepper.
if (localPepper() !== devPepper()) {
  console.error(
    'PASSWORD_PEPPER in .dev.vars must match the development value in .dev.vars.example,\n' +
      'or the demo accounts cannot sign in. Copy that line into .dev.vars and run this again.',
  );
  process.exit(1);
}
const isWindows = process.platform === 'win32';
const BUCKET = 'le-spinners-proofs';

function wrangler(args) {
  console.log(`\n> wrangler ${args.join(' ')}`);
  const result = spawnSync(isWindows ? 'npx.cmd' : 'npx', ['wrangler', ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, CI: process.env.CI ?? 'true' }, // skip interactive confirmations for local-only work
  });
  if (result.status !== 0) {
    console.error(`\nwrangler ${args[0]} failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

for (const dir of ['d1', 'r2']) {
  const path = join(root, '.wrangler', 'state', 'v3', dir);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    console.log(`Removed ${path}`);
  }
}

wrangler(['d1', 'migrations', 'apply', 'DB', '--local']);
wrangler(['d1', 'execute', 'DB', '--local', '--file=db/facility.sql']);
wrangler(['d1', 'execute', 'DB', '--local', '--file=db/seed.dev.sql']);

const sizes = [];
for (const name of ['maria', 'pedro', 'juan']) {
  const file = join('db', 'seed-proofs', `${name}.png`);
  wrangler(['r2', 'object', 'put', `${BUCKET}/proofs/seed/${name}.png`, '--file', file, '--content-type', 'image/png', '--local']);
  sizes.push(`UPDATE payment_proofs SET size = ${statSync(join(root, file)).size} WHERE id = 'p_${name}';`);
}
// A labelled demo QR so the payment screen shows the QR panel (replace it in Settings).
wrangler(['r2', 'object', 'put', `${BUCKET}/settings/gcash-qr/demo.png`, '--file', join('db', 'seed-proofs', 'demo-gcash-qr.png'), '--content-type', 'image/png', '--local']);
sizes.push(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('gcash_qr_key', 'settings/gcash-qr/demo.png', 0);`);
// Written to a file (not --command) so Windows shells don't split the SQL on spaces.
mkdirSync(join(root, '.wrangler', 'tmp'), { recursive: true });
writeFileSync(join(root, '.wrangler', 'tmp', 'seed-proof-sizes.sql'), sizes.join('\n'));
wrangler(['d1', 'execute', 'DB', '--local', '--file=.wrangler/tmp/seed-proof-sizes.sql']);

console.log(`
Local database ready.
  Start the app:   npm run dev   →  http://localhost:8787
  Demo password:   demo-pass-2026
  Player  (/login):        juan.delacruz@example.com (member)   pedro.cruz@example.com (non-member)
  Staff   (/staff/login):  rhea.lim@lespinners.example
  Admin   (/admin/login):  ana.reyes@lespinners.example
`);
