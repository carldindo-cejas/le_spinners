-- Read-only deployment discovery. No credentials, addresses or customer data.
SELECT name, applied_at FROM d1_migrations ORDER BY id;
SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;
PRAGMA table_info(users);
SELECT COUNT(*) AS accounts, SUM(role='player') AS players, SUM(role='staff') AS staff,
       SUM(role='admin') AS administrators, SUM(status='disabled') AS disabled FROM users;
SELECT COUNT(*) AS sessions FROM sessions;
