// Local workerd ramp/soak. Cloudflare plan CPU/row billing remains a separate staging gate.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { deriveClientHash } from '../public/js/core/password.js';
const base=process.env.BASE_URL||'http://127.0.0.1:8810';
assert.match(base,/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
const seconds=Number(process.env.CAPACITY_SECONDS||1800);assert.ok(Number.isFinite(seconds)&&seconds>=1&&seconds<=3600);
const samples={},errors=[];
async function request(path,body,cookie='') {const start=performance.now(),r=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});(samples[path.split('?')[0]]??=[]).push(performance.now()-start);if(!r.ok)errors.push({path,status:r.status});return r;}
// Demo credentials are synthetic and exist only after disposable local seeding.
const salt=await(await request('/api/auth/salt',{email:'juan.delacruz@example.com'})).json();
const clientHash=await deriveClientHash('demo-pass-2026',salt.salt,salt.iterations);
const login=await request('/api/auth/user/login',{email:'juan.delacruz@example.com',clientHash});assert.equal(login.status,200);
// The M13 regression signs in 50 distinct accounts; this read-only ramp reuses one real cookie.
const sessions=[login.headers.getSetCookie().find(c=>c.startsWith('ls_session=')).split(';')[0]];
for(const users of [20,35,50])await Promise.all(Array.from({length:users},async()=>{for(const path of ['/api/facility','/api/bookings?group=upcoming','/api/notifications/badges','/api/credits'])assert.equal((await request(path,null,sessions[0])).status,200);}));
const end=performance.now()+seconds*1000;while(performance.now()<end){await Promise.all(Array.from({length:50},()=>request('/api/bookings?group=upcoming',null,sessions[0])));await new Promise(r=>setTimeout(r,500));}
const metrics=Object.fromEntries(Object.entries(samples).map(([path,values])=>{values.sort((a,b)=>a-b);const percentile=p=>values[Math.min(values.length-1,Math.floor(values.length*p))];return [path,{requests:values.length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)}];}));
fs.mkdirSync('.wrangler',{recursive:true});fs.writeFileSync('.wrangler/capacity-results.json',JSON.stringify({environment:'localhost workerd',seconds,ramps:[20,35,50],scope:'Read ramp/soak; write/failure invariants and 50-account login are in maintained regressions. Not G07 mixed staging capacity evidence.',metrics,errors},null,2)+'\n');
assert.deepEqual(errors,[]);console.log('Local read capacity passed: '+seconds+' second soak; '+JSON.stringify(metrics));
