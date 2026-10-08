import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { advanceAuth, createScope, requestGuard, sessionState, setCurrentScope } from '../public/js/core/lifecycle.js';
import { api, onUnauthorized } from '../public/js/core/api.js';
import { listen } from '../public/js/core/dom.js';
import { createViewTools } from '../public/js/core/view.js';
import { createRouter } from '../public/js/core/router.js';

const savedFetch = globalThis.fetch;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const abort = { name: 'AbortError' };
afterEach(() => { setCurrentScope(null); advanceAuth(); globalThis.fetch = savedFetch; });

test('route ownership disposes initial resources before an async view returns', async () => {
  const old = Object.fromEntries(['document','window','location','history'].map(k => [k, globalThis[k]]));
  globalThis.document = new EventTarget();
  document.getElementById = () => null;
  globalThis.window = new EventTarget(); window.scrollTo = () => {};
  globalThis.location = { href: 'http://localhost/slow', origin: 'http://localhost' };
  globalThis.history = { state: {}, replaceState(s,_,url) { this.state = s; location.href = new URL(url,location.origin).href; }, pushState(s,_,url) { this.replaceState(s,_,url); } };
  const pending = deferred(); let signal, early = 0, late = 0, fast = 0;
  const router = createRouter({ routes: [
    { path:'/slow', async view(ctx) { signal = ctx.signal; ctx.own(() => early++); await pending.promise; return () => late++; } },
    { path:'/fast', view(ctx) { ctx.own(() => fast++); } },
  ], notFound() {} });
  try {
    const first = router.resolve(); await router.navigate('/fast');
    assert.equal(signal.aborted,true); assert.equal(early,1);
    pending.resolve(); await first; assert.equal(late,1); assert.equal(fast,0);
    router.invalidate(); assert.equal(fast,1);
  } finally { router.dispose(); for(const [key,value] of Object.entries(old)) { if(value===undefined) delete globalThis[key]; else globalThis[key]=value; } }
});

test('nested scopes close once and manual close detaches parent ownership', () => {
  const parent=createScope(), child=createScope(parent); let closed=0;
  child.own(() => closed++); child.dispose(); parent.dispose();
  assert.equal(closed,1); assert.equal(child.signal.aborted,true);
  const inactive=createScope(parent); let immediate=0; inactive.own(() => immediate++);
  assert.equal(immediate,1); assert.equal(inactive.isCurrent(),false);
});

test('route cancellation fences a fetch implementation that ignores AbortSignal', async () => {
  const scope=createScope(); const done=deferred(); let signal;
  globalThis.fetch=(_url,opts) => { signal=opts.signal; return done.promise; };
  const result=api.forScope(scope).get('/private');
  scope.dispose(); assert.equal(signal.aborted,true);
  done.resolve(Response.json({private:'old'})); await assert.rejects(result,abort);
});

test('route cancellation fences a response whose JSON parsing has already started', async () => {
  const scope=createScope(), parsed=deferred(), started=deferred();
  globalThis.fetch=async () => ({ok:true,headers:new Headers({'content-type':'application/json'}),json() { started.resolve(); return parsed.promise; }});
  const result=api.forScope(scope).get('/private'); await started.promise; scope.dispose();
  parsed.resolve({private:'old'}); await assert.rejects(result,abort);
});

test('session changes fence late 401 without expiring the new identity', async () => {
  const state=sessionState({user:{id:'old',role:'player'}}), pending=deferred(); let expired=0;
  const off=onUnauthorized(() => expired++);
  globalThis.fetch=() => pending.promise;
  try { const result=api.get('/old',{scope:null}); state.user={id:'new',role:'player'};
    pending.resolve(Response.json({error:{code:'UNAUTHORIZED'}},{status:401}));
    await assert.rejects(result,abort); assert.equal(expired,0); assert.equal(state.user.id,'new');
  } finally { off(); }
});

test('same-user profile edits retain current work; role changes cancel it', () => {
  const state=sessionState({user:{id:'same',role:'player',name:'Before'}});
  const guard=requestGuard({scope:null});
  try { state.user={id:'same',role:'player',name:'After'}; guard.check();
    state.user={id:'same',role:'staff'}; assert.throws(() => guard.check(),abort);
  } finally { guard.release(); }
});

test('identity change immediately disposes the view and its children before navigation', () => {
  const state=sessionState({user:{id:'old',role:'player'}});
  const scope=createScope(),child=createScope(scope);setCurrentScope(scope);let cleaned=0,writes=0;
  scope.own(()=>cleaned++);child.own(()=>cleaned++);
  const tools=createViewTools({navigate:()=>writes++})();state.user={id:'new',role:'player'};
  tools.navigate('/old-action');assert.equal(scope.signal.aborted,true);assert.equal(child.signal.aborted,true);
  assert.equal(cleaned,2);assert.equal(writes,0);
});

