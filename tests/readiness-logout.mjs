import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogoutManager, LOGOUT_KEY, LOGIN_ACK_KEY } from '../public/js/core/logout.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const storage=()=>{const data=new Map();return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),data};};
const fixture=(options={})=>createLogoutManager({storage:storage(),send:async()=>({ok:true}),uuid:()=>crypto.randomUUID(),...options});
const tick=()=>new Promise(r=>setTimeout(r,0));
const locks=()=>{let tail=Promise.resolve();return {request(_name,_options,run){const task=tail.then(run);tail=task.catch(()=>{});return task;}};};

test('logout hides immediately, coalesces repeated clicks and confirms only after acknowledgment',async()=>{
  const pending=deferred();let calls=0;const manager=fixture({send:()=>{calls++;return pending.promise;}});const changes=[];
  manager.subscribe(record=>changes.push(record?.phase));const first=manager.start();assert.equal(manager.read().phase,'pending');assert.equal(manager.blocked(),true);
  assert.equal(manager.start(),first);await tick();assert.equal(calls,1);pending.resolve({ok:true});await first;
  assert.equal(manager.read().phase,'confirmed');assert.equal(manager.blocked(),false);assert.equal(manager.busy,false);assert.ok(changes.includes('pending'));
});

test('network failure persists uncertainty across reload; retry confirms the same intent',async()=>{
  const store=storage();const manager=fixture({storage:store,send:async()=>{throw {code:'NETWORK'};}});
  await manager.start();const id=manager.read().id;assert.equal(manager.read().error,'network');assert.equal(manager.blocked(),true);
  const reload=fixture({storage:store});assert.equal(reload.read().id,id);assert.equal(reload.busy,false);await reload.start();assert.equal(reload.read().phase,'confirmed');assert.equal(reload.read().id,id);
});

test('timeout bounds even an adapter that ignores abort; late success cannot claim confirmation',async()=>{
  const late=deferred();let signal;const manager=fixture({timeout:10,send:s=>{signal=s;return late.promise;}});
  await manager.start();assert.equal(signal.aborted,true);assert.equal(manager.read().error,'timeout');late.resolve({ok:true});await tick();assert.equal(manager.read().phase,'failed');
});

test('malformed successful responses do not prove server revocation',async()=>{
  for(const response of [null,{}, {ok:false}]){const manager=fixture({send:async()=>response});await manager.start();assert.equal(manager.read().phase,'failed');assert.equal(manager.read().error,'response');}
});

test('500 and 401 remain unconfirmed and retryable',async()=>{
  for(const status of [500,401]){const manager=fixture({send:async()=>{throw {status};}});await manager.start();assert.equal(manager.read().phase,'failed');assert.equal(manager.blocked(),true);}
});

test('response loss after revocation recovers through idempotent retry',async()=>{
  let active=true,calls=0;const manager=fixture({send:async()=>{active=false;if(++calls===1)throw {code:'NETWORK'};return {ok:true};}});
  await manager.start();assert.equal(active,false);assert.equal(manager.read().phase,'failed');await manager.start();assert.equal(calls,2);assert.equal(manager.read().phase,'confirmed');
});

test('confirmed logout stays private on reload until an explicit acknowledged login',async()=>{
  const store=storage(),manager=fixture({storage:store});await manager.start();const id=manager.read().id;
  const reload=fixture({storage:store});assert.equal(reload.read().phase,'confirmed');assert.equal(store.getItem(LOGIN_ACK_KEY),null);
  await reload.authenticate(async()=>({user:{id:'new-user'}}));assert.equal(reload.read(),null);assert.equal(store.getItem(LOGIN_ACK_KEY),id);assert.equal(JSON.parse(store.getItem(LOGOUT_KEY)).phase,'confirmed');
});

test('pending logout refuses sign-in and does not issue a login request',async()=>{
  const pending=deferred();let logins=0;const manager=fixture({send:()=>pending.promise});const task=manager.start();
  await assert.rejects(manager.authenticate(async()=>{logins++;}),{name:'AbortError'});assert.equal(logins,0);pending.resolve({ok:true});await task;
});

test('authentication failure never clears a confirmed logout marker',async()=>{
  const manager=fixture();await manager.start();await assert.rejects(manager.authenticate(async()=>{throw Error('Incorrect credentials');}));assert.equal(manager.read().phase,'confirmed');
});

test('malformed sign-in response never retires a logout marker',async()=>{
  const manager=fixture();await manager.start();await assert.rejects(manager.authenticate(async()=>({})));assert.equal(manager.read().phase,'confirmed');
});

test('a fresh logout written during login acknowledgement remains authoritative',async()=>{
  const store=storage(),original=store.setItem,manager=fixture({storage:store});await manager.start();
  store.setItem=(key,value)=>{original(key,value);if(key===LOGIN_ACK_KEY)original(LOGOUT_KEY,JSON.stringify({id:'new-intent',phase:'confirmed'}));};
  await assert.rejects(manager.authenticate(async()=>({user:{id:'new-user'}})),{name:'AbortError'});assert.equal(manager.read().id,'new-intent');
});

