import worker from '../../src/worker/index';
import type { Bindings } from '../../src/worker/types';

// Local test entry only. Boolean gates deliberately order one verified login;
// bounded request-owned timers keep workerd alive without cross-request promises.
let released = false;
let paused = false;
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1') return new Response('Not found', { status: 404 });
    if (url.pathname === '/api/probe/pause') return Response.json({ paused });
    if (url.pathname === '/api/probe/release' && request.method === 'POST') {
      released = true;
      return Response.json({ ok: true });
    }
    if (request.headers.get('X-Auth-Race') !== 'pause-login') return worker.fetch(request, env, ctx);
    if (url.pathname !== '/api/auth/user/login' || request.method !== 'POST' || paused) return new Response('Invalid fixture request', { status: 400 });
    const original = new WeakMap<object, D1PreparedStatement>();
    const query = new WeakMap<object, string>();
    function wrap(stmt: D1PreparedStatement, sql: string): D1PreparedStatement {
      const proxy = new Proxy(stmt, { get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      original.set(proxy, stmt);
      query.set(proxy, sql);
      return proxy;
    }
    const DB = new Proxy(env.DB, { get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (statements.some(stmt => query.get(stmt)?.includes('INSERT INTO sessions'))) {
          paused = true;
          released = false;
          try {
            for (let n = 0; n < 100 && !released; n++) await new Promise<void>(resolve => setTimeout(resolve, 50));
            if (!released) throw new Error('Fixture gate timed out');
          } finally { paused = false; }
        }
        return target.batch(statements.map(stmt => original.get(stmt) || stmt));
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return worker.fetch(request, { ...env, DB }, ctx);
  },
};
