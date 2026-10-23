# WitLab Data Model

Status: **Approved and implemented in Batch 2** (`apps/api/src/db/migrations/0001_init.sql`). Only the tables marked "Batch 2" exist. Later tables are documented here so Batch 2 does not paint us into a corner, but they are not created until their batch.

Implementation notes (where the build refined this draft):
- Minimum PostgreSQL version is **15** (`ON DELETE SET NULL (column)` for provenance links).
- All owned tables cascade from `users` (`ON DELETE CASCADE`), so deleting an account removes its data. Verified by a test.
- `answer_spec` shapes by `card_type` (validated in `packages/contracts/src/cards.ts`): `short_answer` `{acceptedAnswers: string[]}` (optional); `multiple_choice` `{choices: string[2..8], correctIndex}` and `answer` must equal the correct choice; `numeric` `{value, tolerance >= 0}`; `term_definition` and `open_ended` take none. `rubric` `{criteria: string[1..10]}` is allowed on `open_ended` only.
- Card state machine: `draft -> approved`, `draft -> rejected`. Nothing leaves `approved` (delete the card instead); rejected cards are read-only.

## 1. Conventions

- PostgreSQL 15+ (uses built-in `gen_random_uuid()` and `ON DELETE SET NULL (column)`).
- Primary keys: `uuid`. Timestamps: `timestamptz`, `created_at` and `updated_at` on mutable tables (`updated_at` set by the service layer on every write).
- Names: `snake_case`, plural table names.
- Closed value sets (status, type) use `text` + `CHECK` constraints, not Postgres enums. Adding a value later is a one-line migration.
- **Every user-owned table has `user_id uuid NOT NULL REFERENCES users(id)`.** Every repository function takes `userId` and filters on it. A request that supplies another user's id must get "not found", never the data.
- Ownership is also enforced in the database: tables that point at other owned tables use **composite foreign keys** `(x_id, user_id)`, so a deck can never contain another user's card even if application code has a bug.
- Migrations are plain numbered SQL files (`0001_init.sql`, ...) applied in order by a small runner that records them in a `schema_migrations` table. No ORM. Run with `npm run migrate --workspace @witlab/api`.

## 2. Entity overview

```
users 1──* sources
users 1──* decks
users 1──* cards
decks *──* cards            via deck_cards (a card can be in many decks)
cards *──* sources          via card_sources (provenance / evidence; a card may have several)

[Batch 3]  users 1──* study_sessions 1──* study_responses *──1 cards
           users *──* cards via card_review_state (scheduler state, one row per user+card)
[Batch 4]  sources 1──* source_sections ;  users 1──* generation_jobs *──1 sources
[Batch 6]  users 1──1 user_preferences
```

Key relationships from the spec:

- A **source** is evidence, not a deck. A **deck** is a list of approved cards. A **card** belongs to the user, not to a deck.
- Putting a card in a deck never copies the card or its provenance. Provenance hangs off the card.

## 3. Batch 2 tables

### users
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| email | text NOT NULL | unique index on `lower(email)` |
| display_name | text NULL | |
| password_hash | text NULL | NULL until real auth exists (see section 6) |
| created_at, updated_at | timestamptz | |

### sources
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid NOT NULL FK users | |
| title | text NOT NULL | 1 to 200 chars |
| source_type | text NOT NULL | CHECK in (`text`, `pdf`) |
| status | text NOT NULL DEFAULT `ready` | CHECK in (`pending`, `processing`, `ready`, `failed`). Used by the Batch 4 pipeline |
| error_message | text NULL | why processing failed, shown honestly to the learner |
| original_filename | text NULL | PDFs |
| content_text | text NULL | extracted or pasted text. Large; never returned by list endpoints |
| created_at, updated_at | timestamptz | |

Added in Batch 4 (not now): `storage_path` for the original PDF, page count, extraction metadata.
Constraint: `UNIQUE (id, user_id)` (target for composite FKs).

