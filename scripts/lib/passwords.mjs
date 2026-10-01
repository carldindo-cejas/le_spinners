/**
 * Password helpers for the Node scripts. The PBKDF2 step is the same module the
 * browser uses (public/js/core/password.js); the HMAC step matches the Worker
 * (src/worker/lib/crypto.ts).
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveClientHash,
  fromBase64Url,
  newPasswordSalt,
  normalizeEmail,
  PASSWORD_ITERATIONS,
  PASSWORD_SCHEME,
  toBase64Url,
} from '../../public/js/core/password.js';

export { deriveClientHash, newPasswordSalt, normalizeEmail, PASSWORD_ITERATIONS, PASSWORD_SCHEME, toBase64Url };

export const root = fileURLToPath(new URL('../..', import.meta.url));

/** HMAC-SHA256(pepper, clientHash) as base64url: the value stored in users.password_hash. */
export function pepperHash(pepper, clientHash) {
  return toBase64Url(createHmac('sha256', Buffer.from(pepper, 'utf8')).update(fromBase64Url(clientHash)).digest());
}

/** The committed development pepper from .dev.vars.example (never used in production). */
export function devPepper() {
  const text = readFileSync(join(root, '.dev.vars.example'), 'utf8');
  const m = /^PASSWORD_PEPPER=(.+)$/m.exec(text);
  if (!m) throw new Error('PASSWORD_PEPPER is missing from .dev.vars.example');
  return m[1].trim();
}

/** PASSWORD_PEPPER from .dev.vars, or null when the file or value is missing. */
export function localPepper() {
  try {
    const m = /^PASSWORD_PEPPER=(.+)$/m.exec(readFileSync(join(root, '.dev.vars'), 'utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

let pipedLines = null;

/** Piped (non-terminal) stdin: read it once, then hand out one line per prompt. */
async function nextPipedLine(question) {
  if (!pipedLines) {
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    pipedLines = data.split(/\r?\n/);
  }
  process.stdout.write(`${question}\n`);
  return pipedLines.shift() ?? '';
}

/** Reads a visible line. */
export async function ask(question) {
  if (!process.stdin.isTTY) return nextPipedLine(question);
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Reads a line without echoing it (shows • per character). */
export function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return nextPipedLine(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += ch;
        process.stdout.write('•');
      }
    };
    stdin.on('data', onData);
  });
}
