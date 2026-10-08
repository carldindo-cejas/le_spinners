// Read-only production inventory. Requests object listing metadata, never image bodies.
// Existing credentials and object keys stay in memory; stdout/files contain aggregates only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const config = ts.parseConfigFileTextToJson('wrangler.jsonc', fs.readFileSync('wrangler.jsonc', 'utf8')).config;
const bucket = config.r2_buckets?.find(binding => binding.binding === 'PROOFS')?.bucket_name;
const database = config.d1_databases?.find(binding => binding.binding === 'DB')?.database_id;
if (config.name !== 'le-spinners' || bucket !== 'le-spinners-proofs' || database !== '359085b7-5fbe-4d85-9db8-7ab2dc39ee57') {
  throw Error('Unexpected audit target');
}
const evidence = {
  timestamp: new Date().toISOString(), target: config.name, bucket,
  method: 'Cloudflare control API GET List Objects; metadata only',
  objectContentRequests: 0, objectMutations: 0, rowsWritten: 0,
  complete: false, errors: [],
};
const cli = path.resolve('node_modules/wrangler/bin/wrangler.js');
const cliEnv = { ...process.env, CI: 'true', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true' };
function command(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true, env: cliEnv, maxBuffer: 16 * 1024 * 1024,
  });
  // Never reproduce stdout/stderr, which may contain credentials, email or private keys.
  if (result.status !== 0) throw Error(`${args[0]} ${args[1] ?? ''} failed (exit ${result.status ?? 'unknown'})`);
  try { return JSON.parse(result.stdout); }
  catch { throw Error(`${args[0]} returned an unsupported JSON response`); }
}
const referenceQuery = `SELECT 'proof' AS kind,r2_key AS object_key,size AS expected_size,content_type AS expected_type,NULL AS state FROM payment_proofs
  UNION ALL SELECT 'qr',value,NULL,NULL,NULL FROM settings WHERE key='gcash_qr_key' AND value != ''
  UNION ALL SELECT 'tracked',r2_key,NULL,NULL,state FROM storage_uploads ORDER BY kind,object_key`;
function references() {
  const rows = command(['d1', 'execute', 'DB', '--remote', '--command', referenceQuery, '--json']);
  if (!Array.isArray(rows) || rows.some(row => row.success !== true || row.meta?.rows_written !== 0 || !Array.isArray(row.results))) {
    throw Error('Reference query did not confirm successful read-only execution');
  }
  evidence.rowsRead = (evidence.rowsRead ?? 0) + rows.reduce((total, row) => total + (row.meta?.rows_read ?? 0), 0);
  evidence.referenceQueries = (evidence.referenceQueries ?? 0) + 1;
  const result = rows.flatMap(row => row.results);
  if (result.some(row => typeof row.object_key !== 'string' || !['proof', 'qr', 'tracked'].includes(row.kind))) {
    throw Error('Unsupported reference data shape');
  }
  return result;
}

