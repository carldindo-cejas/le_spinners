-- Keep the legacy cash-channel enum intact. Configurable online methods are
-- identified separately, with immutable names/details on submitted payments.
CREATE TABLE payment_methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  account_name TEXT,
  account_number TEXT,
  qr_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
CREATE UNIQUE INDEX idx_payment_method_qr ON payment_methods(qr_key) WHERE qr_key IS NOT NULL;

INSERT INTO payment_methods(id, name, account_name, account_number, qr_key, created_at, updated_at)
VALUES ('gcash', 'GCash',
  NULLIF((SELECT value FROM settings WHERE key='gcash_name'), ''),
  NULLIF((SELECT value FROM settings WHERE key='gcash_number'), ''),
  NULLIF((SELECT value FROM settings WHERE key='gcash_qr_key'), ''),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000);

ALTER TABLE bookings ADD COLUMN payment_method_id TEXT REFERENCES payment_methods(id);
ALTER TABLE bookings ADD COLUMN payment_method_name TEXT;
ALTER TABLE payment_proofs ADD COLUMN payment_method_id TEXT REFERENCES payment_methods(id);
ALTER TABLE payment_proofs ADD COLUMN payment_method_name TEXT;
ALTER TABLE payment_proofs ADD COLUMN account_name TEXT;
ALTER TABLE payment_proofs ADD COLUMN account_number TEXT;

UPDATE bookings SET payment_method_id='gcash', payment_method_name='GCash'
WHERE payment_method='gcash' AND submitted_at IS NOT NULL;
UPDATE payment_proofs SET payment_method_id='gcash', payment_method_name='GCash';

-- Legacy settings/QR endpoints and existing seed files still update GCash.
-- Do not revive a disabled or removed method when a legacy client saves settings.
CREATE TRIGGER payment_methods_legacy_insert AFTER INSERT ON settings
WHEN NEW.key IN ('gcash_name', 'gcash_number', 'gcash_qr_key') BEGIN
  UPDATE payment_methods SET
    account_name=CASE WHEN NEW.key='gcash_name' THEN NULLIF(NEW.value,'') ELSE account_name END,
    account_number=CASE WHEN NEW.key='gcash_number' THEN NULLIF(NEW.value,'') ELSE account_number END,
    qr_key=CASE WHEN NEW.key='gcash_qr_key' AND deleted_at IS NULL THEN NULLIF(NEW.value,'') ELSE qr_key END,
    updated_at=NEW.updated_at WHERE id='gcash';
END;
CREATE TRIGGER payment_methods_legacy_update AFTER UPDATE OF value ON settings
WHEN NEW.key IN ('gcash_name', 'gcash_number', 'gcash_qr_key') BEGIN
  UPDATE payment_methods SET
    account_name=CASE WHEN NEW.key='gcash_name' THEN NULLIF(NEW.value,'') ELSE account_name END,
    account_number=CASE WHEN NEW.key='gcash_number' THEN NULLIF(NEW.value,'') ELSE account_number END,
    qr_key=CASE WHEN NEW.key='gcash_qr_key' AND deleted_at IS NULL THEN NULLIF(NEW.value,'') ELSE qr_key END,
    updated_at=NEW.updated_at WHERE id='gcash';
END;

-- The existing AFTER UPDATE booking/proof triggers cover the new snapshot columns.
