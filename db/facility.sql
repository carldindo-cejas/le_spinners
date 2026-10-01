-- Courts and tables with prices (centavos). Safe to run on production once:
--   npx wrangler d1 execute DB --remote --file=db/facility.sql
-- Edit names or prices here before running, or change them later in Settings.

INSERT OR IGNORE INTO resources
  (id, activity, name, sort_order, status, price_member, price_non_member, created_at, updated_at)
VALUES
  ('court-1', 'pickleball',   'Court 1', 1, 'active', 50000, 60000, CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('court-2', 'pickleball',   'Court 2', 2, 'active', 50000, 60000, CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('court-3', 'pickleball',   'Court 3', 3, 'active', 50000, 60000, CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('table-1', 'table_tennis', 'Table 1', 1, 'active', 25000, 30000, CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('table-2', 'table_tennis', 'Table 2', 2, 'active', 25000, 30000, CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000),
  ('table-3', 'table_tennis', 'Table 3', 3, 'active', 25000, 30000, CAST(unixepoch() AS INTEGER) * 1000, CAST(unixepoch() AS INTEGER) * 1000);