let stage = 'identity';
try {
  const identity = command(['whoami', '--json']);
  const accounts = identity.accounts;
  if (!identity.loggedIn || !Array.isArray(accounts)) throw Error('Authenticated account inventory unavailable');
  const configuredAccount = config.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
  const account = configuredAccount ? accounts.find(item => item.id === configuredAccount) : accounts.length === 1 ? accounts[0] : null;
  if (!account || !/^[a-f0-9]{32}$/.test(account.id)) throw Error('Audit target account is ambiguous');
  stage = 'credentials';
  // Wrangler logging is explicitly disabled: auth stdout is captured only in this process.
  const credentials = command(['auth', 'token', '--json']);
  if (!['oauth', 'api_token'].includes(credentials.type) || typeof credentials.token !== 'string' || !credentials.token) {
    throw Error('Existing bearer authentication unavailable');
  }
  evidence.authType = credentials.type;
  async function metadataGet(route, params = new URLSearchParams()) {
    // This allowlist cannot address an object body or a different account/resource.
    const allowed = [`/accounts/${account.id}/d1/database/${database}`, `/accounts/${account.id}/r2/buckets/${bucket}/objects`];
    if (!allowed.includes(route)) throw Error('Only target metadata endpoints are allowed');
    const url = new URL(`https://api.cloudflare.com/client/v4${route}`);
    url.search = params.toString();
    const response = await fetch(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${credentials.token}`, Accept: 'application/json', 'User-Agent': 'le-spinners-read-only-audit' },
    });
    evidence.metadataGetRequests = (evidence.metadataGetRequests ?? 0) + 1;
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      throw Error(`Metadata API returned an unsupported media type (HTTP ${response.status})`);
    }
    let body;
    try { body = await response.json(); }
    catch { throw Error('Metadata API returned an invalid JSON response'); }
    if (!response.ok || body.success !== true) {
      const codes = (body.errors ?? []).map(error => error.code).filter(code => Number.isInteger(code));
      throw Error(`Metadata API rejected the read (HTTP ${response.status}; codes ${codes.join(',') || 'none'})`);
    }
    return body;
  }
  stage = 'target verification';
  const databaseInfo = await metadataGet(`/accounts/${account.id}/d1/database/${database}`);
  if (databaseInfo.result?.uuid !== database) throw Error('Account does not own the configured target database');
  evidence.targetVerified = true;
  stage = 'reference snapshot before listing';
  const before = references();
  stage = 'object metadata listing';
  const objects = new Map(), seenCursors = new Set();
  let cursor, startAfter;
  for (let page = 1; page <= 100; page++) {
    const params = new URLSearchParams({ per_page: '1000' });
    if (cursor) params.set('cursor', cursor);
    if (startAfter) params.set('start_after', startAfter);
    const body = await metadataGet(`/accounts/${account.id}/r2/buckets/${bucket}/objects`, params);
    if (!Array.isArray(body.result)) {
      evidence.listingResponseShape = {
        resultIsArray: Array.isArray(body.result), resultObjectsIsArray: Array.isArray(body.result?.objects),
        resultTruncatedType: typeof body.result?.truncated, resultCursorType: typeof body.result?.cursor,
        resultInfoPresent: body.result_info != null, infoTruncatedType: typeof body.result_info?.truncated,
        infoIsTruncatedType: typeof body.result_info?.is_truncated, infoCursorType: typeof body.result_info?.cursor,
        topObjectsIsArray: Array.isArray(body.objects), topTruncatedType: typeof body.truncated,
      };
      throw Error('Listing returned an unsupported metadata result shape');
    }
    for (const object of body.result) {
      if (typeof object.key !== 'string' || objects.has(object.key)) throw Error('Invalid or duplicate listing metadata');
      objects.set(object.key, { size: object.size, contentType: (object.http_metadata ?? object.httpMetadata)?.contentType,
        uploaded: object.last_modified ?? object.uploaded });
    }
    evidence.listingPages = page;
    if (typeof body.result_info?.is_truncated === 'boolean') {
      evidence.paginationMode = 'result_info cursor';
      if (!body.result_info.is_truncated) { evidence.paginationComplete = true; break; }
      cursor = body.result_info.cursor;
      startAfter = undefined;
      if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) throw Error('Listing returned an invalid continuation cursor');
      seenCursors.add(cursor);
    } else {
      // The documented result_info is optional. Use documented keyset pagination
      // and require an explicit empty suffix page, rather than assume a short page ends the listing.
      evidence.paginationMode = 'start_after until empty';
      if (body.result.length === 0) { evidence.paginationComplete = true; break; }
      for (let index = 1; index < body.result.length; index++) {
        if (Buffer.compare(Buffer.from(body.result[index - 1].key), Buffer.from(body.result[index].key)) >= 0) {
          throw Error('Keyset listing is not in strict bytewise key order');
        }
      }
      const lastKey = body.result.at(-1).key;
      if (startAfter && Buffer.compare(Buffer.from(lastKey), Buffer.from(startAfter)) <= 0) {
        throw Error('Keyset listing did not advance');
      }
      startAfter = lastKey;
      cursor = undefined;
    }
  }
  if (!evidence.paginationComplete) throw Error('Listing exceeds the audit page cap');
  stage = 'reference snapshot after listing';
  const after = references();
  evidence.referencesStableDuringListing = JSON.stringify(before) === JSON.stringify(after);
  const proofs = after.filter(row => row.kind === 'proof'), qr = after.filter(row => row.kind === 'qr');
  const tracked = after.filter(row => row.kind === 'tracked'), referencesSet = new Set([...proofs, ...qr].map(row => row.object_key));
  const trackedSet = new Set(tracked.map(row => row.object_key));
  const scoped = key => key.startsWith('proofs/') || key.startsWith('settings/gcash-qr/');
  const missingProofs = proofs.filter(row => !objects.has(row.object_key)).length;
  const missingQr = qr.filter(row => !objects.has(row.object_key)).length;
  const sizeUnknown = proofs.filter(row => objects.has(row.object_key) && !Number.isSafeInteger(objects.get(row.object_key).size)).length;
  const typeUnknown = proofs.filter(row => objects.has(row.object_key) && typeof objects.get(row.object_key).contentType !== 'string').length;
  const sizeMismatches = proofs.filter(row => objects.has(row.object_key) && Number.isSafeInteger(objects.get(row.object_key).size)
    && objects.get(row.object_key).size !== row.expected_size).length;
  const typeMismatches = proofs.filter(row => objects.has(row.object_key) && typeof objects.get(row.object_key).contentType === 'string'
    && objects.get(row.object_key).contentType !== row.expected_type).length;
  const storedBytes = entries => {
    if (entries.some(([, object]) => !Number.isSafeInteger(object.size) || object.size < 0)) return null;
    const bytes = entries.reduce((total, [, object]) => total + object.size, 0);
    return Number.isSafeInteger(bytes) ? bytes : null;
  };
  const objectEntries = [...objects.entries()];
  evidence.counts = {
    proofReferences: proofs.length, currentQrReferences: qr.length, trackedUploads: tracked.length,
    bucketObjects: objects.size, proofObjects: [...objects.keys()].filter(key => key.startsWith('proofs/')).length,
    qrObjects: [...objects.keys()].filter(key => key.startsWith('settings/gcash-qr/')).length,
    otherNamespaceObjects: [...objects.keys()].filter(key => !scoped(key)).length,
    missingProofObjects: missingProofs, missingCurrentQrObjects: missingQr,
    unknownProofObjectSize: sizeUnknown, unknownProofObjectContentType: typeUnknown,
    proofSizeMismatches: sizeMismatches, proofContentTypeMismatches: typeMismatches,
    missingNonDeletedTrackedObjects: tracked.filter(row => row.state !== 'deleted' && !objects.has(row.object_key)).length,
    unreferencedScopedObjects: [...objects.keys()].filter(key => scoped(key) && !referencesSet.has(key)).length,
    untrackedScopedObjects: [...objects.keys()].filter(key => scoped(key) && !trackedSet.has(key)).length,
    invalidProofReferenceNamespace: proofs.filter(row => !row.object_key.startsWith('proofs/')).length,
    invalidCurrentQrReferenceNamespace: qr.filter(row => !row.object_key.startsWith('settings/gcash-qr/')).length,
    bucketStoredBytes: storedBytes(objectEntries),
    proofStoredBytes: storedBytes(objectEntries.filter(([key]) => key.startsWith('proofs/'))),
    qrStoredBytes: storedBytes(objectEntries.filter(([key]) => key.startsWith('settings/gcash-qr/'))),
    unknownObjectSizes: objectEntries.filter(([, object]) => !Number.isSafeInteger(object.size) || object.size < 0).length,
  };
  evidence.complete = evidence.referencesStableDuringListing;
  evidence.referenceMetadataPassed = evidence.complete && [missingProofs, missingQr, sizeUnknown, typeUnknown, sizeMismatches, typeMismatches].every(count => count === 0);
  evidence.reconciliationPassed = evidence.referenceMetadataPassed && ['missingNonDeletedTrackedObjects', 'unreferencedScopedObjects',
    'untrackedScopedObjects', 'invalidProofReferenceNamespace', 'invalidCurrentQrReferenceNamespace', 'otherNamespaceObjects']
    .every(name => evidence.counts[name] === 0);
  if (!evidence.referencesStableDuringListing) evidence.errors.push({ stage, error: 'Reference data changed during metadata listing; rerun the snapshot' });
  if (!evidence.referenceMetadataPassed) evidence.errors.push({ stage: 'reference metadata acceptance', error: 'Referenced object metadata failed acceptance; review aggregate missing/unknown/mismatch counts' });
  if (!evidence.reconciliationPassed) evidence.errors.push({ stage: 'object reconciliation', error: 'Object/reference reconciliation failed acceptance; review aggregate candidate counts before any repair' });
} catch (error) {
  // All thrown messages are explicitly constructed without tokens, keys or API response text.
  evidence.errors.push({ stage, error: error.message.startsWith('fetch failed') ? 'Metadata request transport failed' : error.message });
}
evidence.finishedAt = new Date().toISOString();
fs.writeFileSync('.wrangler/audit-r2-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = evidence.errors.length || !evidence.complete || !evidence.referenceMetadataPassed || !evidence.reconciliationPassed ? 1 : 0;
