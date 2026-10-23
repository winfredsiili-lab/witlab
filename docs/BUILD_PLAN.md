# WitLab Build Plan

Agreed approach: logic first, thin functional UI alongside it, no design polish until the learning engine works.
Full product specification lives in `docs/PROJECT.md` (save the original spec there).

## Order

1. **Batch 1 - Foundation.** Monorepo, Express API, Postgres connection, health check, minimal React shell calling it.
2. **Batch 2 - Schema and persistence.** Sources, decks, cards (draft vs approved from day one), `user_id` ownership on everything.
3. **Batch 3 - Learning engine.** Study sessions, deterministic evaluation, confidence separate from correctness, evidence, simple SM-2-like scheduler. Works with hand-seeded cards, no AI.
4. **Batch 4 - Ingestion and generation.** Pasted text, real PDF extraction, AI generation behind an interface.
5. **Batch 5 - Approval and decks.** Backend-enforced approval; only approved cards reach study.
6. **Batch 6 - Learner experience.** Study modes, progress, profile, settings, responsive polish.
7. **Batch 7 - Hardening.** E2E tests, security and ownership checks, failure recovery, docs.

## Rules

- Do not advance until the current batch's acceptance criteria are checked.
- Write `DATA_MODEL.md` before Batch 2 and `LEARNING_ENGINE.md` before Batch 3.
- Only claim tests passed if they were actually run.

## Batch 1 acceptance criteria (done)

- [x] Frontend runs.
- [x] Backend runs.
- [x] Frontend calls the backend through the API client.
- [x] Postgres connectivity is verified by the health endpoint (and reports failure honestly).
- [x] No secrets committed; `.env.example` provided.
- [x] Clear structural foundation for later batches.

## Batch 2 acceptance criteria (done)

- [x] Sources, decks and cards can be created and retrieved through the backend.
- [x] Data persists in PostgreSQL (verified across a server restart and a fresh connection pool).
- [x] Invalid requests are handled explicitly (field-level `validation_error`, per-card-type rules).
- [x] Relationships are enforced by the database (composite ownership foreign keys, approval trigger, CHECK constraints), with tests that bypass the API to prove it.
- [x] The schema supports card approval and source provenance; AI drafts cannot be created through the HTTP API.
- [x] Cross-user isolation tested for sources, cards and decks.
- [x] Dev-stub authentication is refused in production.

Deferred by design: real sign-in (before release, see `DATA_MODEL.md` section 6); no new UI in this batch (first study screen arrives with Batch 3).

## Batch 3 acceptance criteria (done)

- [x] A learner can complete a study session using real persisted cards (verified through the API and through a real browser walk-through: `npm run e2e`).
- [x] Confidence is not treated as correctness: stored as evidence, never an input to the verdict or the schedule (a test fails if it leaks into scheduling).
- [x] Answers are evaluated with the appropriate method: deterministic for multiple choice, numeric and short answer; self-assessed (labelled as such) for term/definition; open-ended cards are not studyable until AI evaluation exists, and are never marked correct.
- [x] Feedback appears before the learner continues (the feedback screen has to be dismissed to see the next card).
- [x] Study responses persist (one row per answer, with the card revision, method, feedback and confidence).
- [x] Due-review behaviour is deterministic and testable (pure scheduler with an injected clock; API tests drive time forward).
- [x] Unreadable answers (for example non-numeric text for a numeric card) are rejected without recording anything.
- [x] The correct answer is never sent to the client before answering (auto cards).
- [x] Concurrent submissions cannot double-record or double-schedule (row lock, unique constraint and a deterministic lock test).

Deliberate limits: Recall mode only; a wrong answer is re-queued for a later session (about 10 minutes), not repeated within the same session; progress screens and AI evaluation come later. The Library and deck screens are functional and plain, not designed. Design polish follows in Batch 6 per the agreed order.

## Batch 4 acceptance criteria (done, with one disclosed gap)

