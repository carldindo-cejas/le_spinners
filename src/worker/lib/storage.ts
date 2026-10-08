import type { Bindings, SessionUser } from '../types';
import { newId } from './crypto';
import { conflict } from './errors';
import { invalidateSettings } from './settings';

export const UPLOAD_LEASE_MS = 5 * 60_000;
export const STORAGE_BATCH_SIZE = 8;
export const STORAGE_RECHECK_MS = 24 * 3_600_000;
const DELETE_LEASE_MS = 60_000;
const QR_RETIRE_DELAY_MS = 60_000; // Longer than the per-isolate settings cache.
const KEY_SCOPE = `(kind='proof' AND substr(r2_key,1,7)='proofs/') OR (kind='qr' AND substr(r2_key,1,18)='settings/gcash-qr/')`;
const REFERENCES = `EXISTS (SELECT 1 FROM payment_proofs p WHERE p.r2_key = storage_uploads.r2_key)
  OR EXISTS (SELECT 1 FROM settings s WHERE s.key = 'gcash_qr_key' AND s.value = storage_uploads.r2_key)`;
export type UploadIntent = { id: string; key: string; token: string };
type CleanupClaim = { id: string; r2_key: string; claim_id: string; put_id: string | null; delete_attempts: number };

/** A lost insert response cannot create an orphan: no R2 operation has started yet. */
export async function beginUpload(env: Bindings, key: string, kind: 'proof' | 'qr', ownerId: string, bookingId: string | null, now = Date.now()): Promise<UploadIntent> {
  if (!key.startsWith(kind === 'proof' ? 'proofs/' : 'settings/gcash-qr/')) throw new Error('Invalid upload namespace');
  const intent = { id:newId('upload_'),key,token:newId('claim_') };
  await env.DB.batch([env.DB.prepare(`INSERT INTO storage_uploads(id,r2_key,kind,owner_id,booking_id,state,claim_id,upload_token,lease_until,created_at,updated_at)
    VALUES(?,?,?,?,?,'staged',?,?,?,?,?)`).bind(intent.id,key,kind,ownerId,bookingId,intent.token,intent.token,now + UPLOAD_LEASE_MS,now,now)]);
  return intent;
}
/** A late put invalidates an older deletion acknowledgement without taking its claim. */
export async function markUploadStored(env: Bindings, intent: UploadIntent, now = Date.now()) {
  await env.DB.batch([env.DB.prepare(`UPDATE storage_uploads SET put_id=?,updated_at=?,
    state=CASE WHEN state IN ('deleted','delete_pending') OR (state='staged' AND lease_until <= ?) THEN 'delete_pending' ELSE state END,
    next_attempt_at=CASE WHEN state IN ('deleted','delete_pending') OR (state='staged' AND lease_until <= ?) THEN ? ELSE next_attempt_at END
    WHERE id=? AND upload_token=?`).bind(newId('put_'),now,now,now,now,intent.id,intent.token)]);
}
export function uploadGuard(intent: UploadIntent, now: number) {
  return { sql:`EXISTS (SELECT 1 FROM storage_uploads WHERE id = ? AND state = 'staged' AND claim_id = ? AND lease_until > ?)`,
    params:[intent.id,intent.token,now] as (string | number)[] };
}
export function attachUploadStmt(env: Bindings, intent: UploadIntent, now: number) {
  return env.DB.prepare(`UPDATE storage_uploads SET state='attached', claim_id=NULL, lease_until=0, updated_at=?, next_attempt_at=?, last_error=NULL
    WHERE id=? AND state='staged' AND claim_id=? AND (${REFERENCES})`).bind(now,now + STORAGE_RECHECK_MS,intent.id,intent.token);
}

/** Atomically fence off a failed/uncertain attachment before any deletion. References always win. */
export async function abandonUpload(env: Bindings, intent: UploadIntent, now = Date.now()) {
  await env.DB.batch([env.DB.prepare(`UPDATE storage_uploads SET state='delete_pending', claim_id=NULL, lease_until=0,
    next_attempt_at=?, updated_at=?, last_error='UPLOAD_NOT_ATTACHED'
    WHERE id=? AND state IN ('staged','deleted','delete_pending') AND upload_token=? AND NOT (${REFERENCES})`).bind(now,now,intent.id,intent.token)]);
  if (env.STORAGE_CLEANUP_ENABLED !== 'false') await cleanupOne(env,now,intent.id);
}
/** Preserve the original request error; a durable checkpoint survives failed cleanup. */
export async function recoverUploadFailure(env: Bindings, intent: UploadIntent) {
  try { await abandonUpload(env,intent); }
  catch { console.error(JSON.stringify({msg:'upload recovery deferred',uploadId:intent.id})); }
}

