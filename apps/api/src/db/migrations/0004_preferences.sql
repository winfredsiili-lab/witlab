-- WitLab Batch 6: genuine learner preferences (only settings the app actually uses).
CREATE TABLE user_preferences (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  session_size   integer NOT NULL DEFAULT 20 CHECK (session_size BETWEEN 5 AND 50),
  ask_confidence boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
