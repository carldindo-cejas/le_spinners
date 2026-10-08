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
import { adminAccountSql } from './lib/admin-account.mjs';
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
// Invoke the installed CLI directly, keeping SQL/paths outside shell parsing.
function execute(options) {
  return spawnSync(process.execPath,[join(root,'node_modules','wrangler','bin','wrangler.js'),'d1','execute','DB',
    remote?'--remote':'--local',...options,'--json'],{cwd:root,encoding:'utf8',windowsHide:true});
}

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
const preflight=execute([`--command=SELECT id,auth_version FROM users WHERE email=${sql(email)}`]);
if(preflight.status!==0) {
  console.error('Account lookup failed. Check database access and apply migration 0015 before provisioning.');
  process.exit(preflight.status??1);
}
const expected=JSON.parse(preflight.stdout)[0]?.results?.[0]??null;
const changeId=`auth_${toBase64Url(randomBytes(16))}`;
const statement=adminAccountSql({id,email,name,hash,salt,iterations:PASSWORD_ITERATIONS,scheme:PASSWORD_SCHEME,role,now,changeId,expected});

// A short-lived file inside the project (.wrangler/ is git-ignored); relative so paths with spaces are safe on Windows.
const rel = `.wrangler/tmp/create-admin-${randomBytes(6).toString('hex')}.sql`;
mkdirSync(join(root, '.wrangler', 'tmp'), { recursive: true });
writeFileSync(join(root, rel), statement, { mode: 0o600 });
let result;
try {
  result=execute([`--file=${rel}`]);
} finally {
  rmSync(join(root, rel), { force: true });
}
if(result.status!==0) {
  // A CLI/database error may contain SQL; never echo credential-bearing output.
  console.error('Account provisioning failed. Check database access/schema and retry the controlled reset.');
  process.exit(result.status??1);
}
const applied=JSON.parse(result.stdout).some(batch=>batch.results?.some(row=>row.applied===1));
if(!applied) {
  console.error('The account changed during provisioning or its outcome could not be confirmed. Check its current state before retrying.');
  process.exit(1);
}
console.log(`\n${role === 'admin' ? 'Admin' : 'Staff'} account ready for ${email} (${remote ? 'deployed' : 'local'} database). Sign in at /${role}/login.`);
