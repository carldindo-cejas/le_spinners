-- Read-only 0015+ counts. Never select credential fields, token hashes or customer identities.
SELECT 'invalid_account_version' AS check_name,COUNT(*) AS candidates FROM users
WHERE typeof(auth_version)!='integer' OR auth_version<1;
SELECT 'unversioned_sessions' AS check_name,COUNT(*) AS candidates FROM sessions WHERE auth_version=0;
SELECT 'session_version_ahead_of_account' AS check_name,COUNT(*) AS candidates FROM sessions s
JOIN users u ON u.id=s.user_id WHERE s.auth_version>u.auth_version;
SELECT 'revoked_session_rows_retained' AS information,COUNT(*) AS items FROM sessions s
JOIN users u ON u.id=s.user_id WHERE s.auth_version!=u.auth_version OR u.status!='active';
PRAGMA foreign_key_check;
