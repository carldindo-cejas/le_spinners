-- Stable history pages and text-only unread work; financial/audit records are retained.
CREATE INDEX idx_booking_history_owner ON bookings(user_id, date DESC, start_min DESC, id DESC);
CREATE INDEX idx_booking_history_console ON bookings(date DESC, start_min DESC, id DESC);
CREATE INDEX idx_credit_history_owner ON booking_credits(user_id, created_at DESC, id DESC);
CREATE INDEX idx_credit_history_console ON booking_credits(created_at DESC, id DESC);
CREATE INDEX idx_message_history ON messages(booking_id, created_at DESC, id DESC);
CREATE INDEX idx_message_unread ON messages(sender_role, booking_id, created_at) WHERE kind='text';
CREATE INDEX idx_message_latest ON messages(booking_id, created_at DESC, id DESC) WHERE kind!='system';
CREATE INDEX idx_notification_history ON notifications(audience, user_id, created_at DESC, id DESC);
CREATE INDEX idx_notification_console_history ON notifications(audience, created_at DESC, id DESC);
CREATE INDEX idx_notification_unread ON notifications(audience, user_id, booking_id) WHERE read_at IS NULL;
CREATE INDEX idx_notification_unresolved ON notifications(audience, booking_id) WHERE resolved_at IS NULL;
