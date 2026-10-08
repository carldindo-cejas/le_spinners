// Diagnose the local dev transport using the installed Miniflare/workerd.
// Requires a pre-seeded, disposable concurrency-audit copy. Never uses .dev.vars.
// MUTATES that copy (sessions, holds, releases, maintenance). Use a fresh scratch
// dataset; do not point at a completed acceptance run whose evidence is retained.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../..',import.meta.url));
const scratch = path.resolve(process.env.CONCURRENCY_PROBE_ROOT || '');
assert.ok(scratch.startsWith(path.resolve(root,'.wrangler','concurrency-audit-')), 'Owned disposable concurrency copy required');
const port = Number(process.env.CONCURRENCY_PROBE_PORT || 8841);
assert.ok(Number.isInteger(port) && port>=1024 && port<=65535);
const base = `http://127.0.0.1:${port}`;
const config = JSON.parse(fs.readFileSync(path.join(scratch,'wrangler.jsonc'),'utf8'));
assert.equal(config.d1_databases[0].database_id,'00000000-0000-0000-0000-000000000000');
assert.ok(!config.vars?.RESEND_API_KEY, 'Provider credentials prohibited in local diagnostic bindings');
const bundle = path.join(scratch,'.wrangler','miniflare-probe-worker.mjs');
await build({entryPoints:[path.join(scratch,'src/worker/index.ts')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:bundle});
const logFile = path.join(scratch,'.wrangler','miniflare-probe.log');
const report = { environment:'direct Miniflare HTTP -> workerd -> local D1/R2; no Wrangler ProxyWorker',port,scenarios:[],failures:[] };
class ProbeLog extends Log {
  log(message) { fs.appendFileSync(logFile,message+'\n'); }
}
// Installed Miniflare 5 replaced d1Persist/r2Persist with one resource root.
const mf = new Miniflare(convertV4MiniflareOptions({
  name:'concurrency-direct-probe', rootPath:scratch, modules:true, scriptPath:bundle,
  compatibilityDate:config.compatibility_date, compatibilityFlags:config.compatibility_flags || [],
  host:'127.0.0.1',port,cf:false,unsafeTriggerHandlers:true,unsafeLocalExplorer:false,
  resourcePersistencePath:path.join(scratch,'.wrangler','state','v3'),
  d1Databases:{DB:config.d1_databases[0].database_id},r2Buckets:{PROOFS:config.r2_buckets[0].bucket_name},
  bindings:{...config.vars,APP_ORIGIN:base,FILE_SIGNING_SECRET:'synthetic-direct-probe-signing-secret',PASSWORD_PEPPER:'dev-only-PC7lWBGtJ1mbnsurMV_RX2-29gGyBiMn'},
  serviceBindings:{ASSETS:async () => new Response('Static assets excluded from this API probe',{status:404})},
  log:new ProbeLog(LogLevel.INFO),handleStructuredLogs:entry=>fs.appendFileSync(logFile,JSON.stringify(entry)+'\n'),
}));
const request = async (url,body,cookie='',headers={}) => {
  const response = await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const text = await response.text(); let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,data};
};
async function wave(name,jobs,expected) {
  const start=performance.now(),results=await Promise.all(jobs.map(fn=>fn()));
  const statuses={};for(const r of results)statuses[r.status]=(statuses[r.status]||0)+1;
  const summary={name,concurrency:jobs.length,elapsedMs:performance.now()-start,statuses};report.scenarios.push(summary);console.log(JSON.stringify(summary));
  for(const r of results)assert.ok(expected.includes(r.status),JSON.stringify(r));
  return results;
}
try {
  await mf.ready;
  const db = await mf.getD1Database('DB');
  report.seededUsers = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'concurrent-%'").first()).n;
  assert.equal(report.seededUsers,50,'The direct runtime must see the exact seeded Wrangler database');
  const cookies=[];
  for(let i=0;i<50;i++) {
    const token=randomBytes(32).toString('base64url'),id=createHash('sha256').update(token).digest('hex'),now=Date.now();
    await db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen_at,auth_version) SELECT ?,id,?,?,?,auth_version FROM users WHERE id=?')
      .bind(id,now,now+86400000,now,'concurrent-'+i).run();
    cookies.push('ls_session='+token);
  }
  await wave('50 direct authenticated reads',cookies.map(cookie=>()=>request('/api/me',null,cookie)),[200]);
  const date=new Date(Date.now()+480*60000+12*86400000).toISOString().slice(0,10);
  const responses=await wave('50 direct distinct holds',cookies.map((cookie,i)=>()=>request('/api/bookings',{resourceId:'court-'+(1+i%3),date,starts:[Math.floor(i/3)*60]},cookie,{'Idempotency-Key':'direct-probe-'+randomBytes(16).toString('hex')})),[201]);
  await wave('50 direct releases',responses.map((r,i)=>()=>request(`/api/bookings/${r.data.booking.id}/release`,{},cookies[i])),[200]);
  const worker=await mf.getWorker();
  report.scheduledResult=await worker.scheduled({cron:'* * * * *',scheduledTime:Date.now()});
  report.cronHttp=await request('/cdn-cgi/local/scheduled?cron=*+*+*+*+*');
  assert.equal(report.cronHttp.status,200);
  report.r2Objects=(await (await mf.getR2Bucket('PROOFS')).list()).objects.length;
  report.state='passed';
}catch(error) {
  report.state='failed';report.failures.push({name:error.name,message:error.message});throw error;
}finally {
  fs.writeFileSync(path.join(scratch,'.wrangler','miniflare-probe-results.json'),JSON.stringify(report,null,2)+'\n');
  await mf.dispose();console.log(JSON.stringify(report));
}