- [x] Pasted text and real PDF text extraction work (per-page text, PDF bookmarks as sections, markdown headings as sections, long text split into parts). Verified with real PDF fixtures: bookmarks, no bookmarks, mixed text/image pages, scanned, password protected, truncated, not a PDF.
- [x] Import status and errors are persisted and visible: an unreadable PDF is kept as a failed source with a plain reason; image-only pages produce a warning. OCR is NOT implemented and the app says so.
- [x] The learner chooses the scope (whole source, section, page or character range); a selection over 12,000 characters is refused, never silently cut.
- [x] AI sits behind a provider interface; an OpenAI-compatible adapter handles timeout, rate limits, bad keys, outages, truncation and malformed JSON, each reported honestly.
- [x] Generated cards are drafts only, carry provenance copied from the source (including page), and pass the same validation as manual cards. A card whose quote is not in the selected text is dropped and the reason shown (mutation-tested).
- [x] A failed generation creates no cards and does not touch the source; drafts are created all-or-nothing.
- [x] Per-user and global daily limits, and one generation at a time per user, enforced in the database.
- [x] Works without an AI key (503 `ai_not_configured`; everything else unaffected).
- [x] The API key never leaves the backend (tests check API responses).
- [ ] **Not verified against the real provider.** No API key was available while building, so the adapter was tested against local servers that imitate the documented response format (see `docs/AI_PROVIDER.md`). Do a first live generation yourself and read any error message.

Deliberate limits: no OCR; no background import (large PDFs are processed during the upload request); the original PDF is not kept; approving a draft does not yet place it in a deck (Batch 5 adds approval and deck workflows; for now add approved cards to a deck from the deck page).

## Batch 5 acceptance criteria (done)

- [x] Review queue: all drafts across sources (filter by source), each with its answer, choices or number rule, and the quoted passage with source and page.
- [x] Edit before approving: question and explanation for every type; answer too for term/definition cards. Editing a draft keeps it a draft and does not bump its revision. (Editing the answer of other types would also mean editing choices, accepted answers or the number, which the review screen does not do yet: reject and re-create, or edit through `PATCH /api/cards/:id`.)
- [x] Approve or reject one or many, optionally adding approved cards to a deck in the same step. Bulk actions are all-or-nothing and deadlock-safe (deck lock, then cards in id order); concurrent bulk approvals of the same drafts: one wins, the other gets 409 (tested).
- [x] Drafts and rejected cards cannot reach study: the database refuses non-approved cards in decks (Batch 2), checked again in the browser walkthrough (study queue held only the two approved cards).
- [x] Provenance survives approval and editing.
- [x] Browser walkthrough of the whole loop: paste, generate (stub AI), edit, reject, approve into a deck, study, schedule (`npm run e2e:review`).

Deliberate limits: no "approve and keep editing" for non-term cards; no undo of a rejection (rejected cards are kept but read-only); no search or sort in the queue.

## Batch 6a acceptance criteria (done): the evidence-based half of "learner experience"

Batch 6 in the spec also includes Connections, Explain, Apply and Hybrid modes. Those need AI to judge written answers, which is not built, so Batch 6 is split. 6a is everything that can be built and verified honestly now; 6b is the AI-evaluated modes.

- [x] A new learner sees a clear starting path (Start here); a returning learner sees what is due, an unfinished session to resume (with its real count), drafts waiting, decks and a progress summary.
- [x] Progress shows real evidence only: four defined card states, 14-day activity, 30-day answer counts with self-graded answers separated, cards needing attention, per-deck breakdown. No score or percentage; small samples are labelled. Thresholds are mutation-tested.
- [x] Settings contain only working preferences: name, cards per session (used by the API), confidence prompt on/off (used by the study screen), AI allowance, system status. Sign-in/account management is stated as not set up.
- [x] The study-mode picker lists all five modes; only Recall is selectable and the others say why they are not available. Nothing pretends to work.
- [x] Responsive: navigation wraps on phones; no horizontal scroll at 375px on Home, Library, Review, Progress and Settings (browser-checked).
- [x] Evidence log and schedule share one clock (found while testing progress).

Not done (6b): Connections, Explain, Apply and Hybrid modes, AI evaluation of written answers, AI-generated open-ended cards. Also not done: a visual design pass (colours and type are still placeholder tokens), dark mode, profile image, notifications.

## Batch 6b acceptance criteria (done): AI-judged written answers

