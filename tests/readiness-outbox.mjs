import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { app, fixture, NOW, TestD1, root } from './helpers/readiness.mjs';

function setup(t, count = 1) {
  const f = fixture(t);
  Object.assign(f.env, { RESEND_API_KEY: 'synthetic-provider-key', EMAIL_FROM: 'Synthetic <sender@example.invalid>' });
  let clock = NOW;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(console, 'error', () => {});
  for (let n = 0; n < count; n++) f.DB.sqlite.prepare(`INSERT INTO outbox(id,channel,recipient,subject,body,created_at)
    VALUES(?,'email','recipient@example.invalid','Synthetic subject','Synthetic body',?)`).run(`test_email_${n}`, NOW + n);
  return { ...f, advance(ms) { clock += ms; }, row: () => f.DB.one("SELECT * FROM outbox WHERE id='test_email_0'") };
}

function provider(t, intercept) {
  const calls = [], accepted = new Map();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    const key = options.headers['Idempotency-Key'];
    const call = { key, body: options.body, signal: options.signal };
    calls.push(call);
    const accept = () => {
      const identity = key || `unprotected_${calls.length}`;
      if (!accepted.has(identity)) accepted.set(identity, `provider_${accepted.size + 1}`);
      return Response.json({ id: accepted.get(identity) });
    };
    return intercept ? intercept(call, calls.length, accept) : accept();
  });
  return { calls, accepted };
}

test('M06 regression: overlapping flushes claim one email and send once', async t => {
  const f = setup(t);
  const p = provider(t);
  await Promise.all([app.flushOutbox(f.env), app.flushOutbox(f.env)]);
  assert.equal(p.calls.length, 1);
  assert.equal(p.accepted.size, 1);
  assert.equal(f.row().status, 'sent');
});

test('M06 regression: accepted send followed by D1 failure recovers without duplicate acceptance', async t => {
  const f = setup(t);
  const p = provider(t);
  let fail = true;
  f.DB.beforeExecute = stmt => {
    if (fail && /UPDATE outbox SET status = 'sent'/.test(stmt.sql)) { fail = false; throw Error('Injected acknowledgement failure'); }
  };
  await app.flushOutbox(f.env);
  assert.notEqual(f.row().status, 'sent');
  f.advance(120000);
  await app.flushOutbox(f.env);
  assert.equal(p.accepted.size, 1);
  assert.equal(f.row().status, 'sent');
});

test('M06 regression: provider accepts but loses response; retry uses the original identity', async t => {
  const f = setup(t);
  const p = provider(t, (_call, n, accept) => { const res = accept(); if (n === 1) throw Error('Response lost'); return res; });
  await app.flushOutbox(f.env);
  f.advance(120000);
  await app.flushOutbox(f.env);
  assert.equal(p.accepted.size, 1);
  assert.equal(f.row().status, 'sent');
});

test('M06 regression: retries retain the key and complete payload after sender changes', async t => {
  const f = setup(t);
  const p = provider(t, (_call, n, accept) => n === 1 ? Response.json({ name: 'service_unavailable' }, { status: 503 }) : accept());
  await app.flushOutbox(f.env);
  f.env.EMAIL_FROM = 'New sender <changed@example.invalid>';
  f.advance(120000);
  await app.flushOutbox(f.env);
  assert.match(p.calls[0].key, /^le-spinners\/email\//);
  assert.equal(p.calls[1].key, p.calls[0].key);
  assert.equal(p.calls[1].body, p.calls[0].body);
});

test('M06 regression: rate-limit response respects Retry-After rather than immediate retry', async t => {
  const f = setup(t);
  const p = provider(t, () => Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '300' } }));
  await app.flushOutbox(f.env);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 1);
  assert.ok(f.row().next_attempt_at >= NOW + 300000);
});

test('M06 regression: malformed success is unconfirmed rather than sent', async t => {
  const f = setup(t);
  provider(t, () => Response.json({}));
  await app.flushOutbox(f.env);
  assert.notEqual(f.row().status, 'sent');
});

test('M06 regression: one flush sends at most two emails from a backlog', async t => {
  const f = setup(t, 5);
  const p = provider(t);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 2);
  assert.equal(f.DB.count('outbox', "status='sent'"), 2);
});

