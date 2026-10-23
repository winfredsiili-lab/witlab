-- WitLab Batch 3: study sessions, responses (the learning-evidence log) and review scheduling.
-- See docs/DATA_MODEL.md and docs/LEARNING_ENGINE.md.

CREATE TABLE study_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  deck_id    uuid,
  mode       text NOT NULL CHECK (mode IN ('recall', 'connections', 'explain', 'apply', 'hybrid')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  CONSTRAINT study_sessions_ended_consistent CHECK ((status = 'active') = (ended_at IS NULL)),
  UNIQUE (id, user_id),
  -- Deleting a deck keeps the study history; the session just loses its deck.
  FOREIGN KEY (deck_id, user_id) REFERENCES decks (id, user_id) ON DELETE SET NULL (deck_id)
);
CREATE INDEX study_sessions_user_status_idx ON study_sessions (user_id, status, started_at DESC);

-- The queue is snapshotted when a session starts so the session is stable and resumable.
CREATE TABLE study_session_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL,
  card_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  position     integer NOT NULL CHECK (position >= 0),
  -- Why this card is in the session ("New card", "Answered incorrectly 2 days ago; ..."), shown to the learner.
  queue_reason text NOT NULL,
  UNIQUE (session_id, card_id),
  UNIQUE (session_id, position),
  FOREIGN KEY (session_id, user_id) REFERENCES study_sessions (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (card_id, user_id) REFERENCES cards (id, user_id) ON DELETE CASCADE
);

-- One row per answer. This table IS the learning-evidence log; progress is computed from it.
CREATE TABLE study_responses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL,
  card_id            uuid NOT NULL,
  user_id            uuid NOT NULL,
  card_revision      integer NOT NULL CHECK (card_revision >= 1),
  submitted_answer   text,
  verdict            text NOT NULL CHECK (verdict IN ('correct', 'partial', 'incorrect', 'ambiguous', 'not_evaluated')),
  eval_method        text NOT NULL CHECK (eval_method IN ('deterministic', 'self_assessed', 'ai')),
  feedback           text NOT NULL,
  -- Supplementary evidence only. Never an input to verdict or scheduling.
  confidence         smallint CHECK (confidence BETWEEN 1 AND 5),
  evaluator_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  responded_at       timestamptz NOT NULL DEFAULT now(),
  -- A card is answered at most once per session (also makes double submits harmless).
  UNIQUE (session_id, card_id),
  FOREIGN KEY (session_id, user_id) REFERENCES study_sessions (id, user_id) ON DELETE CASCADE,
  -- A response must belong to a card that is actually in that session.
  FOREIGN KEY (session_id, card_id) REFERENCES study_session_items (session_id, card_id) ON DELETE CASCADE,
  FOREIGN KEY (card_id, user_id) REFERENCES cards (id, user_id) ON DELETE CASCADE
);
CREATE INDEX study_responses_card_idx ON study_responses (user_id, card_id, responded_at DESC);

-- Scheduler state, one row per user and card. No row means the card has never been practised.
CREATE TABLE card_review_state (
  user_id          uuid NOT NULL,
  card_id          uuid NOT NULL,
  due_at           timestamptz NOT NULL,
  interval_days    integer NOT NULL CHECK (interval_days >= 0),
  ease             numeric(4, 2) NOT NULL CHECK (ease >= 1.30),
  repetitions      integer NOT NULL CHECK (repetitions >= 0),
  lapses           integer NOT NULL CHECK (lapses >= 0),
  last_reviewed_at timestamptz NOT NULL,
  last_verdict     text NOT NULL CHECK (last_verdict IN ('correct', 'partial', 'incorrect')),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_id),
  FOREIGN KEY (card_id, user_id) REFERENCES cards (id, user_id) ON DELETE CASCADE
);
CREATE INDEX card_review_state_due_idx ON card_review_state (user_id, due_at);
