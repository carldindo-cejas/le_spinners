import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { app, fixture, NOW } from './helpers/readiness.mjs';

function alignWrites(f, count, match) {
  let arrived = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.DB.beforeWrite = async statements => {
    if (!statements.some(match)) return;
    if (++arrived === count) { f.DB.beforeWrite = null; release(); }
    await gate;
  };
}

test('10 concurrent case variants of one court name have one winner and name conflicts', async t => {
  const f = fixture(t), originalCount = f.DB.count('resources');
  alignWrites(f, 10, statement => statement.sql.includes('INSERT INTO resources'));
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => app.createResource(f.c, f.admin,
    app.resourceCreateSchema.parse({ activity: 'pickleball', name: i % 2 ? 'Concurrent Court' : 'concurrent court' }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const result of results.filter(r => r.status === 'rejected')) assert.equal(result.reason.code, 'NAME_TAKEN');
  assert.equal(f.DB.count('resources'), originalCount + 1);
  assert.equal(f.DB.count('resources', "name='Concurrent Court' COLLATE NOCASE"), 1);
});

test('concurrent renames cannot give two existing courts the same name', async t => {
  const f = fixture(t);
  alignWrites(f, 2, statement => statement.sql.includes('UPDATE resources SET'));
  const results = await Promise.allSettled(['court-1', 'court-2'].map(id => app.updateResource(f.c, f.admin, id,
    app.resourceUpdateSchema.parse({ name: 'Renamed court' }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['SCHEDULE_CHANGED', 'NAME_TAKEN'].includes(results.find(r => r.status === 'rejected').reason.code));
  assert.equal(f.DB.count('resources', "name='Renamed court' COLLATE NOCASE"), 1);
});

test('resource name backstop applies to direct inserts, updates and disabled resources', t => {
  const f = fixture(t);
  f.DB.sqlite.exec("UPDATE resources SET status='disabled' WHERE id='court-1'");
  assert.throws(() => f.DB.sqlite.prepare(`INSERT INTO resources(id,activity,name,sort_order,status,price_member,price_non_member,created_at,updated_at)
    VALUES('duplicate-court','pickleball','court 1',99,'active',1,1,?,?)`).run(NOW,NOW), /UNIQUE constraint failed/);
  assert.throws(() => f.DB.sqlite.exec("UPDATE resources SET name='COURT 1' WHERE id='court-2'"), /UNIQUE constraint failed/);
  f.DB.sqlite.exec("UPDATE resources SET name='Court 1' WHERE id='table-1'");
  assert.equal(f.DB.count('resources', "name='Court 1' COLLATE NOCASE"), 2, 'Different activities retain independent names');
});

test('preflight detects duplicate legacy names and migration refuses them without removing history', t => {
  const f = fixture(t);
  f.DB.sqlite.exec('DROP INDEX uq_resources_activity_name');
  f.DB.sqlite.exec("UPDATE resources SET name='court 1' WHERE id='court-2'");
  const inventory = readFileSync('scripts/audit-resource-names.sql','utf8');
  const before = f.DB.sqlite.prepare(inventory).all();
  assert.equal(before.length, 1);
  assert.equal(before[0].duplicate_count, 2);
  assert.deepEqual(JSON.parse(before[0].resource_ids).sort(), ['court-1','court-2']);
  assert.throws(() => f.DB.sqlite.exec(readFileSync('migrations/0019_resource_name_identity.sql','utf8')), /UNIQUE constraint failed/);
  assert.equal(f.DB.count('resources', "name='Court 1' COLLATE NOCASE"), 2);
  f.DB.sqlite.exec("UPDATE resources SET name='Court 2' WHERE id='court-2'");
  f.DB.sqlite.exec(readFileSync('migrations/0019_resource_name_identity.sql','utf8'));
  assert.deepEqual(f.DB.sqlite.prepare(inventory).all(), []);
});
