// Read-only account resource/configuration discovery. No object bodies, customer rows,
// secret values, email addresses or bearer tokens are printed or retained.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const config = ts.parseConfigFileTextToJson('wrangler.jsonc', fs.readFileSync('wrangler.jsonc', 'utf8')).config;
const databaseId = config.d1_databases?.find(binding => binding.binding === 'DB')?.database_id;
if (config.name !== 'le-spinners' || databaseId !== '359085b7-5fbe-4d85-9db8-7ab2dc39ee57' ||
  config.r2_buckets?.find(binding => binding.binding === 'PROOFS')?.bucket_name !== 'le-spinners-proofs') throw Error('Unexpected audit target');
const evidence = { timestamp: new Date().toISOString(), target: config.name, resourceMutations: 0,
  objectContentRequests: 0, customerDataQueries: 0, checks: [], errors: [], optionalMetadataGaps: [] };
const cli = path.resolve('node_modules/wrangler/bin/wrangler.js');
function command(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true,
    maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: 'true', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' } });
  if (result.status !== 0) throw Error(`${args[0]} metadata command failed (exit ${result.status ?? 'unknown'})`);
  try { return JSON.parse(result.stdout); } catch { throw Error('Unsupported CLI metadata response'); }
}
const relatedName = name => typeof name === 'string' && /(^|[-_])(?:le[-_])?spinners?(?:[-_]|$)/i.test(name);
let stage = 'identity';
try {
  const identity = command(['whoami', '--json']);
  const configuredAccount = config.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = identity.accounts;
  const account = Array.isArray(accounts) && (configuredAccount ? accounts.find(item => item.id === configuredAccount) : accounts.length === 1 ? accounts[0] : null);
  if (!identity.loggedIn || !account || !/^[a-f0-9]{32}$/.test(account.id)) throw Error('Authenticated audit account is ambiguous');
  const credentials = command(['auth', 'token', '--json']);
  if (!['oauth', 'api_token'].includes(credentials.type) || typeof credentials.token !== 'string' || !credentials.token) throw Error('Existing bearer authentication unavailable');
  evidence.authType = credentials.type;
  async function get(suffix, params = new URLSearchParams(), jurisdiction) {
    // Only account metadata collections and associated Worker metadata can be addressed.
    const allowed = /^\/(?:workers\/(?:scripts(?:\/[a-zA-Z0-9_-]+\/(?:deployments|versions\/[a-f0-9-]+))?|services\/[a-zA-Z0-9_-]+|account-settings)|d1\/database(?:\/[a-f0-9-]+)?|r2\/buckets|subscriptions|entitlements)$/;
    if (!allowed.test(suffix)) throw Error('Only metadata GET endpoints are allowed');
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${account.id}${suffix}`);
    url.search = params.toString();
    let response;
    try { response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${credentials.token}`, Accept: 'application/json',
        ...(jurisdiction ? { 'cf-r2-jurisdiction': jurisdiction } : {}) } }); }
    catch { throw Error('Metadata GET transport failed'); }
    evidence.metadataGetRequests = (evidence.metadataGetRequests ?? 0) + 1;
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel(); throw Error(`Unsupported metadata media type (HTTP ${response.status})`);
    }
    let body;
    try { body = await response.json(); } catch { throw Error('Invalid metadata JSON'); }
    if (!response.ok || body.success !== true) {
      const codes = (body.errors ?? []).map(item => item.code).filter(Number.isInteger);
      throw Error(`Metadata GET rejected (HTTP ${response.status}; codes ${codes.join(',') || 'none'})`);
    }
    return body;
  }
  async function collect(name, action, optional = false) {
    try { const result = await action(); evidence.checks.push({ name, passed: true }); return result; }
    catch (error) { (optional ? evidence.optionalMetadataGaps : evidence.errors).push({ check: name, error: error.message }); evidence.checks.push({ name, passed: false }); return null; }
  }
  const [databaseInfo, workerList, d1List, bucketsByJurisdiction, accountSettings, subscriptions, entitlements, deployments] = await Promise.all([
    collect('production D1 metadata', async () => (await get(`/d1/database/${databaseId}`)).result),
    collect('Worker script inventory', async () => {
      const body = await get('/workers/scripts');
      if (!Array.isArray(body.result)) throw Error('Unsupported Worker inventory shape');
      // The documented Worker script endpoint is unpaginated.
      return body.result;
    }),
    collect('D1 database inventory', async () => {
      const rows = [], seen = new Set();
      for (let page = 1; page <= 100; page++) {
        const body = await get('/d1/database', new URLSearchParams({ page: String(page), per_page: '1000' }));
        if (!Array.isArray(body.result)) throw Error('Unsupported D1 inventory shape');
        if (!body.result.length) return { rows, complete: true, pages: page };
        for (const row of body.result) {
          if (typeof row.uuid !== 'string' || seen.has(row.uuid)) throw Error('Invalid or non-advancing D1 inventory');
          seen.add(row.uuid); rows.push(row);
        }
        if (Number.isSafeInteger(body.result_info?.total_count) && rows.length === body.result_info.total_count) return { rows, complete: true, pages: page };
      }
      throw Error('D1 inventory exceeds page cap');
    }),
    Promise.all(['default', 'eu', 'us'].map(jurisdiction => collect(`R2 bucket inventory (${jurisdiction})`, async () => {
      const rows = [], seen = new Set(); let startAfter;
      for (let page = 1; page <= 100; page++) {
        const params = new URLSearchParams({ per_page: '1000', order: 'name', direction: 'asc' });
        if (startAfter) params.set('start_after', startAfter);
        const body = await get('/r2/buckets', params, jurisdiction);
        if (!Array.isArray(body.result?.buckets)) throw Error('Unsupported bucket inventory shape');
        if (!body.result.buckets.length) return { jurisdiction, rows, complete: true, pages: page };
        for (const row of body.result.buckets) {
          if (typeof row.name !== 'string' || seen.has(row.name)) throw Error('Invalid or non-advancing bucket inventory');
          seen.add(row.name); rows.push(row);
        }
        const next = body.result.buckets.at(-1).name;
        if (startAfter && Buffer.compare(Buffer.from(next), Buffer.from(startAfter)) <= 0) throw Error('Bucket keyset did not advance');
        startAfter = next;
      }
      throw Error('Bucket inventory exceeds page cap');
    }, jurisdiction !== 'default'))),
    collect('Workers account settings', async () => (await get('/workers/account-settings')).result, true),
    collect('account subscription plan evidence', async () => (await get('/subscriptions')).result, true),
    collect('account entitlement evidence', async () => (await get('/entitlements')).result, true),
    collect('production deployments', async () => (await get(`/workers/scripts/${config.name}/deployments`)).result),
  ]);
  if (databaseInfo) {
    if (databaseInfo.uuid !== databaseId) throw Error('Production database identity mismatch');
    evidence.productionDatabase = { uuid: databaseInfo.uuid, name: databaseInfo.name, fileSizeBytes: databaseInfo.file_size,
      version: databaseInfo.version, numTables: databaseInfo.num_tables, readReplication: databaseInfo.read_replication,
      directlyReportedMaxSizeBytes: databaseInfo.max_size ?? null };
  }
  if (workerList) evidence.workerInventory = { complete: true, totalScripts: workerList.length,
    appNamedScripts: workerList.filter(item => relatedName(item.id)).map(item => ({ name: item.id, modifiedOn: item.modified_on, compatibilityDate: item.compatibility_date })) };
  if (d1List) evidence.databaseInventory = { complete: d1List.complete, pages: d1List.pages, totalDatabases: d1List.rows.length,
    appNamedDatabases: d1List.rows.filter(item => relatedName(item.name)).map(item => ({ name: item.name, uuid: item.uuid, version: item.version })) };
  evidence.bucketInventories = bucketsByJurisdiction.filter(Boolean).map(group => ({ jurisdiction: group.jurisdiction,
    complete: group.complete, pages: group.pages, totalBuckets: group.rows.length,
    appNamedBuckets: group.rows.filter(item => relatedName(item.name)).map(item => ({ name: item.name, jurisdiction: item.jurisdiction, location: item.location, storageClass: item.storage_class })) }));
  if (accountSettings) evidence.accountSettings = { defaultUsageModel: accountSettings.default_usage_model ?? null, greenCompute: accountSettings.green_compute ?? null };
  if (subscriptions) {
    if (!Array.isArray(subscriptions)) throw Error('Unsupported subscription metadata shape');
    evidence.subscriptionEvidence = { totalSubscriptions: subscriptions.length,
      relatedServicePlans: subscriptions.filter(item => /workers|\bd1\b|\br2\b/i.test(JSON.stringify(item.rate_plan ?? {})))
        .map(item => ({ planId: item.rate_plan?.id, publicName: item.rate_plan?.public_name, scope: item.rate_plan?.scope, state: item.state })) };
  }
  if (entitlements) {
    if (!Array.isArray(entitlements)) throw Error('Unsupported entitlement metadata shape');
    evidence.entitlementEvidence = { totalFeatures: entitlements.length,
      relatedFeatures: entitlements.filter(item => /(^|[._])(?:workers?|d1|r2)(?:[._]|$)/i.test(item.feature?.key ?? ''))
        .map(item => {
          const value = item.allocation?.value;
          const safeValue = typeof value === 'boolean' || typeof value === 'number' ? value :
            typeof value === 'string' && /^(free|paid|standard|bundled|unbound|enterprise|premium|on|off|enabled|disabled)$/i.test(value) ? value :
              value && typeof value === 'object' && ['min', 'max'].every(key => value[key] == null || typeof value[key] === 'number') ? { min: value.min, max: value.max } : null;
          return { feature: item.feature.key, allocationType: item.allocation?.type, value: safeValue, valueRedacted: safeValue === null, active: !item.deleted_date };
        }) };
  }
  stage = 'associated Worker environment/version metadata';
  const appNames = workerList?.filter(item => relatedName(item.id)).map(item => item.id) ?? [];
  evidence.serviceEnvironments = (await Promise.all(appNames.map(name => collect(`Worker service environments (${name})`, async () => {
    const service = (await get(`/workers/services/${name}`)).result;
    return { name, defaultEnvironment: service.default_environment?.environment ?? null,
      environmentInventoryReported: Array.isArray(service.environments),
      environments: Array.isArray(service.environments) ? service.environments.map(item => ({ name: item.environment ?? item.name })) : [] };
  }, true)))).filter(Boolean);
  const deploymentRows = Array.isArray(deployments) ? deployments : deployments?.deployments;
  if (Array.isArray(deploymentRows)) {
    const ordered = [...deploymentRows].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
    evidence.productionDeployments = ordered.map(item => ({ id: item.id, createdOn: item.created_on,
      versions: item.versions?.map(version => ({ versionId: version.version_id, percentage: version.percentage })) }));
    const activeVersions = ordered[0]?.versions?.filter(version => version.percentage > 0) ?? [];
    evidence.productionVersionMetadata = (await Promise.all(activeVersions.map(version => collect(`active Worker version (${version.version_id})`, async () => {
      const info = (await get(`/workers/scripts/${config.name}/versions/${version.version_id}`)).result;
      const bindings = Array.isArray(info.resources?.bindings) ? info.resources.bindings : Object.values(info.resources?.bindings ?? {});
      const appOrigin = bindings.find(binding => binding.name === 'APP_ORIGIN' && binding.type === 'plain_text')?.text;
      let origin;
      try { origin = new URL(appOrigin).origin; } catch { origin = null; }
      return { id: info.id, number: info.number, percentage: version.percentage, createdOn: info.metadata?.created_on,
        compatibilityDate: info.resources?.script_runtime?.compatibility_date, usageModel: info.resources?.script_runtime?.usage_model,
        runtimeLimits: info.resources?.script_runtime?.limits, appOrigin: origin, appOriginMatchesConfigured: appOrigin === config.vars.APP_ORIGIN,
        d1Bindings: bindings.filter(binding => binding.type === 'd1').map(binding => ({ name: binding.name, databaseId: binding.id ?? binding.database_id })),
        r2Bindings: bindings.filter(binding => binding.type === 'r2_bucket').map(binding => ({ name: binding.name, bucketName: binding.bucket_name, jurisdiction: binding.jurisdiction })),
        secretNames: bindings.filter(binding => binding.type === 'secret_text').map(binding => binding.name).sort() };
    })))).filter(Boolean);
  } else evidence.errors.push({ check: 'production deployments', error: 'Deployment metadata did not report a verified list' });
  evidence.localNamedEnvironments = Object.keys(config.env ?? {});
  evidence.verifiedIsolatedStagingMap = false;
  evidence.stagingAssociation = 'Resource names alone do not establish an approved isolated staging map; review any candidates and actual bindings before use';
} catch (error) { evidence.errors.push({ stage, error: error.message }); }
evidence.finishedAt = new Date().toISOString();
fs.writeFileSync('.wrangler/audit-account-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = evidence.errors.length ? 1 : 0;
