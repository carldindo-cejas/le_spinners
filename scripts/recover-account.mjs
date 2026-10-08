// Existing accounts only. Recovery authorization/identity checks belong to the named operator.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { ask, askHidden, localPepper, devPepper, deriveClientHash, newPasswordSalt, normalizeEmail, pepperHash, PASSWORD_ITERATIONS, PASSWORD_SCHEME, root } from './lib/passwords.mjs';
import { accountRecoverySql } from './lib/account-recovery.mjs';
const remote=process.argv.includes('--remote'),envAt=process.argv.indexOf('--env'),targetEnv=envAt>=0?process.argv[envAt+1]:null;
if(remote&&!targetEnv)throw Error('Remote recovery requires an explicit named --env and reviewed resource mapping.');
if(remote){const config=ts.parseConfigFileTextToJson('wrangler.jsonc',fs.readFileSync(path.join(root,'wrangler.jsonc'),'utf8')).config;const bindings=config?.env?.[targetEnv]?.d1_databases;if(!bindings?.some(b=>b.binding==='DB'&&b.database_id))throw Error('Named environment needs an explicit DB mapping before remote recovery.');}
const directory=path.join(root,'.wrangler','recovery');fs.mkdirSync(directory,{recursive:true});
const file=path.join(directory,randomUUID()+'.sql'),cli=path.join(root,'node_modules/wrangler/bin/wrangler.js');
function execute(sql){fs.writeFileSync(file,sql,{mode:0o600});const args=/^SELECT\b/.test(sql)?['--command',sql]:['--file',file];const r=spawnSync(process.execPath,[cli,'d1','execute','DB',remote?'--remote':'--local',...(targetEnv?['--env',targetEnv]:[]),...args,'--json'],{cwd:root,encoding:'utf8',windowsHide:true});if(r.status)throw Error('D1 recovery command failed; inspect migration/configuration with redacted diagnostics.');const start=r.stdout.search(/^\s*\[/m);if(start<0)throw Error('D1 returned no structured result.');return JSON.parse(r.stdout.slice(start));}
try {
  const email=normalizeEmail(await ask('Existing account email: ')),operator=(await ask('Named recovery operator / ticket: ')).trim();
  if(!email||!operator)throw Error('Email and operator/ticket are required.');
  const escaped=email.replaceAll("'","''"),found=execute(`SELECT id,auth_version,status FROM users WHERE email='${escaped}';`)[0]?.results?.[0];
  if(!found)throw Error('No existing account. Provisioning and recovery are separate operations.');
  const password=await askHidden('New temporary password (minimum 12 characters): ');
  if(password.length<12 || password.length>128)throw Error('Use 12-128 characters.');
  const pepper=remote?await askHidden('Target PASSWORD_PEPPER: '):localPepper();
  if(!pepper||pepper.length<32||(remote&&pepper===devPepper()))throw Error('A valid target pepper is required.');
  const salt=newPasswordSalt(),hash=pepperHash(pepper,await deriveClientHash(password,salt,PASSWORD_ITERATIONS));
  const changeId='recovery_'+randomUUID();
  execute(accountRecoverySql({id:found.id,version:found.auth_version,hash,salt,iterations:PASSWORD_ITERATIONS,scheme:PASSWORD_SCHEME,now:Date.now(),changeId,operator}));
  const result=execute(`SELECT COUNT(*) AS applied FROM users WHERE id='${found.id.replaceAll("'","''")}' AND auth_change_id='${changeId}';`);
  if(!result.at(-1)?.results?.[0]?.applied)throw Error('Account changed concurrently; re-check before retrying.');
  console.log('Recovery applied; all previous sessions revoked. Deliver the temporary password through the approved private channel and require the player to change it. Account status and ownership were preserved.');
} finally {if(fs.existsSync(file))fs.unlinkSync(file);}
