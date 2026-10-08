-- READ ONLY. Run against an isolated copy first; review target identity before
-- any live inspection. Counts flag candidates for investigation, not permission
-- to delete or automatically repair financial or customer history.
-- Compatible with the audited schema (0008) and the P0 upgrade (0011).
SELECT 'invalid_booking_dates' AS finding, COUNT(*) AS candidates
  FROM bookings WHERE length(date) != 10 OR date(date, '+0 days') IS NOT date;
SELECT 'invalid_slot_dates' AS finding, COUNT(*) AS candidates
  FROM booking_slots WHERE length(date) != 10 OR date(date, '+0 days') IS NOT date;
SELECT 'invalid_closure_dates' AS finding, COUNT(*) AS candidates
  FROM closures WHERE length(date) != 10 OR date(date, '+0 days') IS NOT date;
SELECT 'invalid_disruption_dates' AS finding, COUNT(*) AS candidates
  FROM disruptions WHERE date IS NOT NULL AND (length(date) != 10 OR date(date, '+0 days') IS NOT date);
SELECT 'invalid_maintenance_dates' AS finding, COUNT(*) AS candidates
  FROM resources WHERE maintenance_until IS NOT NULL
    AND (length(maintenance_until) != 10 OR date(maintenance_until, '+0 days') IS NOT maintenance_until);

SELECT 'credit_ledger_mismatch' AS finding, COUNT(*) AS candidates FROM booking_credits c
 WHERE c.remaining != COALESCE((SELECT SUM(t.amount) FROM credit_transactions t WHERE t.credit_id = c.id), 0);
SELECT 'repeated_transition_event_candidates' AS finding, COUNT(*) AS candidates FROM (
  SELECT booking_id, type, created_at FROM booking_events
   WHERE type IN ('proof_submitted','approved','rejected','cancelled','released')
   GROUP BY booking_id, type, created_at HAVING COUNT(*) > 1
);
-- Matching refund amounts/notes may represent legitimate separate refunds.
-- Compare external refund evidence; never infer cash movements from timestamps.
SELECT 'similar_refund_candidates' AS finding, COUNT(*) AS candidates FROM (
  SELECT credit_id, amount, note FROM credit_transactions WHERE kind = 'refund'
   GROUP BY credit_id, amount, note HAVING COUNT(*) > 1
);
SELECT 'live_closed_booking_without_disruption_item' AS finding, COUNT(DISTINCT b.id) AS candidates
  FROM bookings b JOIN booking_times t ON t.booking_id = b.id JOIN closures c ON c.date = t.date
 WHERE c.disruption_id IS NOT NULL AND (c.resource_id IS NULL OR c.resource_id = t.resource_id)
   AND (c.start_min IS NULL OR c.end_min IS NULL OR (c.start_min < t.end_min AND c.end_min > t.start_min))
   AND (b.status IN ('CONFIRMED','PAYMENT_SUBMITTED')
     OR (b.status IN ('TEMPORARY','REJECTED') AND b.hold_expires_at > unixepoch('now') * 1000))
   AND NOT EXISTS (SELECT 1 FROM disruption_items i WHERE i.disruption_id = c.disruption_id AND i.booking_id = b.id);

-- M07: candidates for historical effect repair. Legacy imports/test fixtures may
-- legitimately lack these events. Review original state and source evidence before
-- adding history; never resend email or alter financial balances from counts alone.
SELECT 'booking_without_creation_event' AS finding, COUNT(*) AS candidates FROM bookings b
 WHERE NOT EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id
   AND e.type IN ('created', 'credit_booked', 'console_booked'));
SELECT 'expired_booking_without_expiry_event' AS finding, COUNT(*) AS candidates FROM bookings b
 WHERE b.status = 'EXPIRED' AND NOT EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.type = 'expired')
   -- Final proof rejection ends the hold immediately and records `rejected`.
   AND NOT (b.hold_expires_at IS NULL AND b.rejected_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.type = 'rejected'));
SELECT 'completed_booking_without_completion_event' AS finding, COUNT(*) AS candidates FROM bookings b
 WHERE b.status = 'COMPLETED' AND NOT EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.type = 'completed');
SELECT 'warned_hold_without_warning_notice' AS finding, COUNT(*) AS candidates FROM bookings b
 WHERE b.warned_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.booking_id = b.id AND n.type = 'hold_expiring');

-- R2 existence/orphan inspection needs a separate controlled object inventory;
-- SQL alone cannot establish whether these private keys resolve. Do not export
-- raw proof keys or customer data into the public implementation tracker.
PRAGMA foreign_key_check;
