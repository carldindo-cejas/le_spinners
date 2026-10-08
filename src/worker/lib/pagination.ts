import { badRequest } from './errors';

type Value = string | number;
export type PageRequest = { limit: number; scope: string; values: Value[] | null; asOf: number };

/** Cursors are query positions, never authorization. Every query retains its owner/role predicates. */
export function pageRequest(raw: { cursor?: string; limit?: string }, scope: string, types: ('string' | 'number')[]): PageRequest {
  const limit = raw.limit === undefined ? 50 : Number(raw.limit);
  if ((raw.limit !== undefined && !/^\d{1,3}$/.test(raw.limit)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest('Use a page size between 1 and 100.');
  let values: Value[] | null = null;
  let asOf = Date.now();
  if (raw.cursor) {
    try {
      if (raw.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw.cursor)) throw Error();
      const bytes = Uint8Array.from(atob(raw.cursor.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const decoded = JSON.parse(new TextDecoder('utf-8', { fatal:true, ignoreBOM:false }).decode(bytes));
      if (decoded.v !== 1 || decoded.scope !== scope || !Array.isArray(decoded.values) || decoded.values.length !== types.length) throw Error();
      if (decoded.values.some((v: unknown,i:number) => typeof v !== types[i] || (typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0)) || (typeof v === 'string' && (v.length > 254 || /[\u0000-\u001f]/.test(v))))) throw Error();
      values = decoded.values;
      if (!Number.isSafeInteger(decoded.asOf) || decoded.asOf < 0 || decoded.asOf > asOf) throw Error();
      asOf = decoded.asOf;
    } catch { throw badRequest('This history cursor is invalid or belongs to different filters. Refresh the list.'); }
  }
  return { limit, scope, values, asOf };
}

export function afterPage(page: PageRequest, columns: string[], direction: 'ASC' | 'DESC' = 'DESC', offset?: number) {
  const params: Value[] = [];
  if (!page.values) return { sql:'', params };
  const bind = (value: Value) => { params.push(value); return offset === undefined ? '?' : '?' + (offset + params.length); };
  const sql = columns.map((column,i) => '(' + columns.slice(0,i).map((prior,j) => `${prior} = ${bind(page.values![j]!)}`).concat(`${column} ${direction === 'ASC' ? '>' : '<'} ${bind(page.values![i]!)}`).join(' AND ') + ')').join(' OR ');
  return { sql:'(' + sql + ')', params };
}

export function pageResult<T>(results: T[], page: PageRequest, position: (row:T) => Value[]) {
  const rows = results.slice(0, page.limit), hasMore = results.length > page.limit;
  let nextCursor: string | null = null;
  if (hasMore && rows.length) {
    const encoded = new TextEncoder().encode(JSON.stringify({v:1,scope:page.scope,asOf:page.asOf,values:position(rows[rows.length - 1]!)}));
    nextCursor = btoa(Array.from(encoded, byte => String.fromCharCode(byte)).join('')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  return { rows, page:{ limit:page.limit, hasMore, nextCursor } };
}
