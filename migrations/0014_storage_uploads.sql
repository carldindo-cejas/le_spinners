-- Durable ownership precedes R2 writes. Attachment and deletion claims are mutually exclusive.
CREATE TABLE storage_uploads (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('proof','qr')),
  owner_id TEXT,
  booking_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('staged','attached','delete_pending','deleting','deleted','needs_review')),
  claim_id TEXT,
  upload_token TEXT,
  put_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  previous_key TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  delete_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_storage_upload_due ON storage_uploads(state,next_attempt_at,lease_until,created_at);
CREATE TABLE storage_scan_state (
  prefix TEXT PRIMARY KEY CHECK (prefix IN ('proofs/','settings/gcash-qr/')),
  cursor TEXT,
  claim_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_scan_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO storage_scan_state(prefix) VALUES ('proofs/'),('settings/gcash-qr/');
CREATE TABLE storage_qr_operations (
  id TEXT PRIMARY KEY,
  previous_key TEXT,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Backfill references only. No R2 deletion or retention decision occurs in this migration.
INSERT INTO storage_uploads(id,r2_key,kind,owner_id,booking_id,state,next_attempt_at,created_at,updated_at)
  SELECT 'legacy-proof/' || id,r2_key,'proof',user_id,booking_id,'attached',created_at + 86400000,created_at,created_at FROM payment_proofs;
INSERT OR IGNORE INTO storage_uploads(id,r2_key,kind,owner_id,state,next_attempt_at,created_at,updated_at)
  SELECT 'legacy-qr/current',value,'qr',updated_by,'attached',updated_at + 86400000,updated_at,updated_at FROM settings
  WHERE key='gcash_qr_key' AND value != '';
