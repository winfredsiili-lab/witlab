-- WitLab Batch 8: real sign-in. Passwords live in users.password_hash (scrypt, never reversible).
-- A session is a random token held only in the browser's httpOnly cookie; only its SHA-256 hash is stored here,
-- so a copy of the database cannot be used to sign in as anyone.
CREATE TABLE auth_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
