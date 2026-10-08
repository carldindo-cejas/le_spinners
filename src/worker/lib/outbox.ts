import type { Bindings } from '../types';
import { newId, sha256Hex } from './crypto';

export const OUTBOX_BATCH_SIZE = 2;
export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_TIMEOUT_MS = 8_000;
export const OUTBOX_BUDGET_MS = 18_000;
export const OUTBOX_LEASE_MS = 60_000;
// Resend documents 24 hours. Stop well before expiry, including request timeout.
export const OUTBOX_REPLAY_MS = 23 * 3_600_000;
const REPLAY_GUARD_MS = 60_000;
const RESPONSE_LIMIT = 8192;

export type DeliveryState = 'ready' | 'sending' | 'retry' | 'accepted' | 'failed' | 'needs_review' | 'unsupported';
type ClaimedEmail = {
  id: string; attempts: number; claim_id: string; lease_until: number;
  replay_until: number; provider_key: string; payload_json: string; account_fingerprint: string;
};
type Outcome =
  | { state: 'accepted'; providerId: string }
  | { state: 'retry' | 'failed' | 'needs_review'; error: string; retryAfterMs?: number; cooldownMs?: number };

class ProviderReadError extends Error {}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new ProviderReadError('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    // Cancel unread data without letting an untrusted stream delay recovery.
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : null;
  } catch { return null; }
}

function retryAfter(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
  // Longer hints cannot safely replay this message anyway; do not retry early.
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 32 * 86400000)) : 0;
}

function retryDelay(attempts: number, minimum = 0): number {
  const base = Math.min(60_000 * 2 ** (attempts - 1), 15 * 60_000);
  const jitter = crypto.getRandomValues(new Uint32Array(1))[0]! / 0xffffffff;
  return Math.max(Math.ceil(base * (1 + jitter * 0.2)), minimum);
}

