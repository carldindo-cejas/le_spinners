import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { app, fixture, seedBooking, NOW, TestD1 } from './helpers/readiness.mjs';
import { accountRecoverySql } from '../scripts/lib/account-recovery.mjs';

test('L01 six/twelve-month histories use partial unread indexes with exact counts',async t=>{
  const f=fixture(t);seedBooking(f.DB,'COMPLETED');
  const sql="SELECT COUNT(DISTINCT m.booking_id) AS n FROM messages m LEFT JOIN message_reads r ON r.booking_id=m.booking_id AND r.reader='staff' WHERE m.sender_role='player' AND m.kind='text' AND m.created_at>COALESCE(r.last_read_at,0)";
  const insert=f.DB.sqlite.prepare("INSERT INTO messages(id,booking_id,sender_id,sender_role,kind,body,created_at) VALUES(?,'test_booking','test_player','player',?,'Synthetic history',?)");
  const evidence=[];
  for(const months of [6,12]) {
    f.DB.sqlite.exec('DELETE FROM messages');f.DB.sqlite.exec('BEGIN');
    for(let i=0;i<months*3000;i++)insert.run('historical-'+i,i%10===0?'text':'system',NOW-months*30*86400000+i*60000);
    f.DB.sqlite.exec('COMMIT');
    const before=f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender_role='player' AND kind='text'").get().n;
    const sample=index=>{const plan=f.DB.sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all();const start=performance.now();for(let i=0;i<40;i++)f.DB.sqlite.prepare(sql).get();return {index,plan,ms:(performance.now()-start)/40};};
    f.DB.sqlite.exec('DROP INDEX idx_message_unread');const without=sample('baseline');
    f.DB.sqlite.exec("CREATE INDEX idx_message_unread ON messages(sender_role,booking_id,created_at) WHERE kind='text'");const withIndex=sample('candidate');
    assert.ok(withIndex.plan.some(r=>r.detail.includes('idx_message_unread')));assert.equal(await app.staffUnreadChats(f.DB),before?1:0);
    evidence.push({months,messages:months*3000,textRows:before,without,withIndex});
  }
  const cleanup=f.DB.sqlite.prepare('EXPLAIN QUERY PLAN SELECT key FROM rate_limits WHERE window_start<? ORDER BY window_start LIMIT 100').all(NOW);assert.ok(cleanup.some(r=>r.detail.includes('idx_rate_limits_window')));
  writeFileSync('.wrangler/readiness-growth-measurements.json',JSON.stringify({context:'Node SQLite, synthetic; milliseconds/plans are not D1 billed row or CPU measurements',evidence,cleanup},null,2)+'\n');
});

test('I01 populated pre-0002 upgrade, account recovery and backup restoration retain history',async t=>{
  const dir=mkdtempSync('.wrangler/migration-rehearsal-'),db=new DatabaseSync(path.join(dir,'before.sqlite'));
  t.after(()=>db.close());db.exec(readFileSync('migrations/0001_init.sql','utf8'));
  db.exec("INSERT INTO users(id,email,name,password_hash,role,membership,created_at,updated_at) VALUES('legacy-player','legacy@example.invalid','Synthetic legacy','synthetic-legacy-hash','player','member',1,1); INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at) VALUES('legacy-session','legacy-player',1,9999999999999,1);");
  const start=performance.now(),backup=path.resolve(dir,'backup.sqlite').replaceAll('\\','/').replaceAll("'","''");db.exec(`VACUUM INTO '${backup}'`);
  for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')&&!f.startsWith('0001')).sort())db.exec(readFileSync(path.join('migrations',file),'utf8'));
  assert.equal(db.prepare("SELECT password_scheme FROM users WHERE id='legacy-player'").get().password_scheme,'reset_required');assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
  const pepper='synthetic-upgrade-pepper-long-enough-for-tests',clientHash='A'.repeat(43),hash=await app.pepperHash(pepper,clientHash),version=db.prepare("SELECT auth_version FROM users WHERE id='legacy-player'").get().auth_version;
  db.exec(accountRecoverySql({id:'legacy-player',version,hash,salt:'S'.repeat(22),iterations:app.PASSWORD_ITERATIONS,scheme:app.PASSWORD_SCHEME,now:NOW,changeId:'recovery-1',operator:'Synthetic QA'}));
  assert.equal(db.prepare("SELECT role FROM users WHERE id='legacy-player'").get().role,'player');assert.equal(await app.verifyClientHash(pepper,clientHash,db.prepare("SELECT password_hash FROM users WHERE id='legacy-player'").get().password_hash),true);
  const unchanged=db.prepare("SELECT password_hash FROM users WHERE id='legacy-player'").get().password_hash;
  db.exec(accountRecoverySql({id:'legacy-player',version,hash:'B'.repeat(43),salt:'T'.repeat(22),iterations:app.PASSWORD_ITERATIONS,scheme:app.PASSWORD_SCHEME,now:NOW,changeId:'recovery-stale',operator:'Synthetic QA'}));assert.equal(db.prepare("SELECT password_hash FROM users WHERE id='legacy-player'").get().password_hash,unchanged);
  copyFileSync(path.join(dir,'backup.sqlite'),path.join(dir,'restored.sqlite'));const restored=new DatabaseSync(path.join(dir,'restored.sqlite'));
  assert.equal(restored.prepare("SELECT password_hash FROM users WHERE id='legacy-player'").get().password_hash,'synthetic-legacy-hash');assert.equal(restored.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');restored.close();
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  writeFileSync(path.join(dir,'evidence.json'),JSON.stringify({synthetic:true,localOnly:true,elapsedMs:performance.now()-start,upgradedThrough:'0016',restoredAccounts:1,restoredSessions:1,recoveredAccounts:1},null,2)+'\n');
});
