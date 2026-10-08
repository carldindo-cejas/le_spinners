import { currentScope, elementScope, setElementScope, abortError } from './lifecycle.js';
import { listen } from './dom.js';

/** Bounded history: replace each page, keeping only cursor positions for Back/Newer. */
export function historyPager(api, parent, reload, { label = 'History' } = {}) {
  const scope = elementScope(parent) || currentScope();
  let url = '', cursors = [null], next = null, busy = false, generation = 0, rollback = null;
  const nav = document.createElement('nav'); nav.className = 'row row-wrap history-pager'; nav.setAttribute('aria-label',label);
  const newer = document.createElement('button'), older = document.createElement('button'), status = document.createElement('span');
  for (const button of [newer,older]) { button.type='button'; button.className='btn btn-secondary btn-sm'; }
  newer.textContent='Newer'; older.textContent='Older'; status.className='small'; status.setAttribute('role','status');
  nav.append(newer,status,older);
  if (scope) setElementScope(nav,scope);
  function mount() { if (scope && !scope.isCurrent()) return; if (!nav.isConnected) parent.append(nav); newer.disabled=busy || cursors.length===1; older.disabled=busy || !next; nav.hidden=cursors.length===1 && !next; status.textContent=`Page ${cursors.length}`; }
  async function move(forward) {
    if (busy || (forward ? !next : cursors.length===1)) return;
    rollback=cursors.slice(); forward ? cursors.push(next) : cursors.pop(); generation++; busy=true; mount();
    try { await reload(); } finally { busy=false; rollback=null; mount(); }
  }
  listen(newer,'click',()=>move(false)); listen(older,'click',()=>move(true));
  scope?.own(()=>{ generation++; nav.remove(); });
  return {
    mount,
    reset() { generation++; cursors=[null]; next=null; rollback=null; mount(); },
    async get(target) {
      if (target !== url) { generation++; cursors=[null]; next=null; rollback=null; url=target; }
      const id=++generation, parsed=new URL(target,location.origin);
      if (cursors.at(-1)) parsed.searchParams.set('cursor',cursors.at(-1));
      try {
        const data=await api.get(parsed.pathname+parsed.search);
        if(id!==generation || (scope && !scope.isCurrent())) throw abortError();
        next=data.page?.hasMore ? data.page.nextCursor : null; mount(); return data;
      } catch(error) { if(id===generation && rollback) { cursors=rollback; rollback=null; } mount(); throw error; }
    },
  };
}
