import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, NOW, root, TestD1 } from './helpers/readiness.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { adminAccountSql } from '../scripts/lib/admin-account.mjs';

const oldHash='A'.repeat(43),newHash='B'.repeat(43),salt='S'.repeat(22);
const freshPassword=(hash=newHash,s='T'.repeat(22))=>({clientHash:hash,salt:s,scheme:app.PASSWORD_SCHEME,iterations:app.PASSWORD_ITERATIONS});
async function setup(t,role='player') {
  const f=fixture(t);f.env.PASSWORD_PEPPER='synthetic-auth-pepper-for-deterministic-tests-only';
  const hash=await app.pepperHash(f.env.PASSWORD_PEPPER,oldHash);
  f.DB.sqlite.prepare('UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,password_scheme=?,role=? WHERE id=?')
    .run(hash,salt,app.PASSWORD_ITERATIONS,app.PASSWORD_SCHEME,role,'test_player');
  const pending=[];
  const api=new Hono(),error=(e,c)=>c.json({code:e.code??'INTERNAL'},e.status??500);
  api.onError(error);app.authRoutes.onError(error);app.meRoutes.onError(error);
  api.use('*',app.loadSession);api.route('/auth',app.authRoutes);api.route('/me',app.meRoutes);
  const request=(method,url,body,cookie='')=>api.fetch(new Request('http://localhost'+url,{method,
    headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined}),f.env,
    {waitUntil(p){pending.push(p);},passThroughOnException(){}});
  t.after(async()=>{await Promise.all(pending);});
  const portal=role==='player'?'user':role;
  const login=(hash=oldHash,cookie='')=>request('POST',`/auth/${portal}/login`,{email:'test_player@example.invalid',clientHash:hash},cookie);
  const cookie=r=>r.headers.get('Set-Cookie')?.split(';')[0]??'';
  const change=(session,password=freshPassword())=>request('POST','/me/password',{currentClientHash:oldHash,newPassword:password},session);
  const session=c=>request('GET','/auth/session',null,c);
  const active=async c=>Boolean((await (await session(c)).json()).user);
  return {...f,login,cookie,change,session,active,request};
}
function pauseWrite(f,match) {
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});const arrived=new Promise(resolve=>{entered=resolve;});
  f.DB.beforeWrite=async statements=>{if(statements.some(match)){f.DB.beforeWrite=null;entered();await gate;}};
  return {arrived,release};
}
const sessionInsert=s=>s.sql.includes('INSERT INTO sessions');
const credentialUpdate=s=>s.sql.includes('UPDATE users SET password_hash');

test('M01 regression: verified old-password login cannot survive password change',async t=>{
  const f=await setup(t);const current=f.cookie(await f.login());
  const pause=pauseWrite(f,sessionInsert),login=f.login();await pause.arrived;
  try {assert.equal((await f.change(current)).status,200);}finally {pause.release();}
  const stale=await login;assert.equal(stale.status,401);assert.equal(f.cookie(stale),'');
  assert.equal(await f.active(current),true);assert.equal(f.DB.count('sessions'),1);
});
test('M01 regression: concurrent changes have one winner and retain only its session',async t=>{
  const f=await setup(t),a=f.cookie(await f.login()),b=f.cookie(await f.login());
  const pause=pauseWrite(f,credentialUpdate),loser=f.change(a);await pause.arrived;
  try {assert.equal((await f.change(b,freshPassword('C'.repeat(43),'U'.repeat(22)))).status,200);}finally {pause.release();}
  assert.equal((await loser).status,409);assert.equal(await f.active(b),true);assert.equal(await f.active(a),false);
  assert.equal(f.DB.count('audit_log',"action='password_changed'"),1);
});
test('M01 regression: an administrative credential reset invalidates access without relying on session deletion',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login());
  f.DB.sqlite.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await app.pepperHash(f.env.PASSWORD_PEPPER,newHash),'test_player');
  assert.equal(await f.active(cookie),false);
});
test('M01 regression: disabling then re-enabling cannot resurrect an earlier session',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login());
  f.DB.sqlite.exec("UPDATE users SET status='disabled' WHERE id='test_player'; UPDATE users SET status='active' WHERE id='test_player';");
  assert.equal(await f.active(cookie),false);
});