test('M06 regression: no configuration sends no email and SMS remains unsent', async t => {
  const f = setup(t);
  delete f.env.RESEND_API_KEY;
  f.DB.sqlite.prepare("INSERT INTO outbox(id,channel,recipient,body,created_at) VALUES('test_sms','sms','synthetic-number','Test',?)").run(NOW);
  const p = provider(t);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 0);
  assert.equal(f.DB.count('outbox', "status='sent'"), 0);
});

test('M06: provider timeout aborts a hung request and retains a replayable retry', async t => {
  const f = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const p = provider(t, () => { started(); return new Promise(() => {}); });
  const flush = app.flushOutbox(f.env);
  await ready;
  t.mock.timers.tick(app.OUTBOX_TIMEOUT_MS);
  const result = await flush;
  assert.equal(result.retrying, 1);
  assert.equal(p.calls[0].signal.aborted, true);
  assert.equal(f.row().delivery_state, 'retry');
  assert.equal(f.row().last_error, 'SEND_TIMEOUT');
});

test('M06: timeout covers response-body reads after headers arrive', async t => {
  const f = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  provider(t, () => { started(); return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } }); });
  const flush = app.flushOutbox(f.env);
  await ready;
  t.mock.timers.tick(app.OUTBOX_TIMEOUT_MS);
  assert.equal((await flush).retrying, 1);
  assert.equal(f.row().last_error, 'SEND_TIMEOUT');
});

test('M06: oversized responses are bounded and never acknowledged as accepted', async t => {
  const f = setup(t);
  provider(t, () => Response.json({ id: 'provider_id', untrusted: 'x'.repeat(10000) }));
  await app.flushOutbox(f.env);
  assert.equal(f.row().delivery_state, 'retry');
  assert.equal(f.row().last_error, 'PROVIDER_RESPONSE_TOO_LARGE');
});

test('M06: abandoned claim is reclaimed after its lease with its original key', async t => {
  const f = setup(t);
  const p = provider(t);
  let fail = true;
  f.DB.afterCommit = statements => {
    if (fail && statements.some(s => /RETURNING id, attempts/.test(s.sql))) { fail = false; throw Error('Lost claim response'); }
  };
  await assert.rejects(app.flushOutbox(f.env), /Lost claim response/);
  const key = f.row().provider_key;
  assert.equal(p.calls.length, 0);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 0);
  f.advance(app.OUTBOX_LEASE_MS + 1);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].key, key);
  assert.equal(f.row().attempts, 2);
});

test('M06: lost acknowledgement response after commit cannot reopen an accepted email', async t => {
  const f = setup(t);
  const p = provider(t);
  let fail = true;
  f.DB.afterCommit = statements => {
    if (fail && statements.some(s => /SET status = 'sent'/.test(s.sql))) { fail = false; throw Error('Lost commit response'); }
  };
  await app.flushOutbox(f.env);
  f.advance(app.OUTBOX_LEASE_MS + 1);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 1);
  assert.equal(f.row().delivery_state, 'accepted');
});

test('M06: stale owner cannot acknowledge a newer claim or borrow its cooldown effect', async t => {
  const f = setup(t);
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  provider(t, async (_call, n, accept) => {
    if (n === 1) { started(); await held; return Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '600' } }); }
    return accept();
  });
  const first = app.flushOutbox(f.env);
  await ready;
  const token = f.row().claim_id;
  f.advance(app.OUTBOX_LEASE_MS + 1);
  await app.flushOutbox(f.env);
  const secondToken = f.row().settled_claim_id;
  assert.notEqual(token, secondToken);
  release();
  assert.equal((await first).lost, 1);
  assert.equal(f.row().delivery_state, 'accepted');
  assert.equal(f.row().settled_claim_id, secondToken);
  assert.equal(f.DB.one('SELECT email_not_before FROM outbox_delivery_control').email_not_before, 0);
});

test('M06: replay window expiry stops automatic sends and exposes review state', async t => {
  const f = setup(t);
  const p = provider(t, () => { throw Error('Lost response'); });
  await app.flushOutbox(f.env);
  f.advance(app.OUTBOX_REPLAY_MS);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 1);
  assert.equal(f.row().delivery_state, 'needs_review');
  assert.equal(f.row().last_error, 'REPLAY_WINDOW_CLOSED');
});