async function cleanupOne(env: Bindings, now: number, id?: string): Promise<'deleted' | 'retry' | 'lost' | null> {
  const token = newId('delete_');
  const [result] = await env.DB.batch([env.DB.prepare(`UPDATE storage_uploads SET state='deleting', claim_id=?1, lease_until=?2,
    delete_attempts=delete_attempts+1, updated_at=?3
    WHERE id IN (SELECT id FROM storage_uploads WHERE ${id ? 'id=?4 AND' : ''} (${KEY_SCOPE}) AND NOT (${REFERENCES}) AND (
      (state IN ('delete_pending','deleted','attached') AND next_attempt_at <= ?3)
      OR (state IN ('staged','deleting') AND lease_until <= ?3))
      ORDER BY next_attempt_at,created_at,id LIMIT 1)
    RETURNING id,r2_key,claim_id,put_id,delete_attempts`)
    .bind(token,now + DELETE_LEASE_MS,now,...(id ? [id] : []))]);
  const row = result?.results[0] as CleanupClaim | undefined;
  if (!row) return null;
  const guard = `id=? AND state='deleting' AND claim_id=? AND put_id IS ?`;
  try {
    await env.PROOFS.delete(row.r2_key);
  } catch {
    const next = now + Math.min(60_000 * 2 ** Math.min(row.delete_attempts - 1,10),STORAGE_RECHECK_MS);
    const [retry] = await env.DB.batch([env.DB.prepare(`UPDATE storage_uploads SET state=?,claim_id=NULL,lease_until=0,
      next_attempt_at=?,updated_at=?,last_error=? WHERE ${guard}`)
      .bind(row.delete_attempts >= 8 ? 'needs_review' : 'delete_pending',next,Date.now(),row.delete_attempts >= 8 ? 'R2_DELETE_EXHAUSTED' : 'R2_DELETE_FAILED',row.id,row.claim_id,row.put_id)]);
    return retry?.meta.changes ? 'retry' : 'lost';
  }
  // Keep a tombstone and re-delete periodically: an ambiguous/late put can outlive the first cleanup.
  const [done] = await env.DB.batch([env.DB.prepare(`UPDATE storage_uploads SET state='deleted',claim_id=NULL,lease_until=0,delete_attempts=0,
    next_attempt_at=?,updated_at=?,last_error=NULL WHERE ${guard}`).bind(Date.now() + STORAGE_RECHECK_MS,Date.now(),row.id,row.claim_id,row.put_id)]);
  return done?.meta.changes ? 'deleted' : 'lost';
}

