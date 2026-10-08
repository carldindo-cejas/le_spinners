// Deterministic integration harness: real application functions and SQLite transactions,
// synthetic data, mocked R2. This does not emulate Cloudflare quotas or isolate scheduling.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const root = path.resolve(process.env.SYSTEM_TEST_ROOT || '.');
mkdirSync('.wrangler', { recursive: true });
const output = path.resolve(mkdtempSync('.wrangler/readiness-tests-'), 'application.mjs');
await build({
  stdin: {
    contents: ['lib/payments', 'lib/images', 'lib/bookings', 'lib/settings', 'lib/credits', 'lib/disruptions',
      'lib/facility', 'lib/validate', 'lib/time', 'lib/maintenance', 'lib/notify', 'lib/outbox', 'lib/storage', 'lib/auth', 'lib/crypto', 'lib/chat', 'lib/pagination', 'routes/notifications', 'routes/auth', 'routes/credits', 'routes/bookings', 'routes/admin', 'routes/admin-settings']
      // The preserved pre-M06 tree exports flushOutbox from notify, before outbox existed.
      .filter(name => !['lib/outbox','lib/storage','lib/pagination'].includes(name) || existsSync(path.join(root,`src/worker/${name}.ts`)))
      .concat('routes/revenue').map(name => `export * from './src/worker/${name}.ts';`).join('\n'),
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: output,
});
export const app = await import(pathToFileURL(output).href);
export const NOW = Date.parse('2026-10-07T02:00:00Z');
export const TOMORROW = '2026-10-08';

class Statement {
  constructor(db, sql, args = []) { Object.assign(this, { db, sql, args }); }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  execute() {
    this.db.beforeExecute?.(this);
    let { sql, args } = this;
    if (/\?\d+/.test(sql)) {
      const mapped = [];
      sql = sql.replace(/\?(\d+)/g, (_, n) => { mapped.push(args[Number(n) - 1]); return '?'; });
      args = mapped;
    }
    const results = this.db.sqlite.prepare(sql).all(...args);
    const changes = this.db.sqlite.prepare('SELECT changes() AS n').get().n;
    return { results, success: true, meta: { changes } };
  }
  async first(column) { await this.db.beforeRead?.(this); const row = this.execute().results[0] ?? null; return column && row ? row[column] : row; }
  async all() { await this.db.beforeRead?.(this); return this.execute(); }
  async run() { await this.db.beforeWrite?.([this]); return this.execute(); }
}

export class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    await this.beforeWrite?.(statements);
    this.sqlite.exec('BEGIN');
    let result;
    try {
      result = statements.map(stmt => stmt.execute());
      this.sqlite.exec('COMMIT');
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
    await this.afterCommit?.(statements);
    return result;
  }
  rows(sql, ...args) { return this.sqlite.prepare(sql).all(...args); }
  one(sql, ...args) { return this.sqlite.prepare(sql).get(...args); }
  count(table, where = '1') { return this.one(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).n; }
}

export function fixture(t) {
  t.mock.method(Date, 'now', () => NOW);
  app.invalidateSettings();
  const DB = new TestD1();
  for (const file of readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    DB.sqlite.exec(readFileSync(path.join(root, 'migrations', file), 'utf8'));
  }
  DB.sqlite.exec(readFileSync(path.join(root, 'db/facility.sql'), 'utf8'));
  DB.sqlite.exec("UPDATE opening_hours SET is_open=1, open_min=0, close_min=1440; UPDATE resources SET status='active', open_play=0;");
  for (const [id, role] of [['test_player', 'player'], ['test_other', 'player'], ['test_admin', 'admin'], ['test_staff', 'staff']]) {
    DB.sqlite.prepare('INSERT INTO users(id,email,name,password_hash,role,membership,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, `${id}@example.invalid`, id, '', role, 'member', NOW, NOW);
  }
  const objects = new Map();
  const env = {
    DB, PROOFS: {
      async put(key, bytes) { objects.set(key, bytes); return {key,size:bytes.byteLength,uploaded:new Date(Date.now())}; },
      async delete(key) { objects.delete(key); },
    },
    TZ_OFFSET_MINUTES: '480', APP_ORIGIN: 'http://127.0.0.1:8787',
    FILE_SIGNING_SECRET: 'synthetic-signing-secret-for-isolated-tests-only',
  };
  const user = id => ({ ...DB.one('SELECT * FROM users WHERE id=?', id), session_id: 'synthetic-session' });
  const background = [];
  const c = { env, req: { header() { return null; } }, executionCtx: { waitUntil(promise) { background.push(promise); } } };
  t.after(async () => { await Promise.all(background); DB.sqlite.close(); });
  return { DB, env, objects, c, player: user('test_player'), other: user('test_other'), admin: user('test_admin'), staff: user('test_staff') };
}

export function seedBooking(DB, status = 'TEMPORARY') {
  DB.sqlite.prepare('INSERT INTO bookings(id,ref,user_id,resource_id,date,start_min,end_min,status,amount_due,rate,hold_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('test_booking', 'TEST-ONLY', 'test_player', 'court-1', TOMORROW, 600, 660, status, 50000, 'member', NOW + 600000, NOW, NOW);
}

export const hold = { resourceId: 'court-1', date: TOMORROW, starts: [600] };
export const refundInput = { amount: 10000, method: 'cash', reference: null, note: null, idempotencyKey: 'test-refund-001' };
export const proofFile = () => new File([readFileSync(path.join(root, 'db/seed-proofs/juan.png'))], 'synthetic.png');
export async function credit(f) {
  return app.issueManualCredit(f.env, f.admin, {
    userId: f.player.id, amount: 50000, reason: 'Synthetic test credit', sourceBookingId: null, idempotencyKey: 'test-credit-001',
  }, NOW);
}