test('M06: exhausted uncertain attempts stop at five with truthful review state', async t => {
  const f = setup(t);
  const p = provider(t, () => { throw Error('Lost response'); });
  for (let n = 0; n < 8; n++) { await app.flushOutbox(f.env); f.advance(3600000); }
  assert.equal(p.calls.length, 5);
  assert.equal(f.row().attempts, 5);
  assert.equal(f.row().delivery_state, 'needs_review');
  assert.match(f.row().last_error, /^RETRY_EXHAUSTED/);
});

test('M06: definitive first-attempt rejection is failed and raw provider data is not retained', async t => {
  const f = setup(t);
  const p = provider(t, () => Response.json({ name: 'validation_error', message: 'PRIVATE recipient@example.invalid synthetic-provider-key' }, { status: 422 }));
  await app.flushOutbox(f.env);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 1);
  assert.equal(f.row().status, 'failed');
  assert.equal(f.row().delivery_state, 'failed');
  assert.equal(f.row().last_error, 'PROVIDER_HTTP_422_validation_error');
});

test('M06: concurrent provider key request retries; mismatched payload conflict requires review', async t => {
  const f = setup(t);
  const p = provider(t, (_call, n) => Response.json({ name: n === 1 ? 'concurrent_idempotent_requests' : 'invalid_idempotent_request' }, { status: 409 }));
  await app.flushOutbox(f.env);
  assert.equal(f.row().delivery_state, 'retry');
  f.advance(120000);
  await app.flushOutbox(f.env);
  assert.equal(f.row().delivery_state, 'needs_review');
  assert.equal(p.calls.length, 2);
});

test('M06: cooldown blocks other rows and overlapping workers after rate limiting', async t => {
  const f = setup(t, 5);
  const p = provider(t, () => Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '300' } }));
  await app.flushOutbox(f.env);
  f.advance(299000);
  await Promise.all([app.flushOutbox(f.env), app.flushOutbox(f.env)]);
  assert.equal(p.calls.length, 1);
  assert.equal(f.DB.one('SELECT email_not_before FROM outbox_delivery_control').email_not_before, NOW + 300000);
});

test('M06: quota rejection applies a shared cooldown beyond a short Retry-After', async t => {
  const f = setup(t, 5);
  const p = provider(t, () => Response.json({ name: 'daily_quota_exceeded' }, { status: 429, headers: { 'Retry-After': '1' } }));
  await app.flushOutbox(f.env);
  f.advance(120000);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 1);
  assert.ok(f.DB.one('SELECT email_not_before FROM outbox_delivery_control').email_not_before >= Date.parse('2026-10-08T00:00:00Z'));
});

test('M06: credential rotation cannot silently replay against another provider account', async t => {
  const f = setup(t);
  const p = provider(t, () => { throw Error('Lost response'); });
  await app.flushOutbox(f.env);
  f.env.RESEND_API_KEY = 'different-synthetic-provider-key';
  f.advance(120000);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 1);
  assert.equal(f.row().delivery_state, 'needs_review');
  assert.equal(f.row().last_error, 'PROVIDER_CREDENTIALS_CHANGED');
});

test('M06: invocation budget prevents another fetch after a slow send', async t => {
  const f = setup(t, 5);
  const p = provider(t, (_call, _n, accept) => { f.advance(11000); return accept(); });
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 1);
  assert.equal(f.DB.count('outbox', "delivery_state='accepted'"), 1);
});

test('M06: a slow claim cannot start a late fetch and can recover on another pass', async t => {
  const f = setup(t);
  const p = provider(t);
  f.DB.beforeWrite = statements => {
    if (statements.some(s => /RETURNING id, attempts/.test(s.sql))) { f.DB.beforeWrite = null; f.advance(15000); }
  };
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 0);
  assert.equal(f.row().delivery_state, 'sending');
  f.advance(60000);
  await app.flushOutbox(f.env);
  assert.equal(p.calls.length, 1);
  assert.equal(f.row().delivery_state, 'accepted');
});

