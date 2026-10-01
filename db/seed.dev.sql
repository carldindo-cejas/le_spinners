-- LOCAL DEVELOPMENT ONLY. Demo people and bookings that mirror the design canvas.
-- Every demo account uses the password:  demo-pass-2026 (see the generated users block below)
-- Dates are relative to when you run the seed (Asia/Manila = UTC+8).
-- Run via:  npm run db:reset:local   (applies migrations, facility.sql, this file and demo proof images)

-- ── People ─────────────────────────────────────────────────────────────────
-- BEGIN GENERATED USERS (npm run db:seed:generate)
-- Every demo account uses the password:  demo-pass-2026   (hashes use the dev pepper in .dev.vars.example)
INSERT INTO users (id, email, name, phone, password_hash, password_salt, password_iterations, password_scheme, role, membership, member_code, member_until, status, created_at, updated_at) VALUES
  ('u_juan', 'juan.delacruz@example.com', 'Juan Dela Cruz', '0998 765 4321', 'XlFNxk6CnlriCpeOyILvU6Q85laq5hOUVOnJM5q6LFA', 'l7riMxye4QX2PbSYi2Twxw', 600000, 'client_pbkdf2_hmac_v1', 'player', 'member', 'LS-M-0142', '2027-03-31', 'active', CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('u_maria', 'maria.santos@example.com', 'Maria Santos', '0917 555 0114', 'LaIVhOnow0ATULuVkIbI1BlOuivL5vC8qPChBJqnj_k', 'qJLJwJ4EavFrUzv-z77eiw', 600000, 'client_pbkdf2_hmac_v1', 'player', 'member', 'LS-M-0087', '2027-01-31', 'active', CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('u_pedro', 'pedro.cruz@example.com', 'Pedro Cruz', '0928 555 0192', 'M4k5AD4qV-w75NOnK1heV5U6nEBS0xvxzD8GPj39WDs', '3uJGuUPVvIJrq2Ivq4gL5Q', 600000, 'client_pbkdf2_hmac_v1', 'player', 'none', NULL, NULL, 'active', CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('u_kim', 'kim.aquino@example.com', 'Kim Aquino', '0995 555 0158', 'kjJyyab78yVxVboscqrdPUO16ET1VSfmRoCupB_0ehM', 'rmr8y0JULV-KzPx-l5HUYw', 600000, 'client_pbkdf2_hmac_v1', 'player', 'pending', 'LS-M-0201', NULL, 'active', CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('u_ana', 'ana.reyes@lespinners.example', 'Ana Reyes', '0917 555 0100', 'rMEgF8XmPpM07jMc9AbhL0KVTElLAfx9J_DyyB-K-UA', 'wAG5U7QPsFMqu5aIHpRe9g', 600000, 'client_pbkdf2_hmac_v1', 'admin', 'none', NULL, NULL, 'active', CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('u_rhea', 'rhea.lim@lespinners.example', 'Rhea Lim', '0917 555 0130', '9cNtu2EJt7f1RaBE86oywcTYiabOorDTTEMAJF5QtQg', 'AK1_1ceP5yLcK-DXr2D5dA', 600000, 'client_pbkdf2_hmac_v1', 'staff', 'none', NULL, NULL, 'active', CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000);
-- END GENERATED USERS

UPDATE settings SET value = 'ana.reyes@lespinners.example', updated_at = CAST(unixepoch() AS INTEGER) * 1000 WHERE key = 'staff_alert_emails';
UPDATE settings SET value = '+63 917 555 0100', updated_at = CAST(unixepoch() AS INTEGER) * 1000 WHERE key = 'staff_alert_sms';

-- Court 3 is being resurfaced for the next few days.
UPDATE resources
   SET status = 'maintenance', maintenance_note = 'Resurfacing', maintenance_until = date('now', '+8 hours', '+4 days')
 WHERE id = 'court-3';

-- ── Bookings ───────────────────────────────────────────────────────────────
-- Maria: Table 1 tomorrow 7–8 PM, proof submitted 8 minutes ago (amount matches).
INSERT INTO bookings (id, ref, user_id, resource_id, date, start_min, end_min, status, amount_due, rate, hold_expires_at, submitted_at, created_at, updated_at) VALUES
  ('b_maria', 'LS-' || strftime('%Y%m%d', date('now', '+8 hours', '+1 day')) || '-911', 'u_maria', 'table-1', date('now', '+8 hours', '+1 day'), 1140, 1200, 'PAYMENT_SUBMITTED', 25000, 'member', NULL,
   CAST(unixepoch() AS INTEGER) * 1000 - 8 * 60000, CAST(unixepoch() AS INTEGER) * 1000 - 14 * 60000, CAST(unixepoch() AS INTEGER) * 1000 - 8 * 60000);

-- Pedro: Court 1 in 2 days 5–6 PM, non-member rate ₱600 but he typed ₱500.
INSERT INTO bookings (id, ref, user_id, resource_id, date, start_min, end_min, status, amount_due, rate, hold_expires_at, submitted_at, created_at, updated_at) VALUES
  ('b_pedro', 'LS-' || strftime('%Y%m%d', date('now', '+8 hours', '+2 days')) || '-906', 'u_pedro', 'court-1', date('now', '+8 hours', '+2 days'), 1020, 1080, 'PAYMENT_SUBMITTED', 60000, 'non_member', NULL,
   CAST(unixepoch() AS INTEGER) * 1000 - 21 * 60000, CAST(unixepoch() AS INTEGER) * 1000 - 27 * 60000, CAST(unixepoch() AS INTEGER) * 1000 - 21 * 60000);

-- Juan: Court 2 in 3 days 6–7 PM, confirmed by Ana.
INSERT INTO bookings (id, ref, user_id, resource_id, date, start_min, end_min, status, amount_due, rate, submitted_at, confirmed_at, confirmed_by, created_at, updated_at) VALUES
  ('b_juan_c2', 'LS-' || strftime('%Y%m%d', date('now', '+8 hours', '+3 days')) || '-901', 'u_juan', 'court-2', date('now', '+8 hours', '+3 days'), 1080, 1140, 'CONFIRMED', 50000, 'member',
   CAST(unixepoch() AS INTEGER) * 1000 - 50 * 60000, CAST(unixepoch() AS INTEGER) * 1000 - 45 * 60000, 'u_ana', CAST(unixepoch() AS INTEGER) * 1000 - 55 * 60000, CAST(unixepoch() AS INTEGER) * 1000 - 45 * 60000);

-- Kim: Court 1 tomorrow 6–7 PM, confirmed (membership pending → non-member rate).
INSERT INTO bookings (id, ref, user_id, resource_id, date, start_min, end_min, status, amount_due, rate, submitted_at, confirmed_at, confirmed_by, created_at, updated_at) VALUES
  ('b_kim', 'LS-' || strftime('%Y%m%d', date('now', '+8 hours', '+1 day')) || '-909', 'u_kim', 'court-1', date('now', '+8 hours', '+1 day'), 1080, 1140, 'CONFIRMED', 60000, 'non_member',
   CAST(unixepoch() AS INTEGER) * 1000 - 180 * 60000, CAST(unixepoch() AS INTEGER) * 1000 - 170 * 60000, 'u_ana', CAST(unixepoch() AS INTEGER) * 1000 - 190 * 60000, CAST(unixepoch() AS INTEGER) * 1000 - 170 * 60000);

-- ── Timeline events ────────────────────────────────────────────────────────
INSERT INTO booking_events (booking_id, type, actor_id, actor_role, note, created_at) VALUES
  ('b_maria',   'created',         'u_maria', 'player', NULL, CAST(unixepoch() AS INTEGER) * 1000 - 14 * 60000),
  ('b_maria',   'proof_submitted', 'u_maria', 'player', NULL, CAST(unixepoch() AS INTEGER) * 1000 - 8 * 60000),
  ('b_pedro',   'created',         'u_pedro', 'player', NULL, CAST(unixepoch() AS INTEGER) * 1000 - 27 * 60000),
  ('b_pedro',   'proof_submitted', 'u_pedro', 'player', NULL, CAST(unixepoch() AS INTEGER) * 1000 - 21 * 60000),
  ('b_juan_c2', 'created',         'u_juan',  'player', NULL, CAST(unixepoch() AS INTEGER) * 1000 - 55 * 60000),
  ('b_juan_c2', 'proof_submitted', 'u_juan',  'player', NULL, CAST(unixepoch() AS INTEGER) * 1000 - 50 * 60000),
  ('b_juan_c2', 'approved',        'u_ana',   'staff',  NULL, CAST(unixepoch() AS INTEGER) * 1000 - 45 * 60000),
  ('b_kim',     'created',         'u_kim',   'player', NULL, CAST(unixepoch() AS INTEGER) * 1000 - 190 * 60000),
  ('b_kim',     'proof_submitted', 'u_kim',   'player', NULL, CAST(unixepoch() AS INTEGER) * 1000 - 180 * 60000),
  ('b_kim',     'approved',        'u_ana',   'staff',  NULL, CAST(unixepoch() AS INTEGER) * 1000 - 170 * 60000);

-- ── Payment proofs (images are uploaded to local R2 by scripts/reset-local-db.mjs) ──
INSERT INTO payment_proofs (id, booking_id, user_id, r2_key, content_type, size, original_name, gcash_ref, amount_claimed, status, created_at) VALUES
  ('p_maria', 'b_maria',   'u_maria', 'proofs/seed/maria.png', 'image/png', 0, 'gcash-receipt.png', '987654321', 25000, 'submitted', CAST(unixepoch() AS INTEGER) * 1000 - 8 * 60000),
  ('p_pedro', 'b_pedro',   'u_pedro', 'proofs/seed/pedro.png', 'image/png', 0, 'IMG_2231.png',      NULL,        50000, 'submitted', CAST(unixepoch() AS INTEGER) * 1000 - 21 * 60000),
  ('p_juan',  'b_juan_c2', 'u_juan',  'proofs/seed/juan.png',  'image/png', 0, 'gcash-receipt.png', '123456789', 50000, 'approved',  CAST(unixepoch() AS INTEGER) * 1000 - 50 * 60000);

-- ── Booking chat ───────────────────────────────────────────────────────────
INSERT INTO messages (id, booking_id, sender_id, sender_role, kind, body, created_at) VALUES
  ('m_maria_1', 'b_maria',   'u_maria', 'player', 'text', 'I uploaded my payment screenshot.', CAST(unixepoch() AS INTEGER) * 1000 - 8 * 60000),
  ('m_pedro_1', 'b_pedro',   'u_pedro', 'player', 'text', 'Can I change my booking?', CAST(unixepoch() AS INTEGER) * 1000 - 15 * 60000),
  ('m_juan_1',  'b_juan_c2', 'u_ana',   'staff',  'text', 'Hi Juan, please send the payment screenshot here once payment is completed.', CAST(unixepoch() AS INTEGER) * 1000 - 54 * 60000),
  ('m_juan_2',  'b_juan_c2', 'u_juan',  'player', 'text', 'Done. I have uploaded the screenshot.', CAST(unixepoch() AS INTEGER) * 1000 - 50 * 60000),
  ('m_juan_3',  'b_juan_c2', 'u_ana',   'staff',  'text', 'Thank you. Your payment is verified — see you on court!', CAST(unixepoch() AS INTEGER) * 1000 - 45 * 60000);

INSERT INTO message_reads (booking_id, reader, last_read_at) VALUES
  ('b_pedro',   'staff',  CAST(unixepoch() AS INTEGER) * 1000 - 10 * 60000),
  ('b_juan_c2', 'staff',  CAST(unixepoch() AS INTEGER) * 1000 - 45 * 60000),
  ('b_juan_c2', 'player', CAST(unixepoch() AS INTEGER) * 1000 - 44 * 60000);

-- ── Notifications ──────────────────────────────────────────────────────────
INSERT INTO notifications (id, audience, user_id, booking_id, type, title, body, link, read_at, resolved_at, created_at) VALUES
  ('n_s_maria', 'staff', NULL, 'b_maria', 'proof_submitted', 'Maria Santos sent payment proof', 'Table 1 · booking requires verification', '/admin/verify/b_maria', NULL, NULL, CAST(unixepoch() AS INTEGER) * 1000 - 8 * 60000),
  ('n_s_maria_m', 'staff', NULL, 'b_maria', 'new_message', 'New message from Maria Santos', '"I uploaded my payment screenshot."', '/admin/messages/b_maria', NULL, NULL, CAST(unixepoch() AS INTEGER) * 1000 - 8 * 60000),
  ('n_s_pedro', 'staff', NULL, 'b_pedro', 'proof_submitted', 'Pedro Cruz sent payment proof', 'Court 1 · amount differs from the amount due', '/admin/verify/b_pedro', NULL, NULL, CAST(unixepoch() AS INTEGER) * 1000 - 21 * 60000),
  ('n_u_juan',  'user',  'u_juan', 'b_juan_c2', 'payment_verified', 'Payment verified', 'Booking confirmed · Court 2', '/bookings/b_juan_c2', NULL, NULL, CAST(unixepoch() AS INTEGER) * 1000 - 45 * 60000);
