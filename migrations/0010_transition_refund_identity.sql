-- Nullable for existing bookings. Each guarded transition installs a new random
-- identity with its state change; equal timestamps cannot identify a winner.
ALTER TABLE bookings ADD COLUMN transition_id TEXT;

-- An intended refund and its ledger/effects commit together. Retain replay
-- identities for as long as the financial ledger; keys are scoped to actor/credit.
CREATE TABLE refund_operations (
  actor_id TEXT NOT NULL REFERENCES users(id),
  credit_id TEXT NOT NULL REFERENCES booking_credits(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES credit_transactions(id),
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, credit_id, idempotency_key)
);
