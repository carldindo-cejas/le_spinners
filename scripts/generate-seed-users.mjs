#!/usr/bin/env node
/**
 * Regenerates the demo accounts block in db/seed.dev.sql (LOCAL DEVELOPMENT ONLY).
 *
 *   npm run db:seed:generate
 *
 * Every demo account gets the password below. The salts are derived from the email so
 * the output is reproducible, and the HMACs use the committed development pepper from
 * .dev.vars.example. The production pepper is never involved.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveClientHash, devPepper, PASSWORD_ITERATIONS, PASSWORD_SCHEME, pepperHash, root, toBase64Url } from './lib/passwords.mjs';

const DEMO_PASSWORD = 'demo-pass-2026';
const BEGIN = '-- BEGIN GENERATED USERS (npm run db:seed:generate)';
const END = '-- END GENERATED USERS';

const people = [
  ['u_juan', 'juan.delacruz@example.com', 'Juan Dela Cruz', '0998 765 4321', 'player', 'member', 'LS-M-0142', '2027-03-31'],
  ['u_maria', 'maria.santos@example.com', 'Maria Santos', '0917 555 0114', 'player', 'member', 'LS-M-0087', '2027-01-31'],
  ['u_pedro', 'pedro.cruz@example.com', 'Pedro Cruz', '0928 555 0192', 'player', 'none', null, null],
  ['u_kim', 'kim.aquino@example.com', 'Kim Aquino', '0995 555 0158', 'player', 'pending', 'LS-M-0201', null],
  ['u_ana', 'ana.reyes@lespinners.example', 'Ana Reyes', '0917 555 0100', 'admin', 'none', null, null],
];

const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const NOW = 'CAST(unixepoch() AS INTEGER) * 1000';
const pepper = devPepper();

const rows = [];
for (const [id, email, name, phone, role, membership, code, until] of people) {
  const salt = toBase64Url(createHash('sha256').update(`le-spinners-dev-seed:${email}`).digest().subarray(0, 16));
  const hash = pepperHash(pepper, await deriveClientHash(DEMO_PASSWORD, salt, PASSWORD_ITERATIONS));
  rows.push(
    `  (${[id, email, name, phone, hash, salt].map(q).join(', ')}, ${PASSWORD_ITERATIONS}, ${q(PASSWORD_SCHEME)}, ` +
      `${[role, membership, code, until].map(q).join(', ')}, 'active', ${NOW}, ${NOW})`,
  );
}

const block = `${BEGIN}
-- Every demo account uses the password:  ${DEMO_PASSWORD}   (hashes use the dev pepper in .dev.vars.example)
INSERT INTO users (id, email, name, phone, password_hash, password_salt, password_iterations, password_scheme, role, membership, member_code, member_until, status, created_at, updated_at) VALUES
${rows.join(',\n')};
${END}`;

const file = join(root, 'db', 'seed.dev.sql');
const seed = readFileSync(file, 'utf8');
const start = seed.indexOf(BEGIN);
const end = seed.indexOf(END);
if (start === -1 || end === -1) throw new Error(`Markers not found in db/seed.dev.sql:\n  ${BEGIN}\n  ${END}`);
writeFileSync(file, seed.slice(0, start) + block + seed.slice(end + END.length));
console.log(`Updated ${people.length} demo accounts in db/seed.dev.sql`);
