import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import ts from 'typescript';
const root=fileURLToPath(new URL('..',import.meta.url)),mode=process.argv[2]||'static';
const cli=path.join(root,'node_modules/wrangler/bin/wrangler.js');
fs.mkdirSync(path.join(root,'.wrangler'),{recursive:true});
function run(args,cwd=root,env={}){const r=spawnSync(process.execPath,args,{cwd,stdio:'inherit',env:{...process.env,CI:'true',...env},windowsHide:true});if(r.status!==0)throw Error('Verification failed: '+args[0]+' (exit '+r.status+')');}
function stop(child){if(!child||child.exitCode!==null)return;if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore',windowsHide:true});else {try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}}}
async function serve(args,cwd,port,env={}){await new Promise((resolve,reject)=>{const check=net.createServer();check.once('error',()=>reject(Error(`Verification port ${port} is already in use. Stop that fixture before retrying.`)));check.listen(port,'127.0.0.1',()=>check.close(resolve));});const child=spawn(process.execPath,args,{cwd,stdio:['ignore','pipe','pipe'],env:{...process.env,CI:'true',...env},windowsHide:true,detached:process.platform!=='win32'});const log=fs.createWriteStream(path.join(root,'.wrangler',`verify-server-${port}.log`));child.stdout.pipe(log);child.stderr.pipe(log);try{for(let i=0;i<180;i++){if(child.exitCode!==null)throw Error('Fixture server exited; inspect its local log.');try{const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1000)});if(r.status<500)return child;}catch{}await new Promise(r=>setTimeout(r,250));}throw Error('Fixture server timeout');}catch(e){stop(child);throw e;}}
if(mode==='static'){
  const files=[];function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,entry.name);if(entry.isDirectory())walk(f);else if(/\.(js|mjs)$/.test(f))files.push(f);}}
  for(const dir of ['public/js','scripts','tests'])walk(path.join(root,dir));files.push(path.join(root,'public/sw.js'));
  for(const file of files)run(['--check',file]);console.log(files.length+' syntax checks passed');
  run([cli,'types','--check']);run([path.join(root,'node_modules/typescript/bin/tsc'),'--noEmit']);
  const tests=fs.readdirSync(path.join(root,'tests')).filter(f=>/^readiness-.*\.mjs$/.test(f)).map(f=>'tests/'+f);
  run(['--test',...tests,'tests/payment-methods.mjs','tests/calendar-maps.mjs','tests/polling.mjs','tests/booking-request.mjs','tests/concurrency-booking-regression.mjs','tests/concurrency-payments-regression.mjs','tests/concurrency-export-regression.mjs','tests/concurrency-resource-regression.mjs']);
  run([cli,'deploy','--dry-run','--outdir','.wrangler/verify-build']);
} else if(mode==='browser'){
  const server=await serve(['tests/helpers/browser-server.mjs'],root,8805,{PORT:'8805'});
  try{for(const test of ['public-pages','refund-retry','outbox-ui','images-browser','lifecycle-browser','logout-browser','redirect-browser','remaining-browser','facility-browser','pwa-browser','accessibility-browser','mobile-payments-browser','calendar-maps-browser','player-availability-browser','staff-management-browser'])run(['tests/'+test+'.mjs'],root,{BASE_URL:'http://127.0.0.1:8805'});run(['--test','tests/concurrency-frontend-regression.mjs']);}finally{stop(server);}
} else if(mode==='runtime'){
  // Only the disposable copy is ever seeded/reset; no remote binding flags are used.
  const scratch=fs.mkdtempSync(path.join(root,'.wrangler','verify-runtime-'));
  for(const dir of ['src','public','migrations','scripts','tests','db'])fs.cpSync(path.join(root,dir),path.join(scratch,dir),{recursive:true});
  for(const file of ['package.json','package-lock.json','tsconfig.json','worker-configuration.d.ts','wrangler.jsonc','.dev.vars.example'])fs.copyFileSync(path.join(root,file),path.join(scratch,file));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(scratch,'node_modules'),process.platform==='win32'?'junction':'dir');
  fs.copyFileSync(path.join(root,'.dev.vars.example'),path.join(scratch,'.dev.vars'));
  const config=ts.parseConfigFileTextToJson('wrangler.jsonc',fs.readFileSync(path.join(scratch,'wrangler.jsonc'),'utf8')).config;
  config.assets.run_worker_first.push('/__scheduled'); // Local test-only scheduled endpoint before assets.
  fs.writeFileSync(path.join(scratch,'wrangler.jsonc'),JSON.stringify(config,null,2)+'\n');
  fs.writeFileSync(path.join(scratch,'wrangler-probe.jsonc'),JSON.stringify({...config,main:'tests/helpers/auth-race-worker.ts'},null,2)+'\n');
  run(['scripts/reset-local-db.mjs'],scratch);
  const server=await serve([cli,'dev','--local','--test-scheduled','--port','8810','--inspector-port','0'],scratch,8810);
  let probe,calendar;
  try{
    run(['tests/smoke.mjs'],scratch,{BASE_URL:'http://127.0.0.1:8810'});
    run(['tests/staff-runtime.mjs'],scratch,{BASE_URL:'http://127.0.0.1:8810'});
    run([path.join(root,'tests/storage-runtime.mjs')],root,{BASE_URL:'http://127.0.0.1:8810',STORAGE_RUNTIME_ROOT:scratch});
    probe=await serve([cli,'dev','--local','--config','wrangler-probe.jsonc','--port','8811','--inspector-port','0'],scratch,8811);
    run([path.join(root,'tests/auth-runtime.mjs')],root,{AUTH_RUNTIME_ROOT:scratch+path.sep,AUTH_BASE_URL:'http://127.0.0.1:8810',AUTH_PROBE_URL:'http://127.0.0.1:8811'});
    run(['tests/capacity.mjs'],scratch,{BASE_URL:'http://127.0.0.1:8810',CAPACITY_SECONDS:process.env.CAPACITY_SECONDS||'15'});
    run([cli,'d1','migrations','apply','DB','--local','--persist-to','.wrangler/calendar-state'],scratch);
    run([cli,'d1','execute','DB','--local','--persist-to','.wrangler/calendar-state','--file=db/facility.sql'],scratch);
    calendar=await serve([cli,'dev','--local','--persist-to','.wrangler/calendar-state','--port','8812','--inspector-port','0'],scratch,8812);
    run(['tests/public-calendar.mjs'],scratch,{CALENDAR_BASE_URL:'http://127.0.0.1:8812',CALENDAR_STORE:'.wrangler/calendar-state'});
  }finally{stop(calendar);stop(probe);stop(server);}
  console.log('Disposable runtime retained at '+scratch);
} else throw Error('Use static, browser or runtime.');
