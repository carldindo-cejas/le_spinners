// Actual local D1/workerd interleaving. Requires the documented disposable runtime/probe.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app } from './helpers/readiness.mjs';
const scratch=process.env.AUTH_RUNTIME_ROOT||fileURLToPath(new URL('../.wrangler/readiness-auth-runtime-20261007/',import.meta.url));
assert.ok(existsSync(scratch+'tests/helpers/auth-race-worker.ts'),'Prepare the isolated auth runtime/probe');
const base=process.env.AUTH_BASE_URL||'http://127.0.0.1:8797',probe=process.env.AUTH_PROBE_URL||'http://127.0.0.1:8798';
for(const host of [base,probe])assert.match(host,/^http:\/\/127\.0\.0\.1:\d+$/);
const oldHash='A'.repeat(43),newHash='B'.repeat(43),email=`auth-race-${Date.now()}@example.invalid`;
const password=(clientHash,salt)=>({scheme:app.PASSWORD_SCHEME,iterations:app.PASSWORD_ITERATIONS,clientHash,salt});
async function request(host,url,body,cookie='',headers={}) {
  return fetch(host+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.123',Origin:host,...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});
}
const registered=await request(base,'/api/auth/register',{email,name:'Synthetic auth race',password:password(oldHash,'Q'.repeat(22))});
assert.equal(registered.status,201);const cookie=registered.headers.getSetCookie().find(x=>x.startsWith('ls_session=')).split(';')[0];
const login=()=>request(base,'/api/auth/user/login',{email,clientHash:oldHash});
const other=await login();assert.equal(other.status,200);const otherCookie=other.headers.getSetCookie().find(x=>x.startsWith('ls_session=')).split(';')[0];
const delayed=request(probe,'/api/auth/user/login',{email,clientHash:oldHash},'',{'X-Auth-Race':'pause-login'});
try {
  let paused=false;
  for(let attempt=0;attempt<100;attempt++) {if((await (await request(probe,'/api/probe/pause')).json()).paused){paused=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(paused,true,'Pause the verified login immediately before its real D1 session batch');
  assert.equal((await request(base,'/api/me/password',{currentClientHash:oldHash,newPassword:password(newHash,'R'.repeat(22))},cookie)).status,200);
} finally {assert.equal((await request(probe,'/api/probe/release',{})).status,200);}
const stale=await delayed;assert.equal(stale.status,401);assert.equal(stale.headers.get('Set-Cookie'),null);
assert.ok((await (await request(base,'/api/auth/session',null,cookie)).json()).user);
assert.equal((await (await request(base,'/api/auth/session',null,otherCookie)).json()).user,null);
assert.equal((await login()).status,401);
const fresh=await request(base,'/api/auth/user/login',{email,clientHash:newHash});assert.equal(fresh.status,200);
const freshCookie=fresh.headers.getSetCookie().find(x=>x.startsWith('ls_session=')).split(';')[0];
assert.equal((await request(base,'/api/auth/logout',{},cookie)).status,200);assert.equal((await request(base,'/api/auth/logout',{},freshCookie)).status,200);
const evidence={runtime:'two local workerd isolates sharing D1',staleLoginStatus:stale.status,staleCookieIssued:false,
  initiatingSessionRetained:true,otherSessionRevoked:true,oldCredentialsRejected:true,newCredentialsAccepted:true};
writeFileSync(new URL('../.wrangler/readiness-auth-runtime-proof.json',import.meta.url),JSON.stringify(evidence,null,2));
console.log('Actual local cross-isolate auth race passed; only the initiating session survived and stale credentials issued no cookie.');