test('unchanged visibility/storage notifications do not reset a live sign-in form',async()=>{
  const manager=fixture();await manager.start();let notifications=0;manager.subscribe(()=>notifications++);
  manager.receive();manager.receive();assert.equal(notifications,1);
});

test('a newer logout intent fences late login completion',async()=>{
  const store=storage(),pending=deferred();const manager=fixture({storage:store});const login=manager.authenticate(()=>pending.promise);
  await tick();const other=fixture({storage:store});await other.start();pending.resolve({user:{id:'stale-user'}});
  await assert.rejects(login,{name:'AbortError'});assert.equal(manager.read().phase,'confirmed');assert.equal(store.getItem(LOGIN_ACK_KEY),null);
});

test('late failing retry cannot overwrite another tab confirmation',async()=>{
  const store=storage(),pending=deferred();const old=fixture({storage:store,send:()=>pending.promise});const first=old.start();await tick();
  const other=fixture({storage:store});await other.start();pending.reject({code:'NETWORK'});await first;assert.equal(old.read().phase,'confirmed');
});

test('shared auth lock serializes concurrent retries into one revocation request',async()=>{
  const store=storage(),shared=locks(),pending=deferred();let calls=0;const send=()=>{calls++;return pending.promise;};
  const first=fixture({storage:store,locks:shared,send}),second=fixture({storage:store,locks:shared,send});
  const a=first.start(),b=second.start();await tick();assert.equal(calls,1);pending.resolve({ok:true});await Promise.all([a,b]);assert.equal(calls,1);assert.equal(first.read().phase,'confirmed');
});

test('logout waits for an overlapping login to settle and refuses its stale result',async()=>{
  const store=storage(),shared=locks(),pending=deferred(),events=[];const first=fixture({storage:store,locks:shared});
  const login=first.authenticate(()=>{events.push('login');return pending.promise;});await tick();
  const second=fixture({storage:store,locks:shared,send:async()=>{events.push('logout');return {ok:true};}});const logout=second.start();await tick();assert.deepEqual(events,['login']);
  pending.resolve({user:{id:'old-user'}});await assert.rejects(login,{name:'AbortError'});await logout;assert.deepEqual(events,['login','logout']);assert.equal(second.read().phase,'confirmed');
});

test('without Web Locks the same-tab queue respects timed-out requests',async()=>{
  const pending=deferred();let revocations=0;const manager=fixture({timeout:10,send:async()=>{revocations++;return {ok:true};}});
  const login=manager.authenticate(()=>pending.promise);await tick();await manager.start();assert.equal(manager.read().error,'timeout');assert.equal(revocations,0);
  pending.resolve({user:{id:'old'}});await assert.rejects(login,{name:'AbortError'});await tick();assert.equal(revocations,0);
});

test('storage write failure retains the local privacy barrier and warns about persistence',async()=>{
  const store={getItem:()=>null,setItem(){throw Error('Denied');}};const manager=fixture({storage:store,send:async()=>{throw {code:'NETWORK'};}});
  await manager.start();assert.equal(manager.read().phase,'failed');assert.equal(manager.persisted,false);assert.equal(manager.blocked(),true);
});

test('tab-storage fallback receives and persists cross-tab logout broadcasts',async()=>{
  const tab=storage(),receiver=fixture({storage:tab,sharedStorage:false});receiver.receive({record:{id:'broadcast',phase:'pending'}});
  assert.equal(receiver.blocked(),true);assert.equal(JSON.parse(tab.getItem(LOGOUT_KEY)).id,'broadcast');receiver.receive({record:{id:'broadcast',phase:'confirmed'}});
  receiver.receive({record:{id:'broadcast',phase:'failed'}});assert.equal(receiver.read().phase,'confirmed');
});

test('an older fallback broadcast cannot retire a newer pending logout',()=>{
  const manager=fixture({sharedStorage:false});manager.receive({record:{id:'new',phase:'pending',updatedAt:2}});
  manager.receive({record:{id:'old',phase:'confirmed',updatedAt:1}});assert.equal(manager.read().id,'new');assert.equal(manager.blocked(),true);
});

test('broadcast status is projected to non-sensitive fields',()=>{
  const manager=fixture({sharedStorage:false});manager.receive({record:{id:'safe',phase:'pending',user:'PRIVATE',credential:'PRIVATE'}});
  assert.deepEqual(manager.read(),{id:'safe',phase:'pending',updatedAt:0});
});

test('damaged persisted status blocks private rendering until a retry acknowledges logout',async()=>{
  const store=storage();store.setItem(LOGOUT_KEY,'broken JSON');const manager=fixture({storage:store});assert.equal(manager.blocked(),true);await manager.start();assert.equal(manager.read().phase,'confirmed');
});
