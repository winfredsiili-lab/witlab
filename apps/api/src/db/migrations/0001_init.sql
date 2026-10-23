-- WitLab Batch 2: users, sources, decks, cards, deck_cards, card_sources.
-- See docs/DATA_MODEL.md. Requires PostgreSQL 15+ (ON DELETE SET NULL with a column list).

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  display_name  text,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  source_type       text NOT NULL CHECK (source_type IN ('text', 'pdf')),
  status            text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error_message     text,
  original_filename text,
  content_text      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX sources_user_created_idx ON sources (user_id, created_at DESC);

CREATE TABLE decks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX decks_user_updated_idx ON decks (user_id, updated_at DESC);

CREATE TABLE cards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('draft', 'approved', 'rejected')),
  origin      text NOT NULL CHECK (origin IN ('manual', 'ai_generated')),
  card_type   text NOT NULL CHECK (card_type IN ('term_definition', 'short_answer', 'multiple_choice', 'numeric', 'open_ended')),
  prompt      text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 2000),
  answer      text NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 4000),
  answer_spec jsonb,
  rubric      jsonb,
  explanation text CHECK (explanation IS NULL OR char_length(explanation) <= 4000),
  revision    integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Approval can never be half-recorded.
  CONSTRAINT cards_approved_at_consistent CHECK ((status = 'approved') = (approved_at IS NOT NULL)),
  UNIQUE (id, user_id)
);
CREATE INDEX cards_user_status_idx ON cards (user_id, status, created_at DESC);

-- A card can be in many decks. Composite foreign keys guarantee a deck and a card
-- in the same row always belong to the same user, even if application code is wrong.
CREATE TABLE deck_cards (
  deck_id  uuid NOT NULL,
  card_id  uuid NOT NULL,
  user_id  uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deck_id, card_id),
  FOREIGN KEY (deck_id, user_id) REFERENCES decks (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (card_id, user_id) REFERENCES cards (id, user_id) ON DELETE CASCADE
);
CREATE INDEX deck_cards_card_idx ON deck_cards (card_id);

-- Provenance: which source passages support a card. Survives source deletion
-- (source_id becomes NULL; the title snapshot and excerpt stay).
CREATE TABLE card_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  source_id    uuid,
  source_title text NOT NULL,
  excerpt      text NOT NULL CHECK (char_length(excerpt) BETWEEN 1 AND 2000),
  page_start   integer CHECK (page_start >= 1),
  page_end     integer CHECK (page_end >= 1),
  char_start   integer CHECK (char_start >= 0),
  char_end     integer CHECK (char_end >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (page_start IS NULL OR page_end IS NULL OR page_end >= page_start),
  CHECK (char_start IS NULL OR char_end IS NULL OR char_end >= char_start),
  FOREIGN KEY (card_id, user_id) REFERENCES cards (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, user_id) REFERENCES sources (id, user_id) ON DELETE SET NULL (source_id)
);
CREATE INDEX card_sources_card_idx ON card_sources (card_id);
CREATE INDEX card_sources_source_idx ON card_sources (source_id);

-- Backstop for the approval rule. The service layer checks first and returns friendly errors;
-- these triggers make it impossible to bypass even with a bug or a direct SQL write.
CREATE FUNCTION enforce_deck_card_approved() RETURNS trigger AS $$
DECLARE
  card_status text;
BEGIN
  -- FOR SHARE stops the card from being changed away from 'approved' while this insert is in flight.
  SELECT status INTO card_status FROM cards WHERE id = NEW.card_id FOR SHARE;
  IF card_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Only approved cards can be added to a deck (card % is %)', NEW.card_id, card_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deck_cards_require_approved
  BEFORE INSERT ON deck_cards
  FOR EACH ROW EXECUTE FUNCTION enforce_deck_card_approved();

CREATE FUNCTION protect_approved_cards_in_decks() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.status <> 'approved'
     AND EXISTS (SELECT 1 FROM deck_cards WHERE card_id = OLD.id) THEN
    RAISE EXCEPTION 'Card % is in a deck and cannot leave the approved state', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cards_protect_deck_membership
  BEFORE UPDATE OF status ON cards
  FOR EACH ROW EXECUTE FUNCTION protect_approved_cards_in_decks();
