// Summarize actual completed local capacity artifacts; retain the original result unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
const scratch=path.resolve(process.env.CAPACITY_RUNTIME_ROOT||'');
assert.ok(scratch.startsWith(path.resolve(root,'.wrangler','capacity-mixed-')),'Owned local capacity copy required');
const result=JSON.parse(fs.readFileSync(path.join(scratch,'.wrangler','capacity-mixed-results.json'),'utf8'));
assert.equal(result.state,'passed','Only completed, invariant-passing runs can be summarized as passed');
const log=fs.readFileSync(path.join(scratch,'.wrangler','server.log'),'utf8').replace(/\x1b\[[0-9;]*m/g,'');
const count=pattern=>(log.match(pattern)||[]).length;
const drift={worker:[],migrations:[],public:[]};
for(const [relative,expected] of Object.entries(result.sourceHashes)){
  assert.match(relative,/^(src|public|migrations)\//);const file=path.resolve(root,relative);
  assert.ok(file.startsWith(path.resolve(root)+path.sep));
  const actual=fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
  if(actual!==expected)drift[relative.startsWith('src/')?'worker':relative.startsWith('migrations/')?'migrations':'public'].push(relative);
}
for(const directory of ['src','public','migrations']){const walk=d=>{for(const entry of fs.readdirSync(d,{withFileTypes:true})){const file=path.join(d,entry.name);if(entry.isDirectory())walk(file);else{const relative=path.relative(root,file).replaceAll('\\','/');if(!(relative in result.sourceHashes))drift[directory==='src'?'worker':directory==='migrations'?'migrations':'public'].push(relative+' (new since tested snapshot)');}}};walk(path.join(root,directory));}
const summary={reviewedAt:new Date().toISOString(),scope:'Completed disposable localhost HTTP/invariant soak; no intended-plan capacity acceptance',scratch,
  elapsedSeconds:result.elapsedSeconds,requests:result.usage.requests,completedWriteCycles:result.cycles,cronInvocations:result.cronRuns,
  httpErrors:result.errors.length,unexpectedExceptions:result.unexpected.length,invariantCounters:result.invariants.filter(r=>'candidates' in r).length,
  transport:{recoveredGetWarnings:count(/ProxyWorker: GET[^\r\n]*recovered on attempt/g),networkConnectionLostEntries:count(/Network connection lost/g),note:'Local Wrangler proxy diagnostics, distinct from logical HTTP outcomes; not deployed-platform telemetry'},
  maintenanceTaskFailures:count(/maintenance task failed/g),sourceFiles:Object.keys(result.sourceHashes).length,drift,
  fixtureLimitations:{historyRows:36000,modeledVolumeMonths:12,timestampSpanDays:36000/1440,oldestAgeDays:365,proofBytes:fs.statSync(path.join(root,'db','seed-proofs','juan.png')).size,disruptionBatchSize:1,expiryBurstSizes:[1,10,12,50],sharedIp:'localhost/synthetic header boundary',annualDistribution:false,nearLimitUploads:false,bulkDisruptionBursts:false,controlledProviderAcceptance:false,realDevicePwa:false},
  platformMetrics:result.usage,metrics:result.metrics};
fs.writeFileSync(path.join(scratch,'.wrangler','capacity-reviewed-summary.json'),JSON.stringify(summary,null,2)+'\n');
fs.writeFileSync(path.join(root,'.wrangler','audit-capacity-reviewed-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({...summary,metrics:undefined,platformMetrics:undefined}));