test('M01: password change preserves its cookie, signs out other sessions, and accepts only new credentials',async t=>{
  const f=await setup(t),current=f.cookie(await f.login()),other=f.cookie(await f.login());
  const changed=await f.change(current);assert.equal(changed.status,200);assert.equal(changed.headers.get('Set-Cookie'),null);
  assert.equal(await f.active(current),true);assert.equal(await f.active(other),false);
  assert.equal((await f.login()).status,401);assert.equal((await f.login(newHash)).status,200);
  const dto=await (await f.session(current)).json();assert.equal(JSON.stringify(dto).includes('auth_version'),false);assert.equal(JSON.stringify(dto).includes('auth_change_id'),false);
});
test('M01: a stale verified login cannot replace a still-valid browser session',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login());
  const pause=pauseWrite(f,sessionInsert),pending=f.login(oldHash,cookie);await pause.arrived;
  try {assert.equal((await f.change(cookie)).status,200);}finally {pause.release();}
  const response=await pending;assert.equal(response.status,401);assert.equal(response.headers.get('Set-Cookie'),null);assert.equal(await f.active(cookie),true);
});
for(const role of ['player','staff','admin'])test(`M01: delayed ${role} login loses to disabling or role change`,async t=>{
  const f=await setup(t,role),pause=pauseWrite(f,sessionInsert),login=f.login();await pause.arrived;
  try {f.DB.sqlite.prepare('UPDATE users SET role=? WHERE id=?').run(role==='admin'?'staff':'admin','test_player');}finally {pause.release();}
  assert.equal((await login).status,401);assert.equal(f.DB.count('sessions'),0);
});
test('M01: disabling during a verified password change prevents credential mutation',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login()),before=f.DB.one("SELECT password_hash FROM users WHERE id='test_player'").password_hash;
  const pause=pauseWrite(f,credentialUpdate),change=f.change(cookie);await pause.arrived;
  try {f.DB.sqlite.exec("UPDATE users SET status='disabled' WHERE id='test_player'");}finally {pause.release();}
  assert.equal((await change).status,409);assert.equal(f.DB.one("SELECT password_hash FROM users WHERE id='test_player'").password_hash,before);
  assert.equal(f.DB.count('audit_log',"action='password_changed'"),0);
});
test('M01: revocation during password verification cannot restore a logged-out session',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login()),pause=pauseWrite(f,credentialUpdate),change=f.change(cookie);await pause.arrived;
  try {assert.equal((await f.request('POST','/auth/logout',{},cookie)).status,200);}finally {pause.release();}
  assert.equal((await change).status,409);assert.equal(f.DB.count('sessions'),0);
});
test('M01: a database failure rolls back credentials, retained version, revocation and audit',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login());await f.login();
  const before=f.DB.one("SELECT password_hash,auth_version FROM users WHERE id='test_player'");
  f.DB.beforeExecute=stmt=>{if(stmt.sql.includes('DELETE FROM sessions')){f.DB.beforeExecute=null;throw Error('Injected transaction failure');}};
  assert.equal((await f.change(cookie)).status,500);
  assert.deepEqual(f.DB.one("SELECT password_hash,auth_version FROM users WHERE id='test_player'"),before);assert.equal(f.DB.count('sessions'),2);
  assert.equal(await f.active(cookie),true);assert.equal(f.DB.count('audit_log',"action='password_changed'"),0);
});
test('M01: same-payload racing changes do not create a second winning audit',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login()),pause=pauseWrite(f,credentialUpdate),first=f.change(cookie);await pause.arrived;
  try {assert.equal((await f.change(cookie)).status,200);}finally {pause.release();}
  assert.equal((await first).status,409);assert.equal(f.DB.count('audit_log',"action='password_changed'"),1);assert.equal(await f.active(cookie),true);
});
test('M01: profile edits keep sessions valid; role changes require a fresh portal login',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login());
  assert.equal((await f.request('PATCH','/me',{name:'Updated synthetic name'},cookie)).status,200);assert.equal(await f.active(cookie),true);
  f.DB.sqlite.exec("UPDATE users SET role='staff' WHERE id='test_player'");assert.equal(await f.active(cookie),false);
  assert.equal((await f.request('POST','/auth/user/login',{email:'test_player@example.invalid',clientHash:oldHash})).status,401);
  assert.equal((await f.request('POST','/auth/staff/login',{email:'test_player@example.invalid',clientHash:oldHash})).status,200);
});
test('M01: a lost committed password-change response preserves the winner and revokes old credentials',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login());const other=f.cookie(await f.login());
  f.DB.afterCommit=stmts=>{if(stmts.some(credentialUpdate)){f.DB.afterCommit=null;throw Error('Lost committed response');}};
  assert.equal((await f.change(cookie)).status,500);assert.equal(await f.active(cookie),true);assert.equal(await f.active(other),false);
  assert.equal((await f.login()).status,401);assert.equal((await f.login(newHash)).status,200);assert.equal(f.DB.count('audit_log',"action='password_changed'"),1);
});
test('M01: delayed activity touch cannot rewrite a session promoted by a password change',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login());
  f.DB.sqlite.exec(`UPDATE sessions SET last_seen_at=${NOW-2*3600000}`);
  const pause=pauseWrite(f,s=>s.sql.includes('UPDATE sessions SET last_seen_at'));
  await f.session(cookie);await pause.arrived;
  try {assert.equal((await f.change(cookie)).status,200);f.DB.sqlite.exec(`UPDATE sessions SET expires_at=${NOW+123456}`);}finally {pause.release();}
  // Wait for the queued activity promise to settle through subsequent request work.
  await f.session(cookie);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.DB.one('SELECT expires_at FROM sessions').expires_at,NOW+123456);
});
test('M01: successful login rotates an existing cookie without retaining its previous server session',async t=>{
  const f=await setup(t),old=f.cookie(await f.login());const response=await f.login(oldHash,old),current=f.cookie(response);
  assert.equal(response.status,200);assert.notEqual(current,old);assert.equal(await f.active(current),true);assert.equal(await f.active(old),false);assert.equal(f.DB.count('sessions'),1);
});
test('M01: stale and unversioned direct session insertions are rejected',async t=>{
  const f=await setup(t),v=f.DB.one("SELECT auth_version FROM users WHERE id='test_player'").auth_version;
  assert.throws(()=>f.DB.sqlite.prepare("INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at) VALUES('unversioned','test_player',?,?,?)").run(NOW,NOW+1000,NOW),/SESSION_AUTH_VERSION_MISMATCH/);
  f.DB.sqlite.exec("UPDATE users SET status='disabled' WHERE id='test_player'; UPDATE users SET status='active' WHERE id='test_player';");
  assert.throws(()=>f.DB.sqlite.prepare("INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at,auth_version) VALUES('stale','test_player',?,?,?,?)").run(NOW,NOW+1000,NOW,v),/SESSION_AUTH_VERSION_MISMATCH/);
});
function resetSql(f,expected,changeId='controlled-reset') {
  return adminAccountSql({id:'new_admin',email:'test_player@example.invalid',name:'Synthetic administrator',hash:'reset-hash',salt:'reset-salt',
    iterations:app.PASSWORD_ITERATIONS,scheme:app.PASSWORD_SCHEME,role:'admin',now:NOW,changeId,expected});
}
test('M01: administrative reset rejects a stale snapshot and leaves the winner sessions intact',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login()),expected=f.DB.one("SELECT id,auth_version FROM users WHERE id='test_player'");
  assert.equal((await f.change(cookie)).status,200);f.DB.sqlite.exec(resetSql(f,expected));
  assert.equal(await f.active(cookie),true);assert.equal(f.DB.one("SELECT role FROM users WHERE id='test_player'").role,'player');
  assert.equal(f.DB.one("SELECT COUNT(*) AS applied FROM users WHERE auth_change_id='controlled-reset'").applied,0);
});
test('M01: administrative reset fences a delayed login and invalidates sessions even if delete fails',async t=>{
  const f=await setup(t),cookie=f.cookie(await f.login()),expected=f.DB.one("SELECT id,auth_version FROM users WHERE id='test_player'");
  const pause=pauseWrite(f,sessionInsert),login=f.login();await pause.arrived;
  try {f.DB.sqlite.exec(resetSql(f,expected).split('DELETE FROM sessions')[0]);}finally {pause.release();}
  assert.equal((await login).status,401);assert.equal(await f.active(cookie),false);
});
test('M01: competing administrative resets apply only one expected version',async t=>{
  const f=await setup(t),expected=f.DB.one("SELECT id,auth_version FROM users WHERE id='test_player'");
  f.DB.sqlite.exec(resetSql(f,expected,'first-reset'));f.DB.sqlite.exec(resetSql(f,expected,'second-reset'));
  assert.equal(f.DB.one("SELECT auth_change_id FROM users WHERE id='test_player'").auth_change_id,'first-reset');
});
test('M01: administrative create mode cannot overwrite a concurrently created account',async t=>{
  const f=await setup(t);f.DB.sqlite.exec(resetSql(f,null));
  assert.equal(f.DB.one("SELECT role FROM users WHERE id='test_player'").role,'player');
  const sql=adminAccountSql({id:'fresh_admin',email:'new-admin@example.invalid',name:"Synthetic O'Neil",hash:'fresh-hash',salt:'fresh-salt',
    iterations:app.PASSWORD_ITERATIONS,scheme:app.PASSWORD_SCHEME,role:'admin',now:NOW,changeId:'fresh-admin-change',expected:null});
  f.DB.sqlite.exec(sql);assert.equal(f.DB.one("SELECT auth_version FROM users WHERE id='fresh_admin'").auth_version,1);
});
test('M01: populated 0014 upgrade preserves credentials and sessions, then fences future changes',async t=>{
  const DB=new TestD1();t.after(()=>DB.sqlite.close());
  for(const name of readdirSync(path.join(root,'migrations')).filter(n=>n.endsWith('.sql')&&n<'0015').sort())DB.sqlite.exec(readFileSync(path.join(root,'migrations',name),'utf8'));
  DB.sqlite.prepare("INSERT INTO users(id,email,name,password_hash,password_salt,password_iterations,password_scheme,created_at,updated_at) VALUES('legacy','legacy@example.invalid','Synthetic','unchanged-hash','unchanged-salt',?,?,?,?)").run(app.PASSWORD_ITERATIONS,app.PASSWORD_SCHEME,NOW,NOW);
  DB.sqlite.prepare("INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at) VALUES('legacy-session','legacy',?,?,?)").run(NOW,NOW+1000,NOW);
  DB.sqlite.exec(readFileSync(path.join(root,'migrations/0015_auth_versions.sql'),'utf8'));
  assert.equal(DB.one("SELECT password_hash FROM users WHERE id='legacy'").password_hash,'unchanged-hash');
  assert.equal(DB.one("SELECT auth_version FROM sessions WHERE id='legacy-session'").auth_version,1);
  DB.sqlite.exec("UPDATE users SET password_salt='different' WHERE id='legacy';");assert.equal(DB.one("SELECT auth_version FROM users WHERE id='legacy'").auth_version,2);
  assert.equal(DB.one("SELECT auth_version FROM sessions WHERE id='legacy-session'").auth_version,1);
  assert.deepEqual(DB.rows('PRAGMA foreign_key_check'),[]);
});