- [x] Explain, Connections and Apply study `open_ended` cards by their `learning_mode`. Recall excludes them. Hybrid is listed and disabled (not built). The three modes need an AI key: without one they answer `503 ai_not_configured` and Recall is untouched.
- [x] A written answer is judged by the AI against the model answer, the card's criteria and the source passages it came from. The reply is validated (verdict `correct|partial|incorrect|ambiguous` plus feedback); anything unusable is `ai_bad_response`.
- [x] **A failed, timed-out, rate-limited, truncated or malformed AI call records nothing**: no response, no schedule change; the card stays unanswered, the learner's text stays in the box, and "Try again" is offered. There is no default verdict. (Mutation-tested.)
- [x] `ambiguous` asks the learner to say more and records nothing.
- [x] Recorded results use `eval_method = 'ai'` with the model, prompt version and the structured feedback in the evidence metadata. A card edited while its answer was being judged discards the result (`409 card_changed`). Double and simultaneous submits record one response.
- [x] The AI call runs outside any database transaction. Daily limits (per user 60, global 300, configurable; failed attempts count) are enforced from an `ai_evaluations` ledger under an advisory lock.
- [x] Written cards can be made by hand (mode, model answer, criteria) or generated with a style (Explain, Connections, Apply). Every generated card still needs a verbatim source quote and is a draft until approved.
- [x] The model answer is never sent before an answer is submitted. Confidence is stored but never sent to the evaluator.
- [x] Progress covers written cards; 30-day evidence shows AI-judged answers separately.

Not verified: how good the judgements are with a real model. Everything above is tested against stub providers; no live AI key was available. Groq's data terms are still unchecked (see `AI_PROVIDER.md`).

Not done at that point: Hybrid mode, a visual design pass, dark mode, profile image, notifications, real sign-in. (Batch 8 below adds sign-in, card editing, read-through, one-step deck making and a design pass.)

## Batch 6c acceptance criteria (done): Hybrid mode

- [x] Hybrid runs a fixed sequence, once: Recall, then Explain, then Connections, then Apply (retrieve it, explain it, relate it, use it). Cards are chosen from the deck by the same rules as the single modes; a phase with no cards is skipped; each phase is capped at a quarter of the session so one cannot crowd out the rest.
- [x] The learner sees the sequence and where they are (`phases` in the session detail, a banner on the study screen). Modes never switch unexpectedly: the order is fixed and shown.
- [x] Written phases use the same AI evaluation, failure rules and limits as the single modes. Hybrid needs an AI key (503 otherwise).
- [x] Limitation, stated plainly: Hybrid does not link cards by concept (the data has no concept model), so the sequence is by kind of activity, not "the same idea through four lenses".

## Batch 7 acceptance criteria (done): hardening and release readiness

- [x] Every route needs authentication; every id route gives another user 404 and leaves the owner's data unchanged; a guard fails if a route is added without joining the sweeps.
- [x] Input and API security checks (bad ids, injection-like and HTML text, malformed/oversize/wrong-typed bodies, garbage PDFs, error leakage, headers, CORS). Request bodies now reject unknown fields; API responses send protective headers.
- [x] 17 database integrity rules, each proven to detect its own breakage, runnable on real data with `npm run check:db`.
- [x] Performance at 6,000 cards / 40,000 answers with timings, a query-count guard and index-use checks.
- [x] Failure and recovery: database outage and return, a failure halfway through recording an answer (recall and AI-judged), restart mid-session, stuck jobs, provider outage.
- [x] Configuration documented and checked; setup docs in `README.md`; findings, limits and release blockers in `docs/HARDENING.md`.
- [x] The complete learning journey is covered by five browser walk-throughs.

**Release verdict: not ready for real users** (development-stub sign-in, no live-AI validation, two moderate dependency advisories). See `docs/HARDENING.md`.

## Next

Real authentication (replace the dev stub), a live-AI tuning pass, the React Router 7 upgrade, then a visual design pass.

## Batch 8: sign-in, editing, simpler flow, design (done)

- [x] Real accounts: register, sign in/out, change password, sign out everywhere, delete account (migration 0006). 
- [x] Edit approved cards of every type (study mode of written cards too) from the Library and Review.
- [x] Library tabs: Cards & decks, To review (n), Read through (browse without being tested).
- [x] One-step **Make a deck** (source + AI cards + deck); optional **Skip review** (off by default); automatic deck per source on approve.
- [x] Study mode collapsed under the deck's Start button (Recall by default).
- [x] Generation prompt tightened (standalone questions, no "according to the passage", no duplicates, better distractors). **Not validated against a real model.**
- [x] Visual pass with light and dark themes.

Also: long sources are read in up to 4 evenly spaced parts (each under the 12,000-character limit), so very long documents are sampled, not read in full; Settings has "Download my data" (JSON export); page titles.

Still open: live-AI validation and prompt tuning, screen-reader audit, email verification/password reset, shared login-rate-limit store, per-deck study settings, react-router advisories.