/** One leased page, eight objects, and two fixed prefixes. Legacy orphan discovery is opt-in. */
async function discoverOrphans(env: Bindings, now: number) {
  if (env.STORAGE_ORPHAN_SCAN_ENABLED !== 'true') return 0;
  const token = newId('scan_');
  const [claimed] = await env.DB.batch([env.DB.prepare(`UPDATE storage_scan_state SET claim_id=?1,lease_until=?2
    WHERE prefix=(SELECT prefix FROM storage_scan_state WHERE lease_until <= ?3 AND next_scan_at <= ?3
      ORDER BY next_scan_at,prefix LIMIT 1) RETURNING prefix,cursor`).bind(token,now + DELETE_LEASE_MS,now)]);
  const row = claimed?.results[0] as {prefix:string;cursor:string|null} | undefined;
  if (!row) return 0;
  const page = await env.PROOFS.list({prefix:row.prefix,limit:STORAGE_BATCH_SIZE,...(row.cursor ? {cursor:row.cursor} : {})});
  if (page.truncated && (!page.cursor || page.cursor === row.cursor)) throw new Error('Invalid R2 listing cursor');
  // Stage in the same transaction as the cursor checkpoint. Lost responses cannot skip a page.
  const statements: D1PreparedStatement[] = [];
  for (const object of page.objects.slice(0,STORAGE_BATCH_SIZE)) {
    if (!object.key.startsWith(row.prefix) || object.uploaded.getTime() > now - STORAGE_RECHECK_MS) continue;
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO storage_uploads(id,r2_key,kind,state,created_at,updated_at,next_attempt_at,last_error)
      SELECT ?,?,?,'delete_pending',?,?,?,'LEGACY_UNREFERENCED'
      WHERE EXISTS (SELECT 1 FROM storage_scan_state WHERE prefix=? AND claim_id=? AND lease_until > ?)
        AND NOT EXISTS (SELECT 1 FROM payment_proofs WHERE r2_key=?)
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key='gcash_qr_key' AND value=?)`)
      .bind(newId('orphan_'),object.key,row.prefix === 'proofs/' ? 'proof' : 'qr',object.uploaded.getTime(),now,now,row.prefix,token,Date.now(),object.key,object.key));
  }
  statements.push(env.DB.prepare(`UPDATE storage_scan_state SET cursor=?,claim_id=NULL,lease_until=0,next_scan_at=?
    WHERE prefix=? AND claim_id=? AND lease_until > ?`).bind(page.truncated ? page.cursor : null,now + 60_000,row.prefix,token,Date.now()));
  const results = await env.DB.batch(statements);
  return results.slice(0,-1).reduce((n,result) => n + result.meta.changes,0);
}

export async function reconcileUploads(env: Bindings, now = Date.now()) {
  const report = {deleted:0,retrying:0,lost:0,discovered:0,scanDeferred:false,disabled:env.STORAGE_CLEANUP_ENABLED==='false'};
  if (report.disabled) return report;
  await env.DB.batch([env.DB.prepare(`UPDATE storage_uploads SET state='needs_review',claim_id=NULL,lease_until=0,
    last_error='UNKNOWN_STORAGE_NAMESPACE',updated_at=? WHERE id IN (SELECT id FROM storage_uploads
      WHERE state != 'needs_review' AND NOT (${KEY_SCOPE}) AND NOT (${REFERENCES}) ORDER BY created_at,id LIMIT ?)`)
    .bind(now,STORAGE_BATCH_SIZE)]);
  // References found after an uncertain outcome restore retention, never deletion.
  await env.DB.batch([env.DB.prepare(`UPDATE storage_uploads SET state='attached',claim_id=NULL,lease_until=0,
    next_attempt_at=?,updated_at=?,last_error=NULL WHERE id IN (SELECT id FROM storage_uploads
      WHERE state != 'attached' AND (${REFERENCES}) ORDER BY created_at,id LIMIT ?)`)
    .bind(now + STORAGE_RECHECK_MS,now,STORAGE_BATCH_SIZE)]);
  try { report.discovered = await discoverOrphans(env,now); }
  catch { report.scanDeferred=true;console.error(JSON.stringify({msg:'storage scan deferred'})); }
  for (let n=0;n<STORAGE_BATCH_SIZE;n++) {
    const result = await cleanupOne(env,Date.now());
    if (!result) break;
    if (result === 'deleted') report.deleted++;
    else if (result === 'retry') report.retrying++;
    else report.lost++;
  }
  return report;
}

function qrAudit(env: Bindings, actor: SessionUser, intent: UploadIntent, action: string, ip: string, now: number) {
  const g = uploadGuard(intent,now);
  return env.DB.prepare(`INSERT INTO audit_log(actor_id,action,entity,entity_id,detail,ip,created_at)
    SELECT ?,?,'settings','gcash_qr_key',?,?,? WHERE ${g.sql}`).bind(actor.id,action,intent.id,ip,now,...g.params);
}
function retirePreviousQrStmt(env: Bindings, intent: UploadIntent, now: number) {
  return env.DB.prepare(`INSERT INTO storage_uploads(id,r2_key,kind,state,created_at,updated_at,next_attempt_at)
    SELECT ?,previous_key,'qr','delete_pending',?,?,? FROM storage_uploads
      WHERE id=? AND state='attached' AND previous_key IS NOT NULL AND previous_key != '' AND previous_key != r2_key
        AND NOT EXISTS (SELECT 1 FROM payment_proofs WHERE r2_key=previous_key)
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key='gcash_qr_key' AND value=previous_key)
    ON CONFLICT(r2_key) DO UPDATE SET state='delete_pending',claim_id=NULL,lease_until=0,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at
      WHERE storage_uploads.state='attached'`).bind(newId('retired_'),now,now,now + QR_RETIRE_DELAY_MS,intent.id);
}

/** Setting, audit and new-object ownership commit together; the old key is read inside the transaction. */
export async function commitQrUpload(env: Bindings, actor: SessionUser, intent: UploadIntent, ip: string, now = Date.now()) {
  const g = uploadGuard(intent,now);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE storage_uploads SET previous_key=(SELECT value FROM settings WHERE key='gcash_qr_key')
      WHERE id=? AND ${g.sql}`).bind(intent.id,...g.params),
    env.DB.prepare(`INSERT INTO settings(key,value,updated_at,updated_by)
      SELECT 'gcash_qr_key',?,?,? WHERE ${g.sql}
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(intent.key,now,actor.id,...g.params),
    qrAudit(env,actor,intent,'gcash_qr_updated',ip,now),
    attachUploadStmt(env,intent,now),
    retirePreviousQrStmt(env,intent,now),
  ]);
  if (!results[1]?.meta.changes) throw conflict('UPLOAD_EXPIRED','The upload could not be saved. Upload the QR image again.');
  invalidateSettings();
}

/** Removal has its own transaction checkpoint so concurrent replacements cannot leave untracked old keys. */
export async function removeQr(env: Bindings, actor: SessionUser, ip: string, now = Date.now()) {
  const id = newId('qr_remove_');
  try { await env.DB.batch([
    env.DB.prepare(`INSERT INTO storage_qr_operations(id,previous_key,owner_id,created_at)
      VALUES(?,(SELECT value FROM settings WHERE key='gcash_qr_key'),?,?)`).bind(id,actor.id,now),
    env.DB.prepare(`INSERT INTO settings(key,value,updated_at,updated_by) VALUES('gcash_qr_key','',?,?)
      ON CONFLICT(key) DO UPDATE SET value='',updated_at=excluded.updated_at,updated_by=excluded.updated_by`).bind(now,actor.id),
    env.DB.prepare(`INSERT INTO audit_log(actor_id,action,entity,entity_id,detail,ip,created_at)
      VALUES(?,'gcash_qr_removed','settings','gcash_qr_key',?,?,?)`).bind(actor.id,id,ip,now),
    env.DB.prepare(`INSERT INTO storage_uploads(id,r2_key,kind,state,created_at,updated_at,next_attempt_at)
      SELECT ?,previous_key,'qr','delete_pending',?,?,? FROM storage_qr_operations
      WHERE id=? AND previous_key IS NOT NULL AND previous_key != ''
        AND NOT EXISTS (SELECT 1 FROM payment_proofs WHERE r2_key=previous_key)
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key='gcash_qr_key' AND value=previous_key)
      ON CONFLICT(r2_key) DO UPDATE SET state='delete_pending',claim_id=NULL,lease_until=0,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at
        WHERE storage_uploads.state='attached'`).bind(newId('retired_'),now,now,now + QR_RETIRE_DELAY_MS,id),
  ]); } catch (error) {
    let saved = false;
    try { saved = Boolean(await env.DB.prepare('SELECT id FROM storage_qr_operations WHERE id=?').bind(id).first()); }
    catch { /* Its committed transaction, if any, retains the cleanup checkpoint. */ }
    if (!saved) throw error;
  }
  invalidateSettings();
}

/** Safe operator counts; no keys, filenames, owners or proof contents are exposed. */
export async function storageHealth(env: Bindings, now = Date.now()) {
  const row = await env.DB.prepare(`SELECT
    SUM(CASE WHEN state='staged' AND lease_until <= ? THEN 1 ELSE 0 END) AS expiredUploads,
    SUM(CASE WHEN state IN ('delete_pending','deleting') THEN 1 ELSE 0 END) AS cleanupPending,
    SUM(CASE WHEN state='needs_review' THEN 1 ELSE 0 END) AS needsReview,
    SUM(CASE WHEN state='delete_pending' AND last_error='R2_DELETE_FAILED' THEN 1 ELSE 0 END) AS deleteFailures,
    MIN(CASE WHEN state IN ('delete_pending','deleting','needs_review') THEN created_at ELSE NULL END) AS oldestPendingAt
    FROM storage_uploads`).bind(now).first<Record<string,number|null>>();
  return {expiredUploads:row?.expiredUploads??0,cleanupPending:row?.cleanupPending??0,needsReview:row?.needsReview??0,
    deleteFailures:row?.deleteFailures??0,oldestPendingAt:row?.oldestPendingAt??null,
    cleanupEnabled:env.STORAGE_CLEANUP_ENABLED!=='false',legacyScanEnabled:env.STORAGE_ORPHAN_SCAN_ENABLED==='true'};
}