### decks
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid NOT NULL FK users | |
| title | text NOT NULL | 1 to 120 chars |
| description | text NULL | |
| created_at, updated_at | timestamptz | |

Constraint: `UNIQUE (id, user_id)`.

### cards
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid NOT NULL FK users | |
| status | text NOT NULL | CHECK in (`draft`, `approved`, `rejected`) |
| origin | text NOT NULL | CHECK in (`manual`, `ai_generated`) |
| card_type | text NOT NULL | CHECK in (`term_definition`, `short_answer`, `multiple_choice`, `numeric`, `open_ended`). The **form** of the task |
| prompt | text NOT NULL | the question |
| answer | text NOT NULL | expected answer / model answer |
| answer_spec | jsonb NULL | type-specific data: choices and correct index, accepted answers, numeric value and tolerance. Validated per `card_type` by Zod in the service layer |
| rubric | jsonb NULL | `{ criteria: string[] }` for open-ended cards |
| learning_mode | text NULL | `explain`, `connections` or `apply`; set exactly when `card_type = 'open_ended'` (Batch 6b) |
| explanation | text NULL | shown in feedback; the "why" |
| revision | integer NOT NULL DEFAULT 1 | incremented when prompt/answer/spec change. Study responses will record the revision answered |
| approved_at | timestamptz NULL | |
| created_at, updated_at | timestamptz | |

Constraints:
- `CHECK ((status = 'approved') = (approved_at IS NOT NULL))` so approval can never be half-recorded.
- `UNIQUE (id, user_id)`.
- Index `(user_id, status)`.

Deliberate non-columns:
- **Mode is chosen per session, not stored on most cards.** Recall serves every type except `open_ended`. Only written-answer cards carry a `learning_mode` (Batch 6b), because the question itself is written for one mode. Card type, mode and schedule stay separate concepts.
- **No revision-history table.** The spec says "where appropriate"; a `revision` counter is enough for now.

### deck_cards
| column | type | notes |
|---|---|---|
| deck_id | uuid NOT NULL | |
| card_id | uuid NOT NULL | |
| user_id | uuid NOT NULL | |
| position | integer NOT NULL | ordering within the deck |
| added_at | timestamptz | |

- `PRIMARY KEY (deck_id, card_id)`.
- `FOREIGN KEY (deck_id, user_id) REFERENCES decks (id, user_id) ON DELETE CASCADE`.
- `FOREIGN KEY (card_id, user_id) REFERENCES cards (id, user_id) ON DELETE CASCADE`.
- **Approval is enforced in the database too:** a trigger rejects inserts where the card's status is not `approved`, and rejects changing a card away from `approved` while it sits in any deck. The service layer checks first so errors are friendly; the trigger is the backstop.

### card_sources (provenance)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| card_id | uuid NOT NULL | |
| user_id | uuid NOT NULL | |
| source_id | uuid NULL | becomes NULL if the source is later deleted |
| source_title | text NOT NULL | snapshot of the title at link time, so provenance stays readable |
| excerpt | text NOT NULL | the passage that supports the card (bounded length) |
| page_start, page_end | integer NULL | |
| char_start, char_end | integer NULL | offsets into `sources.content_text` |
| created_at | timestamptz | |

- `FOREIGN KEY (card_id, user_id) REFERENCES cards (id, user_id) ON DELETE CASCADE`.
- `FOREIGN KEY (source_id, user_id) REFERENCES sources (id, user_id) ON DELETE SET NULL (source_id)`.
- Manual cards may have zero rows here. AI-generated cards must have at least one (enforced in the generation service, Batch 4).

### Deletion rules (Batch 2)
- Delete a **deck**: removes only its `deck_cards` rows. Cards survive (they are reusable).
- Delete a **source**: cards survive. Their `card_sources` rows keep the excerpt and title snapshot; `source_id` becomes NULL. The UI must say this before confirming.
- Delete a **card**: removes its `deck_cards` and `card_sources` rows. Handling of study history is decided in Batch 3 (see open questions).

