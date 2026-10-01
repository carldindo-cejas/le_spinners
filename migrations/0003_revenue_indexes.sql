-- Revenue reporting (admin console → /revenue/).
-- Revenue is recognised when staff verify a payment (bookings.confirmed_at). The summary
-- cards sum confirmed_at ranges, and the booking ledger lists bookings that ever had a
-- payment proof (submitted_at set). Both are small partial indexes: rows without a
-- payment (holds that expired unpaid) are left out of them.

CREATE INDEX IF NOT EXISTS idx_bookings_confirmed ON bookings(confirmed_at) WHERE confirmed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_submitted ON bookings(submitted_at) WHERE submitted_at IS NOT NULL;
