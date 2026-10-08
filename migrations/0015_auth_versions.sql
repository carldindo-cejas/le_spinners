-- Preserve credentials and existing sessions. Versions fence future credential/role/status changes.
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1);
ALTER TABLE users ADD COLUMN auth_change_id TEXT;
ALTER TABLE sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0 CHECK (auth_version >= 0);
UPDATE sessions SET auth_version=(SELECT auth_version FROM users WHERE users.id=sessions.user_id);

-- Applies to application changes, administrative resets and direct operational updates.
-- The inner UPDATE changes only auth_version, so it cannot recursively fire this trigger.
CREATE TRIGGER users_auth_version_changed
AFTER UPDATE OF password_hash,password_salt,password_iterations,password_scheme,role,status ON users
WHEN OLD.password_hash IS NOT NEW.password_hash OR OLD.password_salt IS NOT NEW.password_salt
  OR OLD.password_iterations IS NOT NEW.password_iterations OR OLD.password_scheme IS NOT NEW.password_scheme
  OR OLD.role IS NOT NEW.role OR OLD.status IS NOT NEW.status
BEGIN
  UPDATE users SET auth_version=OLD.auth_version+1 WHERE id=NEW.id;
END;

-- An old unversioned writer must not silently issue a usable session on the new schema.
CREATE TRIGGER sessions_auth_version_insert
BEFORE INSERT ON sessions
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND status='active' AND auth_version=NEW.auth_version)
BEGIN
  SELECT RAISE(ABORT,'SESSION_AUTH_VERSION_MISMATCH');
END;
