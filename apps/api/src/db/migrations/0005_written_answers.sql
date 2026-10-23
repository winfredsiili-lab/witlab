-- WitLab Batch 6b: written-answer cards (Explain / Connections / Apply modes) and the AI evaluation ledger.

-- The learning mode an open-ended card is for. Recall-type cards have no mode (Recall is the mode of every other card type).
ALTER TABLE cards ADD COLUMN learning_mode text CHECK (learning_mode IN ('explain', 'connections', 'apply'));
UPDATE cards SET learning_mode = 'explain' WHERE card_type = 'open_ended';
ALTER TABLE cards ADD CONSTRAINT cards_mode_matches_type CHECK ((card_type = 'open_ended') = (learning_mode IS NOT NULL));

-- One row per attempt to have an answer judged by the AI, successful or not. A row starts as 'pending' so concurrent requests cannot overshoot the limits. Drives the daily evaluation limits
-- and records failures (a failed evaluation records no study response, so this is where it is visible).
CREATE TABLE ai_evaluations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  card_id    uuid,
  session_id uuid,
  status     text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  verdict    text CHECK (verdict IN ('correct', 'partial', 'incorrect', 'ambiguous')),
  error_code text,
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (card_id, user_id) REFERENCES cards (id, user_id) ON DELETE SET NULL (card_id)
);
CREATE INDEX ai_evaluations_user_created_idx ON ai_evaluations (user_id, created_at DESC);
CREATE INDEX ai_evaluations_created_idx ON ai_evaluations (created_at);
