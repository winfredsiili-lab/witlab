-- WitLab Batch 4: PDF pages, detected sections, generation audit log.
-- See docs/DATA_MODEL.md. The original PDF bytes are NOT stored; only the extracted text.

ALTER TABLE sources
  ADD COLUMN page_count integer CHECK (page_count IS NULL OR page_count >= 1),
  ADD COLUMN file_size  integer CHECK (file_size IS NULL OR file_size >= 0);

-- A PDF's extracted text, one row per page (pages with no readable text are stored as empty text).
CREATE TABLE source_pages (
  source_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number >= 1),
  content     text NOT NULL,
  PRIMARY KEY (source_id, page_number),
  FOREIGN KEY (source_id, user_id) REFERENCES sources (id, user_id) ON DELETE CASCADE
);

-- Structure found in a source. Never invented: 'bookmark' = the PDF's own outline, 'heading' = markdown
-- heading lines in pasted text, 'auto_part' = a long text split at paragraph boundaries so it can be studied in parts.
CREATE TABLE source_sections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  position   integer NOT NULL CHECK (position >= 0),
  kind       text NOT NULL CHECK (kind IN ('bookmark', 'heading', 'auto_part')),
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  level      integer NOT NULL CHECK (level >= 1),
  page_start integer CHECK (page_start >= 1),
  page_end   integer CHECK (page_end >= 1),
  char_start integer CHECK (char_start >= 0),
  char_end   integer CHECK (char_end >= 0),
  UNIQUE (id, user_id),
  UNIQUE (source_id, position),
  CHECK (page_end IS NULL OR page_start IS NOT NULL),
  CHECK (page_start IS NULL OR (page_end IS NOT NULL AND page_end >= page_start)),
  CHECK (char_end IS NULL OR char_start IS NOT NULL),
  CHECK (char_start IS NULL OR (char_end IS NOT NULL AND char_end > char_start)),
  CHECK ((page_start IS NOT NULL) <> (char_start IS NOT NULL)),
  FOREIGN KEY (source_id, user_id) REFERENCES sources (id, user_id) ON DELETE CASCADE
);

-- One row per generation attempt, whether it worked or not. Used for the daily limits and as an audit trail.
CREATE TABLE generation_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id           uuid,
  status              text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  scope               jsonb NOT NULL,
  scope_chars         integer NOT NULL CHECK (scope_chars >= 0),
  model               text NOT NULL,
  requested_cards     integer NOT NULL CHECK (requested_cards >= 1),
  candidates_returned integer NOT NULL DEFAULT 0,
  drafts_created      integer NOT NULL DEFAULT 0,
  discarded           jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code          text,
  error_message       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  FOREIGN KEY (source_id, user_id) REFERENCES sources (id, user_id) ON DELETE SET NULL (source_id)
);
CREATE INDEX generation_jobs_user_created_idx ON generation_jobs (user_id, created_at DESC);
CREATE INDEX generation_jobs_created_idx ON generation_jobs (created_at);
CREATE INDEX generation_jobs_source_idx ON generation_jobs (source_id);
