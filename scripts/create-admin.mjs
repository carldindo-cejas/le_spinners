#!/usr/bin/env node
/**
 * Creates (or resets) a staff or admin account.
 *
 *   npm run create-admin                       → local dev database
 *   npm run create-admin -- --remote           → your deployed D1 database
 *   npm run create-admin -- --role staff       → front-desk staff: the staff console (/staff/), no settings or prices
 *
 * You'll be asked for the email, name, password and PASSWORD_PEPPER (hidden input;
 * the pepper is never accepted as a command-line argument). Like the browser, this
 * script derives clientHash = PBKDF2-SHA256(password, new salt, 600 000) locally, then
 * writes only HMAC-SHA256(pepper, clientHash), the salt, scheme and iteration count.
 * The password, clientHash and pepper are never written to disk.
 *
 * For --remote, enter the same value you set with `wrangler secret put PASSWORD_PEPPER`.
 * For the local database, press Enter to use PASSWORD_PEPPER from .dev.vars.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ask,
  askHidden,
  deriveClientHash,
  localPepper,
  newPasswordSalt,
  normalizeEmail,
  PASSWORD_ITERATIONS,
  PASSWORD_SCHEME,
  pepperHash,
  root,
  toBase64Url,
} from './lib/passwords.mjs';

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const roleArg = args[args.indexOf('--role') + 1];
const role = args.includes('--role') ? roleArg : 'admin';
if (role !== 'admin' && role !== 'staff') {
  console.error('--role must be "admin" or "staff".');
  process.exit(1);
}

const sql = (v) => `'${String(v).replace(/'/g, "''")}'`;

const email = normalizeEmail(await ask('Email: '));
const name = (await ask('Full name: ')).trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('That email looks wrong.');
  process.exit(1);
}
if (name.length < 2 || name.length > 80) {
  console.error('Enter a name between 2 and 80 characters.');
  process.exit(1);
}
const password = await askHidden('Password (12+ characters): ');
if (password.length < 12 || password.length > 128) {
  console.error('Use a password of at least 12 characters for staff accounts.');
  process.exit(1);
}
const confirm = await askHidden('Repeat password: ');
if (confirm !== password) {
  console.error('Passwords did not match.');
  process.exit(1);
}

let pepper = await askHidden(remote ? 'PASSWORD_PEPPER (the production secret): ' : 'PASSWORD_PEPPER (Enter = use .dev.vars): ');
if (!pepper && !remote) pepper = localPepper() ?? '';
if (pepper.length < 32) {
  console.error(remote ? 'Enter the production PASSWORD_PEPPER (32+ characters).' : 'No PASSWORD_PEPPER found. Add it to .dev.vars (see .dev.vars.example).');
  process.exit(1);
}
if (remote) {
  if (pepper.startsWith('dev-only-')) {
    console.error('That is the development pepper. Use the production secret you set with wrangler secret put PASSWORD_PEPPER.');
    process.exit(1);
  }
  // A typo here would lock the account out, so confirm it like the password.
  if ((await askHidden('Repeat PASSWORD_PEPPER: ')) !== pepper) {
    console.error('Peppers did not match.');
    process.exit(1);
  }
}

console.log(`Deriving the password hash (PBKDF2, ${PASSWORD_ITERATIONS.toLocaleString('en-US')} iterations)…`);
const salt = newPasswordSalt();
const hash = pepperHash(pepper, await deriveClientHash(password, salt, PASSWORD_ITERATIONS));
const id = `u_${toBase64Url(randomBytes(16))}`;
const now = Date.now();
const statement = `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations, password_scheme, role, membership, status, created_at, updated_at)
VALUES (${sql(id)}, ${sql(email)}, ${sql(name)}, ${sql(hash)}, ${sql(salt)}, ${PASSWORD_ITERATIONS}, ${sql(PASSWORD_SCHEME)}, ${sql(role)}, 'none', 'active', ${now}, ${now})
ON CONFLICT (email) DO UPDATE SET name = excluded.name, password_hash = excluded.password_hash, password_salt = excluded.password_salt,
  password_iterations = excluded.password_iterations, password_scheme = excluded.password_scheme, role = excluded.role, status = 'active', updated_at = excluded.updated_at;
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ${sql(email)});`;

// A short-lived file inside the project (.wrangler/ is git-ignored); relative so paths with spaces are safe on Windows.
const rel = `.wrangler/tmp/create-admin-${randomBytes(6).toString('hex')}.sql`;
mkdirSync(join(root, '.wrangler', 'tmp'), { recursive: true });
writeFileSync(join(root, rel), statement, { mode: 0o600 });
const isWindows = process.platform === 'win32';
let result;
try {
  result = spawnSync(isWindows ? 'npx.cmd' : 'npx', ['wrangler', 'd1', 'execute', 'DB', remote ? '--remote' : '--local', `--file=${rel}`], {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
  });
} finally {
  rmSync(join(root, rel), { force: true });
}
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`\n${role === 'admin' ? 'Admin' : 'Staff'} account ready for ${email} (${remote ? 'deployed' : 'local'} database). Sign in at /${role}/login.`);
