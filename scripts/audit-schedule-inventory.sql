-- READ ONLY, aggregate counts only. Findings are review candidates, not repair permission.
-- Ordinary schedule changes may deliberately retain acknowledged bookings. A nonzero
-- overlap therefore requires its acknowledgement/follow-up audit, not automatic cancel/credit.
SELECT 'financial_history_scope' AS check_name,
  (SELECT COUNT(*) FROM booking_credits) AS credits,
  (SELECT COUNT(*) FROM credit_transactions WHERE kind = 'refund') AS refunds,
  (SELECT COUNT(*) FROM refund_operations) AS refund_operations;

WITH live AS (
  SELECT b.* FROM bookings b WHERE
    (b.status IN ('CONFIRMED','PAYMENT_SUBMITTED') OR
      (b.status IN ('TEMPORARY','REJECTED') AND b.hold_expires_at > unixepoch('now') * 1000))
    AND (b.date > date('now','+8 hours') OR
      (b.date = date('now','+8 hours') AND b.end_min >
        CAST(strftime('%H','now','+8 hours') AS INTEGER) * 60 + CAST(strftime('%M','now','+8 hours') AS INTEGER)))
)
SELECT 'live_ordinary_closure_overlaps' AS check_name, COUNT(DISTINCT b.id) AS candidates
  FROM live b JOIN booking_times t ON t.booking_id = b.id JOIN closures c ON c.date = t.date
 WHERE c.disruption_id IS NULL AND (c.resource_id IS NULL OR c.resource_id = t.resource_id)
   AND (c.start_min IS NULL OR c.end_min IS NULL OR (c.start_min < t.end_min AND c.end_min > t.start_min));

WITH live AS (
  SELECT b.* FROM bookings b WHERE
    (b.status IN ('CONFIRMED','PAYMENT_SUBMITTED') OR
      (b.status IN ('TEMPORARY','REJECTED') AND b.hold_expires_at > unixepoch('now') * 1000))
    AND (b.date > date('now','+8 hours') OR
      (b.date = date('now','+8 hours') AND b.end_min >
        CAST(strftime('%H','now','+8 hours') AS INTEGER) * 60 + CAST(strftime('%M','now','+8 hours') AS INTEGER)))
)
SELECT 'live_out_of_service_resource_overlaps' AS check_name, COUNT(DISTINCT b.id) AS candidates
  FROM live b JOIN resources r ON r.id = b.resource_id
 WHERE r.status = 'disabled' OR r.open_play = 1 OR
   (r.status = 'maintenance' AND (r.maintenance_until IS NULL OR b.date < r.maintenance_until));

WITH live AS (
  SELECT b.* FROM bookings b WHERE
    (b.status IN ('CONFIRMED','PAYMENT_SUBMITTED') OR
      (b.status IN ('TEMPORARY','REJECTED') AND b.hold_expires_at > unixepoch('now') * 1000))
    AND (b.date > date('now','+8 hours') OR
      (b.date = date('now','+8 hours') AND b.end_min >
        CAST(strftime('%H','now','+8 hours') AS INTEGER) * 60 + CAST(strftime('%M','now','+8 hours') AS INTEGER)))
)
SELECT 'live_weekly_hours_overlaps' AS check_name, COUNT(DISTINCT b.id) AS candidates
  FROM live b JOIN booking_times t ON t.booking_id = b.id
  LEFT JOIN opening_hours h ON h.weekday = CAST(strftime('%w', b.date) AS INTEGER)
 WHERE h.weekday IS NULL OR h.is_open = 0 OR t.start_min < h.open_min OR t.end_min > h.close_min
   OR (t.start_min - h.open_min) % CAST(COALESCE((SELECT value FROM settings WHERE key = 'slot_minutes'), '60') AS INTEGER) != 0;

SELECT 'active_resource_overlap_pairs' AS check_name, COUNT(*) AS candidates FROM (
  SELECT DISTINCT a.id, b.id FROM bookings a JOIN booking_times ta ON ta.booking_id = a.id
    JOIN booking_times tb ON tb.resource_id = ta.resource_id AND tb.date = ta.date
      AND tb.start_min < ta.end_min AND tb.end_min > ta.start_min
    JOIN bookings b ON b.id = tb.booking_id AND a.id < b.id
   WHERE (a.status IN ('CONFIRMED','PAYMENT_SUBMITTED') OR
      (a.status IN ('TEMPORARY','REJECTED') AND a.hold_expires_at > unixepoch('now') * 1000))
     AND (b.status IN ('CONFIRMED','PAYMENT_SUBMITTED') OR
      (b.status IN ('TEMPORARY','REJECTED') AND b.hold_expires_at > unixepoch('now') * 1000))
);

SELECT 'repeated_terminal_event_candidates' AS check_name, COUNT(*) AS candidates FROM (
  SELECT booking_id, type FROM booking_events WHERE type IN ('approved','cancelled','released','expired','completed')
  GROUP BY booking_id, type HAVING COUNT(*) > 1
);
SELECT 'negative_credit_balances' AS check_name, COUNT(*) AS candidates FROM booking_credits WHERE remaining < 0;
SELECT 'proof_without_chat_reference' AS check_name, COUNT(*) AS candidates FROM payment_proofs p
 WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.proof_id = p.id AND m.booking_id = p.booking_id);

-- Explicit slot rows must describe their parent booking's resource, date and span.
-- Legacy bookings with no slot rows use booking_times' fallback and remain valid;
-- gaps between discontiguous slots and historical terminal-booking slots are valid.
SELECT 'slot_parent_identity_mismatches' AS check_name, COUNT(*) AS candidates
  FROM booking_slots s JOIN bookings b ON b.id = s.booking_id
 WHERE s.resource_id != b.resource_id OR s.date != b.date;
SELECT 'slots_outside_parent_span' AS check_name, COUNT(*) AS candidates
  FROM booking_slots s JOIN bookings b ON b.id = s.booking_id
 WHERE s.start_min < b.start_min OR s.end_min > b.end_min;
SELECT 'slot_parent_envelope_mismatches' AS check_name, COUNT(*) AS candidates
  FROM bookings b JOIN (
    SELECT booking_id, MIN(start_min) AS first_start, MAX(end_min) AS last_end
      FROM booking_slots GROUP BY booking_id
  ) s ON s.booking_id = b.id
 WHERE s.first_start != b.start_min OR s.last_end != b.end_min;
SELECT 'intra_booking_slot_overlap_pairs' AS check_name, COUNT(*) AS candidates
  FROM booking_slots a JOIN booking_slots b ON a.booking_id = b.booking_id
   AND a.start_min < b.start_min AND a.end_min > b.start_min;
PRAGMA foreign_key_check;