## 4. Later tables (documented, not created yet)

**Batch 3, learning engine: implemented in `0002_study.sql`.** See `LEARNING_ENGINE.md` for behaviour.
- `study_sessions`: `id, user_id, deck_id NULL, mode (recall|connections|explain|apply|hybrid), status (active|completed|abandoned), started_at, ended_at`. `ended_at` is set exactly when status is not `active` (CHECK). Deleting a deck sets `deck_id` to NULL; history is kept. Only `recall` can be started so far.
- `study_session_items` (added during the build): the queue snapshotted when a session starts. `session_id, card_id, user_id, position, queue_reason`. Unique per `(session_id, card_id)` and `(session_id, position)`. `queue_reason` is the explanation shown to the learner ("New card", "Answered incorrectly 2 hours ago; ...").
- `study_responses`: one row per answer. `id, session_id, user_id, card_id, card_revision, submitted_answer, verdict (correct|partial|incorrect|ambiguous|not_evaluated), eval_method (deterministic|self_assessed|ai), feedback, confidence smallint NULL (1 to 5), evaluator_metadata jsonb, responded_at`. **This table is the learning-evidence log.** There is no separate "learning evidence" table; progress is computed from it. Confidence is stored here as supplementary data and is never an input to `verdict` or scheduling. Database-enforced: a card is answered at most once per session (`UNIQUE (session_id, card_id)`), and a response must reference a card that is actually in that session (foreign key to `study_session_items`).
- `card_review_state`: scheduler state, one row per `(user_id, card_id)`: `due_at, interval_days, ease numeric(4,2) >= 1.30, repetitions, lapses, last_reviewed_at, last_verdict (correct|partial|incorrect)`. A card with no row has never been practised, which keeps "never practised", "practised but wrong", "answered correctly" and "recalled consistently over time" distinguishable. A `not_evaluated` response never changes this row.

All four tables use the same composite `(id, user_id)` foreign keys as Batch 2, so a session can never include another user's card or deck. Deleting a card cascades to its review state, session items and responses.

**Batch 4, ingestion and generation: implemented in `0003_ingestion.sql`.**
- `sources` gained `page_count` and `file_size` (PDF only). For a PDF, `content_text` stays NULL; the text lives in `source_pages`, and `contentLength` is computed from it. `status` is only ever `ready` or `failed` today because import is synchronous (`pending`/`processing` are reserved for a future background import). A PDF that cannot be read is stored as a `failed` source with `error_message` and no pages.
- `source_pages`: `source_id, user_id, page_number, content`, primary key `(source_id, page_number)`. A page with no readable text is stored with empty content. Cascades with the source.
- `source_sections`: `id, source_id, user_id, position, kind (bookmark|heading|auto_part), title, level, page_start/page_end (PDF) or char_start/char_end (text; char_end exclusive)`. A section has pages or characters, never both (CHECK). `bookmark` = the PDF's own outline, `heading` = markdown heading lines in pasted text, `auto_part` = long unstructured text split at paragraph breaks into parts of at most 12,000 characters. Nothing else is ever inferred: a PDF without bookmarks and short text without headings have no sections. Sections are not nested by a parent id; `level` and order carry the hierarchy, and a section's range includes its subsections.
- `generation_jobs`: `id, user_id, source_id (SET NULL when the source is deleted), status (running|succeeded|failed), scope jsonb, scope_chars, model, requested_cards, candidates_returned, drafts_created, discarded jsonb ([{prompt, reason}]), error_code, error_message, created_at, finished_at`. One row per attempt, successful or not. It drives the daily limits and is the audit trail. Drafts are linked to their source through `card_sources`, not to the job.

**Batch 6a, implemented in `0004_preferences.sql`**
- `user_preferences`: `user_id PK, session_size (5..50, default 20), ask_confidence (default true), updated_at`. Only settings the app actually uses. No row means defaults. The display name stays on `users.display_name`.
- Progress needs no new table: it is computed from `card_review_state` (current state) and `study_responses` (evidence log). `study_responses.responded_at` is now written by the application with the same clock as the schedule (previously the database default), so evidence and schedule cannot disagree.

