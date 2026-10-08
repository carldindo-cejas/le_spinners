-- Staff accounts use the existing users/session schema and credential format.
CREATE INDEX idx_users_role_created ON users(role, created_at DESC, id DESC);

-- An identity change must invalidate old cookies, just like a password/status change.
DROP TRIGGER users_auth_version_changed;
CREATE TRIGGER users_auth_version_changed
AFTER UPDATE OF email,password_hash,password_salt,password_iterations,password_scheme,role,status ON users
WHEN OLD.email IS NOT NEW.email OR OLD.password_hash IS NOT NEW.password_hash OR OLD.password_salt IS NOT NEW.password_salt
  OR OLD.password_iterations IS NOT NEW.password_iterations OR OLD.password_scheme IS NOT NEW.password_scheme
  OR OLD.role IS NOT NEW.role OR OLD.status IS NOT NEW.status
BEGIN
  UPDATE users SET auth_version=OLD.auth_version+1 WHERE id=NEW.id;
END;

-- A constant assertion row, not authorization state. A failed CHECK aborts the
-- entire D1 batch, including effects of a request authenticated before revocation.
CREATE TABLE mutation_authorization_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allowed INTEGER NOT NULL CONSTRAINT mutation_authorized CHECK (allowed = 1)
);