test('M06: migration preserves history and quarantines attempted unkeyed legacy mail', t => {
  const DB = new TestD1();
  t.after(() => DB.sqlite.close());
  for (const name of readdirSync(path.join(root, 'migrations')).filter(n => n.endsWith('.sql') && n < '0013').sort()) DB.sqlite.exec(readFileSync(path.join(root, 'migrations', name), 'utf8'));
  const original = [
    ['sent_mail', 'email', 'sent', 1], ['fresh_mail', 'email', 'queued', 0],
    ['attempted_mail', 'email', 'queued', 1], ['failed_mail', 'email', 'failed', 5], ['sms', 'sms', 'queued', 0],
  ];
  for (const [id, channel, status, attempts] of original) DB.sqlite.prepare(`INSERT INTO outbox(id,channel,recipient,subject,body,status,attempts,created_at,sent_at)
    VALUES(?,?,'test@example.invalid','Test subject','Historical body',?,?,?,?)`).run(id, channel, status, attempts, NOW - 1000, status === 'sent' ? NOW : null);
  DB.sqlite.exec(readFileSync(path.join(root, 'migrations/0013_outbox_delivery.sql'), 'utf8'));
  assert.equal(DB.count('outbox'), 5);
  for (const [id, _channel, status, attempts] of original) {
    const row = DB.one('SELECT * FROM outbox WHERE id=?', id);
    assert.equal(row.status, status);
    assert.equal(row.attempts, attempts);
    assert.equal(row.body, 'Historical body');
    assert.equal(row.provider_key, null);
  }
  assert.equal(DB.one("SELECT delivery_state FROM outbox WHERE id='sent_mail'").delivery_state, 'accepted');
  assert.equal(DB.one("SELECT delivery_state FROM outbox WHERE id='fresh_mail'").delivery_state, 'ready');
  assert.equal(DB.one("SELECT delivery_state FROM outbox WHERE id='attempted_mail'").delivery_state, 'needs_review');
  assert.equal(DB.one("SELECT delivery_state FROM outbox WHERE id='failed_mail'").delivery_state, 'needs_review');
  assert.equal(DB.one("SELECT delivery_state FROM outbox WHERE id='sms'").delivery_state, 'unsupported');
  assert.deepEqual(DB.rows('PRAGMA foreign_key_check'), []);
});

test('M06: admin queue can find old failures beyond the recent 50 with private internals omitted', async t => {
  const f = setup(t, 55);
  provider(t, () => Response.json({ name: 'validation_error' }, { status: 422 }));
  await app.flushOutbox(f.env);
  const all = await app.listOutbox(f.env);
  assert.equal(all.items.length, 50);
  assert.equal(all.summary.failed, 2);
  const failed = await app.listOutbox(f.env, 'failed');
  assert.equal(failed.items.length, 2);
  assert.equal(failed.items[0].statusLabel, 'Send rejected');
  const encoded = JSON.stringify(failed);
  for (const value of ['Synthetic body', 'synthetic-provider-key', 'payload_json', 'account_fingerprint', 'provider_key', 'claim_id']) assert.equal(encoded.includes(value), false);
});

test('M06: admin queue distinguishes disabled email, SMS, retry and expired claims', async t => {
  const f = setup(t);
  delete f.env.RESEND_API_KEY;
  f.DB.sqlite.prepare("INSERT INTO outbox(id,channel,recipient,body,created_at) VALUES('sms','sms','test-number','Test',?)").run(NOW);
  let view = await app.listOutbox(f.env);
  assert.equal(view.items.find(o => o.channel === 'email').statusLabel, 'Email sending not configured');
  assert.equal(view.items.find(o => o.channel === 'sms').statusLabel, 'SMS not connected');
  f.DB.sqlite.prepare("UPDATE outbox SET delivery_state='sending', lease_until=? WHERE id='test_email_0'").run(NOW - 1);
  view = await app.listOutbox(f.env);
  assert.equal(view.items.find(o => o.channel === 'email').statusLabel, 'Recovery pending');
});

test('M06: outbox route remains admin-only and validates state filters', async t => {
  const f = setup(t);
  const api = new Hono();
  const error = (e, c) => c.json({ code: e.code }, e.status ?? 500);
  api.onError(error); app.adminSettingsRoutes.onError(error);
  let user = f.staff;
  api.use('*', async (c, next) => { c.set('user', user); await next(); });
  api.route('/admin', app.adminSettingsRoutes);
  const request = url => api.fetch(new Request(`http://localhost${url}`), f.env, f.c.executionCtx);
  assert.equal((await request('/admin/outbox')).status, 403);
  user = f.admin;
  assert.equal((await request('/admin/outbox?state=invalid')).status, 422);
  const response = await request('/admin/outbox?state=ready');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items.length, 1);
});
