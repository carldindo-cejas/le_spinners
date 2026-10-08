-- Keep legacy status values for API compatibility; delivery_state carries the
-- truthful attempt/recovery state. `accepted` is not proof of inbox delivery.
ALTER TABLE outbox ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'ready'
  CHECK (delivery_state IN ('ready','sending','retry','accepted','failed','needs_review','unsupported'));
ALTER TABLE outbox ADD COLUMN claim_id TEXT;
ALTER TABLE outbox ADD COLUMN settled_claim_id TEXT;
ALTER TABLE outbox ADD COLUMN lease_until INTEGER;
ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN first_attempt_at INTEGER;
ALTER TABLE outbox ADD COLUMN replay_until INTEGER;
ALTER TABLE outbox ADD COLUMN provider_key TEXT;
ALTER TABLE outbox ADD COLUMN provider_id TEXT;
ALTER TABLE outbox ADD COLUMN payload_json TEXT;
ALTER TABLE outbox ADD COLUMN account_fingerprint TEXT;

-- The old sender used no provider keys. An attempted, unacknowledged message
-- cannot safely be resent automatically, even when its legacy status is failed.
UPDATE outbox SET delivery_state = CASE
  WHEN status = 'sent' THEN 'accepted'
  WHEN channel = 'sms' THEN 'unsupported'
  WHEN attempts > 0 OR status = 'failed' THEN 'needs_review'
  ELSE 'ready' END,
  last_error = CASE WHEN channel = 'email' AND status != 'sent' AND (attempts > 0 OR status = 'failed')
    THEN 'LEGACY_DELIVERY_UNCONFIRMED' ELSE NULL END;

CREATE UNIQUE INDEX uq_outbox_provider_key ON outbox(provider_key) WHERE provider_key IS NOT NULL;
CREATE INDEX idx_outbox_delivery_due ON outbox(next_attempt_at, created_at, id)
  WHERE channel = 'email' AND status = 'queued';
CREATE INDEX idx_outbox_delivery_state ON outbox(delivery_state, created_at);
CREATE TRIGGER outbox_sms_unsupported AFTER INSERT ON outbox
WHEN NEW.channel = 'sms' AND NEW.status = 'queued' AND NEW.delivery_state = 'ready'
BEGIN
  UPDATE outbox SET delivery_state = 'unsupported' WHERE id = NEW.id;
END;

CREATE TABLE outbox_delivery_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email_not_before INTEGER NOT NULL DEFAULT 0
);
INSERT INTO outbox_delivery_control(id) VALUES(1);