## 5. Source retention policy

- Pasted text lives in `sources.content_text`; extracted PDF text lives in `source_pages` (one copy; cards reference excerpts and positions, not whole documents).
- **The original PDF file is not stored.** Only its extracted text, page count and size are kept. This keeps the learner's files out of the database and avoids a storage service. The consequence: a PDF cannot be re-processed later (for example when OCR exists) without uploading it again.
- Deleting a source deletes its pages and sections. Cards made from it survive with their excerpt and title snapshot; generation jobs keep their record with `source_id` set to NULL.
- Source text is sent to the AI provider only when the learner presses Generate, and only the selected part. Logs must not contain source content, and error messages stored on jobs never contain it.

## 6. Authentication and ownership approach

Real sign-in is built (migration `0006_auth.sql`): `auth_sessions(id, user_id -> users ON DELETE CASCADE, token_hash UNIQUE, created_at, last_seen_at, expires_at, user_agent)` and `users.password_changed_at`. The token is 32 random bytes; only its SHA-256 is stored. Deleting a user cascades to every table that holds their data (verified by a test over every table with a `user_id` column). Sign-in is `AUTH_MODE=password` (default); `dev-stub` remains for local development and is refused in production. A pre-sign-in development account (no password) can be claimed by registering its email, outside production only.

- Every route goes through a `requireUser` middleware that yields a `userId`. Services and repositories only ever receive that `userId`.
- In Batch 2 the middleware runs in an explicit **dev-stub mode** (`AUTH_MODE=dev-stub`): it resolves one seeded development user. The server refuses to start in stub mode when `NODE_ENV=production`.
- Tests create **two users** and prove user B cannot read, update, delete or attach user A's sources, decks or cards by guessing ids.
- Real authentication (email and password with server-side sessions) replaces the middleware body later without touching routes, services or the schema (`password_hash` already exists).

## 7. Batch 2 API surface (summary; full contracts go in `API_CONTRACTS.md`)

- `sources`: create, list, get, update title, delete.
- `decks`: create, list, get (with card count), update, delete; add/remove/reorder cards.
- `cards`: create, list (filter by status), get, update, approve, reject, delete.
- All inputs validated with Zod schemas in `packages/contracts`; all errors use the standard error body.

## 8. Decisions (final)

1. **Auth in Batch 2:** dev-stub user, real auth later (section 6). Rationale: the study loop is the product; sign-in is replaceable behind `requireUser` without schema or route changes. The stub is refused in production, and tests prove cross-user isolation with two real users.
2. **Manually created cards:** created directly as `approved`. Only AI-generated cards start as drafts. The HTTP API can only create manual cards; `ai_generated` drafts can only come from the service layer, so generated cards cannot bypass approval by construction.
3. **Deleting a source:** cards survive; provenance keeps the excerpt and a title snapshot (`source_id` becomes NULL).
4. **Editing an approved card:** stays approved; `revision` increments only when prompt, answer, answerSpec or rubric change (not for explanation-only edits); review history is kept.
5. **Deleting a card that has study history:** (decided in Batch 3) the history is deleted with the card by database cascade; no archiving. The Library screen asks the learner to confirm before deleting a card and says the study history goes with it.

## 9. Batch 6b: `ai_evaluations`

One row per attempt to have a written answer judged: `id`, `user_id`, `card_id` (nullable; set null if the card is deleted), `session_id`, `status` (`pending`, `succeeded`, `failed`), `verdict` (when succeeded), `error_code` (when failed), `model`, `created_at`. It drives the daily evaluation limits (all attempts count) and is where failures are visible, since a failed evaluation writes no study response. Migration `0005_written_answers.sql` also adds `cards.learning_mode` with `CHECK ((card_type = 'open_ended') = (learning_mode IS NOT NULL))` and gives existing open-ended cards `explain`.
