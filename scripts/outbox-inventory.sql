-- Read-only counts. Never print message bodies, recipients, credentials or provider keys.
-- Nonzero review/expired-lease counts are operational work, not automatic resend approval.
SELECT delivery_state, channel, COUNT(*) AS items, MIN(created_at) AS oldest_created_at
FROM outbox GROUP BY delivery_state, channel ORDER BY delivery_state, channel;

SELECT 'legacy_unconfirmed' AS check_name, COUNT(*) AS candidates FROM outbox
WHERE delivery_state = 'needs_review' AND last_error = 'LEGACY_DELIVERY_UNCONFIRMED';

SELECT 'expired_claims' AS check_name, COUNT(*) AS candidates FROM outbox
WHERE delivery_state = 'sending' AND lease_until <= unixepoch('now') * 1000;

SELECT 'missing_claim_checkpoint' AS check_name, COUNT(*) AS candidates FROM outbox
WHERE delivery_state = 'sending' AND (claim_id IS NULL OR lease_until IS NULL OR provider_key IS NULL
  OR payload_json IS NULL OR account_fingerprint IS NULL OR first_attempt_at IS NULL OR replay_until IS NULL);

SELECT 'attempted_acceptance_without_provider_id' AS check_name, COUNT(*) AS candidates FROM outbox
WHERE delivery_state = 'accepted' AND first_attempt_at IS NOT NULL AND provider_id IS NULL;

SELECT 'sms_eligible_for_email_sender' AS check_name, COUNT(*) AS candidates FROM outbox
WHERE channel = 'sms' AND delivery_state IN ('ready','sending','retry');

SELECT 'email_pause' AS check_name, email_not_before FROM outbox_delivery_control WHERE id = 1;