test('background requests outlive a route but are still canceled by logout', async () => {
  const scope=createScope(); setCurrentScope(scope); const pending=deferred();
  globalThis.fetch=() => pending.promise;
  const result=api.get('/badges',{scope:null}); scope.dispose(); advanceAuth();
  pending.resolve(Response.json({count:99})); await assert.rejects(result,abort);
});

test('caller abort combines with route ownership and prevents 401 notification', async () => {
  const caller=new AbortController(), scope=createScope(), pending=deferred(); let expired=0;
  globalThis.fetch=() => pending.promise; const off=onUnauthorized(() => expired++);
  try { const result=api.forScope(scope).get('/private',{signal:caller.signal}); caller.abort();
    pending.resolve(Response.json({},{status:401})); await assert.rejects(result,abort); assert.equal(expired,0);
  } finally { off(); }
});

test('an already disposed scope starts no request', async () => {
  const scope=createScope(); scope.dispose(); let requests=0;
  globalThis.fetch=async () => { requests++; return Response.json({}); };
  await assert.rejects(api.forScope(scope).get('/private'),abort); assert.equal(requests,0);
});

test('valid current 401 notifies once; quiet authentication failures stay quiet', async () => {
  globalThis.fetch=async () => Response.json({error:{code:'UNAUTHORIZED',message:'Synthetic'}},{status:401});
  let expired=0; const off=onUnauthorized(() => expired++);
  try { await assert.rejects(api.get('/private'),{status:401}); await assert.rejects(api.post('/login',{}, {quiet401:true}),{status:401}); assert.equal(expired,1); } finally { off(); }
});

test('owned event listeners are removed and cannot reattach after disposal', () => {
  const scope=createScope(); setCurrentScope(scope); const target=new EventTarget(); let calls=0;
  const off=listen(target,'action',() => calls++); target.dispatchEvent(new Event('action'));
  scope.dispose(); target.dispatchEvent(new Event('action')); off();
  listen(target,'action',() => calls++); target.dispatchEvent(new Event('action'));
  assert.equal(calls,1);
});

test('captured view tools prevent delayed rendering, navigation and new subscriptions', () => {
  const scope=createScope(); setCurrentScope(scope); let writes=0;
  const tools=createViewTools({show:()=>writes++,navigate:()=>writes++,toast:()=>writes++,listen})() ;
  scope.dispose(); setCurrentScope(createScope());
  assert.throws(() => tools.show('private'),abort); tools.navigate('/private'); tools.toast('old');
  const target=new EventTarget(); tools.listen(target,'action',()=>writes++); target.dispatchEvent(new Event('action'));
  assert.equal(writes,0);
});

test('owned timers and polling stop when a view fails or is replaced', async () => {
  const scope=createScope(); setCurrentScope(scope); let calls=0, stopped=0;
  const tools=createViewTools({poll:()=>() => stopped++})();
  tools.setTimeout(() => calls++,0); tools.setInterval(() => calls++,1); tools.poll(); scope.dispose();
  await new Promise(r => setTimeout(r,20)); assert.equal(calls,0); assert.equal(stopped,1);
});

test('async badge refresh and clipboard completion cannot continue an old action', async () => {
  const scope=createScope(); setCurrentScope(scope); const pending=deferred();
  const tools=createViewTools({refreshBadges:()=>pending.promise,copyText:()=>pending.promise})();
  const badge=tools.refreshBadges(),clipboard=tools.copyText('synthetic');scope.dispose();pending.resolve(true);
  await assert.rejects(badge,abort);await assert.rejects(clipboard,abort);
});

test('upload abort releases ownership and rejects as cancellation, with no late progress', async () => {
  const old=globalThis.XMLHttpRequest; let xhr;
  class SyntheticXHR extends EventTarget {
    constructor() { super(); xhr=this; this.upload=new EventTarget(); }
    open() {} setRequestHeader() {} send() {} abort() { this.dispatchEvent(new Event('abort')); }
  }
  globalThis.XMLHttpRequest=SyntheticXHR;
  const scope=createScope(); let progress=0,expired=0; const off=onUnauthorized(() => expired++);
  try { const result=api.forScope(scope).upload('/proof',new FormData(),{onProgress:()=>progress++}); scope.dispose();
    await assert.rejects(result,abort); xhr.status=401; xhr.responseText='{}'; xhr.dispatchEvent(new Event('load'));
    const event=new Event('progress'); Object.assign(event,{lengthComputable:true,loaded:1,total:1}); xhr.upload.dispatchEvent(event);
    assert.equal(progress,0); assert.equal(expired,0);
  } finally { off(); if(old===undefined) delete globalThis.XMLHttpRequest; else globalThis.XMLHttpRequest=old; }
});

test('lifecycle ignores cleanup exceptions and still cancels remaining resources', () => {
  const scope=createScope(); const old=console.error; let reports=0,cleaned=0; console.error=()=>reports++;
  try { scope.own(() => { throw new Error('Synthetic disposer'); }); scope.own(()=>cleaned++); scope.dispose(); scope.dispose(); assert.equal(reports,1); assert.equal(cleaned,1); } finally { console.error=old; }
});