async function send(env: Bindings, row: ClaimedEmail): Promise<Outcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = async (): Promise<Outcome> => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': row.provider_key },
      body: row.payload_json,
    });
    const data = await responseJson(response);
    if (response.ok) {
      if (typeof data?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.id)) return { state: 'accepted', providerId: data.id };
      return { state: 'retry', error: 'INVALID_PROVIDER_RESPONSE' };
    }
    const name = typeof data?.name === 'string' && /^[a-z0-9_]{1,64}$/.test(data.name) ? data.name : '';
    const error = `PROVIDER_HTTP_${response.status}${name ? `_${name}` : ''}`;
    const delay = retryAfter(response.headers.get('Retry-After'), Date.now());
    if (response.status === 429) {
      const now = Date.now();
      const date = new Date(now);
      const quotaDelay = name === 'daily_quota_exceeded'
        ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - now + 60_000
        : name === 'monthly_quota_exceeded'
          ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - now + 60_000 : 0;
      return { state: 'retry', error, retryAfterMs: Math.max(delay, quotaDelay), cooldownMs: Math.max(delay, quotaDelay, 60_000) };
    }
    if (response.status >= 500 || response.status === 408 || (response.status === 409 && name === 'concurrent_idempotent_requests')) {
      return { state: 'retry', error, retryAfterMs: delay };
    }
    // A first-attempt explicit rejection is definitive. After an abandoned or
    // ambiguous earlier send, this response cannot prove it was never accepted.
    return { state: response.status < 400 || response.status === 409 || row.attempts > 1 ? 'needs_review' : 'failed', error };
  };
  try {
    const timeout = new Promise<Outcome>(resolve => {
      timer = setTimeout(() => { resolve({ state: 'retry', error: 'SEND_TIMEOUT' }); controller.abort(); }, OUTBOX_TIMEOUT_MS);
    });
    return await Promise.race([request(), timeout]);
  } catch (error) {
    controller.abort();
    return { state: 'retry', error: error instanceof ProviderReadError ? error.message : 'PROVIDER_NETWORK_ERROR' };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function claim(env: Bindings, fingerprint: string, now: number): Promise<ClaimedEmail | null> {
  const token = newId('claim_');
  const [result] = await env.DB.batch([env.DB.prepare(`UPDATE outbox SET
    delivery_state = 'sending', claim_id = ?1, lease_until = ?2, attempts = attempts + 1,
    first_attempt_at = COALESCE(first_attempt_at, ?3), replay_until = COALESCE(replay_until, ?4),
    provider_key = COALESCE(provider_key, ?5), account_fingerprint = COALESCE(account_fingerprint, ?6),
    payload_json = COALESCE(payload_json, json_object('from', ?7, 'to', json_array(recipient), 'subject', COALESCE(subject, 'Le Spinners'), 'text', body))
    WHERE id = (SELECT id FROM outbox WHERE channel = 'email' AND status = 'queued'
      AND (delivery_state IN ('ready','retry') OR (delivery_state = 'sending' AND lease_until <= ?3))
      AND next_attempt_at <= ?3 AND attempts < ?8 AND (replay_until IS NULL OR replay_until > ?9)
      AND (SELECT email_not_before FROM outbox_delivery_control WHERE id = 1) <= ?3
      ORDER BY next_attempt_at, created_at, id LIMIT 1)
    RETURNING id, attempts, claim_id, lease_until, replay_until, provider_key, payload_json, account_fingerprint`)
    .bind(token, now + OUTBOX_LEASE_MS, now, now + OUTBOX_REPLAY_MS, `le-spinners/email/${newId('key_')}`, fingerprint, env.EMAIL_FROM!, OUTBOX_MAX_ATTEMPTS, now + REPLAY_GUARD_MS)]);
  return (result?.results[0] as ClaimedEmail | undefined) ?? null;
}

async function settle(env: Bindings, row: ClaimedEmail, outcome: Outcome, now: number): Promise<DeliveryState | null> {
  const guard = `id = ? AND delivery_state = 'sending' AND claim_id = ? AND lease_until > ?`;
  const guardArgs = [row.id, row.claim_id, now];
  if (outcome.state === 'accepted') {
    const [result] = await env.DB.batch([env.DB.prepare(`UPDATE outbox SET status = 'sent', delivery_state = 'accepted', provider_id = ?, sent_at = ?,
      settled_claim_id = claim_id, claim_id = NULL, lease_until = NULL, next_attempt_at = 0, last_error = NULL WHERE ${guard}`)
      .bind(outcome.providerId, now, ...guardArgs)]);
    return result?.meta.changes ? 'accepted' : null;
  }
  const next = now + retryDelay(row.attempts, outcome.retryAfterMs);
  const exhausted = row.attempts >= OUTBOX_MAX_ATTEMPTS;
  const windowClosed = next + REPLAY_GUARD_MS >= row.replay_until;
  const state = outcome.state === 'retry' && (exhausted || windowClosed) ? 'needs_review' : outcome.state;
  const error = outcome.state === 'retry' && exhausted ? `RETRY_EXHAUSTED:${outcome.error}`
    : outcome.state === 'retry' && windowClosed ? `REPLAY_WINDOW_CLOSED:${outcome.error}` : outcome.error;
  const statements = [env.DB.prepare(`UPDATE outbox SET status = ?, delivery_state = ?, last_error = ?, next_attempt_at = ?,
    settled_claim_id = claim_id, claim_id = NULL, lease_until = NULL WHERE ${guard}`)
    .bind(state === 'failed' ? 'failed' : 'queued', state, error, state === 'retry' ? next : 0, ...guardArgs)];
  if (outcome.cooldownMs) {
    // Conditional on this claim having settled, in the same transaction.
    statements.push(env.DB.prepare(`UPDATE outbox_delivery_control SET email_not_before = MAX(email_not_before, ?)
      WHERE id = 1 AND EXISTS (SELECT 1 FROM outbox WHERE id = ? AND settled_claim_id = ? AND last_error = ?)`)
      .bind(now + outcome.cooldownMs, row.id, row.claim_id, error));
  }
  const [result] = await env.DB.batch(statements);
  return result?.meta.changes ? state : null;
}

/** Database state records provider acceptance, not inbox delivery. SMS is unsupported. */
export async function flushOutbox(env: Bindings) {
  const started = Date.now();
  const report = { sent: 0, failed: 0, retrying: 0, review: 0, claimed: 0, lost: 0, disabled: !env.RESEND_API_KEY || !env.EMAIL_FROM };
  // Recover at most eight expired/exhausted checkpoints, even while sending is disabled.
  const [recovered] = await env.DB.batch([env.DB.prepare(`UPDATE outbox SET delivery_state = 'needs_review', claim_id = NULL, lease_until = NULL,
    next_attempt_at = 0, last_error = CASE WHEN attempts >= ?1 THEN 'RETRY_EXHAUSTED' ELSE 'REPLAY_WINDOW_CLOSED' END
    WHERE id IN (SELECT id FROM outbox WHERE channel = 'email' AND status = 'queued' AND delivery_state IN ('ready','retry','sending')
      AND (lease_until IS NULL OR lease_until <= ?2) AND (attempts >= ?1 OR replay_until <= ?3)
      ORDER BY created_at, id LIMIT 8)`).bind(OUTBOX_MAX_ATTEMPTS, started, started + REPLAY_GUARD_MS)]);
  report.review = recovered?.meta.changes ?? 0;
  if (report.disabled) return report;
  const fingerprint = await sha256Hex(env.RESEND_API_KEY!);
  for (let n = 0; n < OUTBOX_BATCH_SIZE && Date.now() + OUTBOX_TIMEOUT_MS <= started + OUTBOX_BUDGET_MS; n++) {
    const row = await claim(env, fingerprint, Date.now());
    if (!row) break;
    report.claimed++;
    const now = Date.now();
    // Claim I/O can consume the invocation budget. Never start a late fetch.
    if (now + OUTBOX_TIMEOUT_MS > started + OUTBOX_BUDGET_MS) break;
    const outcome: Outcome = row.account_fingerprint !== fingerprint
      ? { state: 'needs_review', error: 'PROVIDER_CREDENTIALS_CHANGED' }
      : row.replay_until <= now + REPLAY_GUARD_MS
        ? { state: 'needs_review', error: 'REPLAY_WINDOW_CLOSED' }
        : await send(env, row);
    try {
      const state = await settle(env, row, outcome, Date.now());
      if (!state) { report.lost++; continue; }
      if (state === 'accepted') report.sent++;
      else if (state === 'failed') report.failed++;
      else if (state === 'needs_review') report.review++;
      else report.retrying++;
    } catch {
      // This is a persistence failure, not a provider send failure. Leave the
      // durable claim for recovery with the same key and payload after its lease.
      report.lost++;
      console.error(JSON.stringify({ msg: 'outbox acknowledgement failed', outboxId: row.id }));
    }
    if (outcome.state !== 'accepted' && outcome.cooldownMs) break;
  }
  return report;
}

type OutboxListRow = {
  id: string; channel: string; recipient: string; subject: string | null; status: string;
  delivery_state: DeliveryState; attempts: number; last_error: string | null; booking_id: string | null;
  created_at: number; sent_at: number | null; provider_id: string | null; next_attempt_at: number;
  lease_until: number | null; first_attempt_at: number | null; replay_until: number | null;
};

/** Admin read model omits the email body, frozen payload, API fingerprint and claim identities. */
export async function listOutbox(env: Bindings, state: DeliveryState | 'all' = 'all', now = Date.now()) {
  const filter = state === 'all' ? '1 = 1' : 'delivery_state = ?';
  const [recent, totals, control] = await env.DB.batch([
    env.DB.prepare(`SELECT id, channel, recipient, subject, status, delivery_state, attempts, last_error, booking_id,
      created_at, sent_at, provider_id, next_attempt_at, lease_until, first_attempt_at, replay_until
      FROM outbox WHERE ${filter} ORDER BY created_at DESC, id DESC LIMIT 50`).bind(...(state === 'all' ? [] : [state])),
    env.DB.prepare('SELECT delivery_state, COUNT(*) AS n FROM outbox GROUP BY delivery_state'),
    env.DB.prepare('SELECT email_not_before FROM outbox_delivery_control WHERE id = 1'),
  ]);
  const summary: Record<DeliveryState, number> = { ready: 0, sending: 0, retry: 0, accepted: 0, failed: 0, needs_review: 0, unsupported: 0 };
  for (const row of (totals?.results ?? []) as { delivery_state: DeliveryState; n: number }[]) summary[row.delivery_state] = row.n;
  const enabled = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  const labels: Record<DeliveryState, string> = {
    ready: 'Queued', sending: 'Sending', retry: 'Retry scheduled', accepted: 'Accepted by email provider',
    failed: 'Send rejected', needs_review: 'Delivery unconfirmed — review required', unsupported: 'SMS not connected',
  };
  return {
    summary, emailEnabled: enabled, smsEnabled: false,
    emailPausedUntil: Number((control?.results[0] as { email_not_before: number } | undefined)?.email_not_before ?? 0) || null,
    items: ((recent?.results ?? []) as OutboxListRow[]).map(o => ({
      id: o.id, channel: o.channel, recipient: o.recipient, subject: o.subject,
      status: o.status, deliveryState: o.delivery_state,
      statusLabel: o.delivery_state === 'accepted' && !o.provider_id ? 'Recorded as sent'
        : o.delivery_state === 'sending' && (o.lease_until ?? 0) <= now ? 'Recovery pending'
          : o.channel === 'email' && !enabled && ['ready', 'retry'].includes(o.delivery_state) ? 'Email sending not configured' : labels[o.delivery_state],
      attempts: o.attempts, lastError: o.last_error, bookingId: o.booking_id, createdAt: o.created_at,
      sentAt: o.sent_at, providerId: o.provider_id, nextAttemptAt: o.next_attempt_at || null,
      recoveryDueAt: o.lease_until, firstAttemptAt: o.first_attempt_at, replayUntil: o.replay_until,
    })),
  };
}
