-- Read-only counts on schema 0014+. Never print private keys, names, owners or image contents.
SELECT state,kind,COUNT(*) AS items,MIN(created_at) AS oldest_created_at
FROM storage_uploads GROUP BY state,kind ORDER BY state,kind;

SELECT 'untracked_proof_references' AS check_name,COUNT(*) AS candidates FROM payment_proofs p
WHERE NOT EXISTS (SELECT 1 FROM storage_uploads u WHERE u.r2_key=p.r2_key);

SELECT 'untracked_current_qr' AS check_name,COUNT(*) AS candidates FROM settings s
WHERE s.key='gcash_qr_key' AND s.value != '' AND NOT EXISTS (SELECT 1 FROM storage_uploads u WHERE u.r2_key=s.value);

SELECT 'references_under_deletion' AS check_name,COUNT(*) AS candidates FROM storage_uploads u
WHERE u.state IN ('delete_pending','deleting','deleted') AND (
  EXISTS (SELECT 1 FROM payment_proofs p WHERE p.r2_key=u.r2_key)
  OR EXISTS (SELECT 1 FROM settings s WHERE s.key='gcash_qr_key' AND s.value=u.r2_key));

SELECT 'invalid_staged_ownership' AS check_name,COUNT(*) AS candidates FROM storage_uploads
WHERE state='staged' AND (claim_id IS NULL OR upload_token IS NULL OR lease_until <= created_at);

SELECT 'invalid_deletion_ownership' AS check_name,COUNT(*) AS candidates FROM storage_uploads
WHERE state='deleting' AND (claim_id IS NULL OR lease_until=0);

SELECT 'cleanup_review' AS check_name,COUNT(*) AS candidates FROM storage_uploads WHERE state='needs_review';
SELECT 'expired_uploads' AS check_name,COUNT(*) AS candidates FROM storage_uploads
WHERE state='staged' AND lease_until <= unixepoch('now')*1000;
PRAGMA foreign_key_check;
