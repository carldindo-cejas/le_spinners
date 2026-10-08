// Read-only invariant recheck for owned disposable local-capacity databases only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
export function capacityInvariantSql(){
  return ['readiness-inventory','storage-inventory','outbox-inventory'].map(name=>fs.readFileSync(path.join(root,'scripts',name+'.sql'),'utf8')).join('\n')+`
-- Terminal bookings retain historical slots. Check coordinates and LIVE overlap, not deletion.
SELECT 'slot_coordinate_mismatch' AS finding,COUNT(*) AS candidates FROM booking_slots s JOIN bookings b ON b.id=s.booking_id WHERE s.resource_id!=b.resource_id OR s.date!=b.date OR s.start_min<b.start_min OR s.end_min>b.end_min;
SELECT 'overlapping_live_bookings' AS finding,COUNT(*) AS candidates FROM booking_times a JOIN bookings ba ON ba.id=a.booking_id JOIN booking_times b ON a.booking_id<b.booking_id AND a.date=b.date AND a.resource_id=b.resource_id AND a.start_min<b.end_min AND a.end_min>b.start_min JOIN bookings bb ON bb.id=b.booking_id WHERE (ba.status IN ('CONFIRMED','PAYMENT_SUBMITTED') OR (ba.status IN ('TEMPORARY','REJECTED') AND ba.hold_expires_at>unixepoch('now')*1000)) AND (bb.status IN ('CONFIRMED','PAYMENT_SUBMITTED') OR (bb.status IN ('TEMPORARY','REJECTED') AND bb.hold_expires_at>unixepoch('now')*1000));
SELECT 'refund_without_replay_identity' AS finding,COUNT(*) AS candidates FROM credit_transactions t WHERE t.kind='refund' AND NOT EXISTS(SELECT 1 FROM refund_operations o WHERE o.transaction_id=t.id);
SELECT 'expiry_burst_not_closed' AS finding,COUNT(*) AS candidates FROM bookings WHERE id LIKE 'capacity-expiry-%' AND status!='EXPIRED';
SELECT 'expiry_burst_effect_count' AS finding,COUNT(*) AS candidates FROM bookings b WHERE b.id LIKE 'capacity-expiry-%' AND (SELECT COUNT(*) FROM booking_events e WHERE e.booking_id=b.id AND e.type='expired')!=1;
SELECT 'expiry_burst_closed_count' AS measurement,COUNT(*) AS count FROM bookings WHERE id LIKE 'capacity-expiry-%' AND status='EXPIRED';
PRAGMA quick_check;
PRAGMA foreign_key_check;`;
}
export function assertCapacityInvariants(results){
  for(const row of results){
    if('candidates' in row)assert.equal(row.candidates,0,row.finding||row.check_name);
    else if('quick_check' in row)assert.equal(row.quick_check,'ok');
    else if('fkid' in row)assert.fail('Foreign-key violation in local capacity fixture');
    else if(row.measurement==='expiry_burst_closed_count')assert.equal(row.count,73,'All delayed expiry groups drained');
  }
  assert.ok(results.some(row=>row.quick_check==='ok'),'D1 quick_check result must be present');
}
if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
  const scratch=path.resolve(process.env.CAPACITY_RUNTIME_ROOT||'');
  assert.ok(scratch.startsWith(path.resolve(root,'.wrangler','capacity-mixed-'))&&fs.existsSync(path.join(scratch,'wrangler.jsonc')),'Owned disposable capacity copy required');
  const config=JSON.parse(fs.readFileSync(path.join(scratch,'wrangler.jsonc'),'utf8'));
  assert.equal(config.d1_databases[0].database_id,'00000000-0000-0000-0000-000000000000');
  assert.ok(!config.d1_databases.some(v=>v.remote),'Remote bindings prohibited');
  fs.writeFileSync(path.join(scratch,'.wrangler','invariants-recheck.sql'),capacityInvariantSql());
  const run=spawnSync(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local','--file','.wrangler/invariants-recheck.sql','--json'],{cwd:scratch,encoding:'utf8',windowsHide:true,env:{...process.env,CI:'true'}});
  assert.equal(run.status,0,'Local invariant query failed: '+run.stderr);
  const results=JSON.parse(run.stdout).flatMap(r=>r.results||[]);assertCapacityInvariants(results);
  fs.writeFileSync(path.join(scratch,'.wrangler','capacity-invariants-recheck.json'),JSON.stringify({state:'passed',localOnly:true,date:new Date().toISOString(),checks:results.filter(r=>'candidates' in r).length,results},null,2)+'\n');
  console.log(JSON.stringify({state:'passed',localOnly:true,scratch,checks:results.filter(r=>'candidates' in r).length,expiryFixtures:73,quickCheck:'ok',foreignKeys:'clear'}));
}
