# WitLab Learning Engine

Status: **Batch 3 design, implemented.** Covers what exists now (Recall mode, deterministic and self-assessed evaluation, a transparent scheduler). AI-assisted evaluation and the other modes are specified only as extension points.

The engine has three independent parts. None of them knows about the others' internals, and none depends on the UI or on AI:

1. **Evaluator** (`modules/evaluation`): pure function. Card + submission in, verdict + feedback out.
2. **Scheduler** (`modules/scheduling`): pure function. Previous review state + verdict + current time in, next review state out.
3. **Study service** (`modules/study`): sessions, queue building, and one transaction that records the response and updates the schedule.

## 1. Three concepts that stay separate

| concept | what it is | where it lives |
|---|---|---|
| **Card type** | the form of the task (`term_definition`, `short_answer`, `multiple_choice`, `numeric`, `open_ended`) | `cards.card_type` |
| **Study mode** | the kind of learning activity in a session (Recall now; Connections, Explain, Apply, Hybrid later) | `study_sessions.mode` |
| **Review schedule** | when a card should come back | `card_review_state` |

The mode is fixed for the whole session and never switches on its own.

## 2. Recall mode: which cards can be studied

A card is eligible only if it is **approved** (enforced in the query, not just the UI) and its type can be evaluated honestly without AI:

| card type | evaluation | how the learner answers |
|---|---|---|
| `multiple_choice` | deterministic | picks a choice |
| `numeric` | deterministic | types a number |
| `short_answer` | deterministic | types a short answer |
| `term_definition` | **self-assessed** | types or recalls an answer, reveals the model answer, grades themselves |
| `open_ended` | AI (Explain, Connections, Apply modes) | **not studied in Recall**; see section 10 |

Why term definitions are self-assessed: a definition can be worded many ways, so matching text would wrongly mark correct paraphrases as wrong. Until AI evaluation exists, the honest options are exact matching (unreliable) or asking the learner. Self-assessed responses are stored with `eval_method = 'self_assessed'` so progress can treat them as weaker evidence than deterministic ones.

## 3. Evaluation rules (deterministic)

**Verdicts.** The schema allows `correct`, `partial`, `incorrect`, `ambiguous`, `not_evaluated`. This batch produces `correct` and `incorrect` from deterministic evaluation, and `correct`, `partial`, `incorrect` from self-assessment. `ambiguous` and `not_evaluated` are reserved for AI evaluation. A `not_evaluated` response never changes the schedule and never counts as evidence.

**multiple_choice.** Correct if `selectedIndex === correctIndex`. The correct index is never sent to the client before answering.

**numeric.** The input must look like a number (digits, optional sign, optional decimal point, optional exponent). Commas are rejected because `1,000` is ambiguous across locales. Correct if `|submitted - value| <= tolerance` (tiny relative epsilon for floating point). Text that is not a number is a **400 error, not a wrong answer**, so a typo does not cost the learner a lapse and nothing is recorded.

**short_answer.** Both sides are normalised: Unicode NFKC, lower-case, curly quotes straightened, leading and trailing punctuation and spaces removed, internal whitespace collapsed. Correct if the result equals the normalised canonical `answer` or any normalised entry of `answerSpec.acceptedAnswers`. Accents are **not** stripped (they can change meaning). The card author controls leniency by listing accepted variants. The feedback shows the accepted answers.

**No answer given** (blank text, or no choice selected) on an automatic card is recorded as `incorrect` ("I don't know" is a legitimate answer in active recall) and the feedback says no answer was given.

**Self-assessed.** The client must send `selfGrade` (`correct`, `partial`, `incorrect`). Sending `selfGrade` on an automatic card, or a `selectedIndex` on a non-choice card, is a 400. The model answer is included with the card so the learner can compare; self-assessment is an honour system by design.

**Feedback** always states what happened and shows the correct answer, plus the card's `explanation` when it has one.

## 4. Confidence is evidence, not correctness

The learner may give a confidence rating from 1 to 5 (optional, asked **before** feedback is shown). It is stored on the response. It is **not an input** to the evaluator or the scheduler, so a confident wrong answer and an unsure correct answer are scheduled purely by correctness. Later, progress views can use the stored confidence to show calibration (for example, "high confidence, wrong").

## 5. Scheduler

A small SM-2-style algorithm. Deterministic: the same state, verdict and timestamp always give the same result. The current time is passed in, never read inside the function.

State per user and card: `dueAt`, `intervalDays`, `ease` (starts 2.5, minimum 1.3), `repetitions` (consecutive successful reviews), `lapses`, `lastReviewedAt`, `lastVerdict`. **A card with no state has never been practised.**

| verdict | repetitions | interval | ease | lapses | due |
|---|---|---|---|---|---|
| `correct` | +1 | 1st success: 1 day. 2nd: 6 days. After that: `max(previous + 1, round(previous * ease))` | unchanged | unchanged | now + interval |
| `partial` | unchanged | `max(1, round(previous * 0.5))` | -0.15 | unchanged | now + interval |
| `incorrect` | reset to 0 | 0 | -0.20 | +1 only if the card had been answered correctly before (repetitions > 0) | **now + 10 minutes** |

Intervals are whole days measured in UTC milliseconds (no daylight-saving drift). Ease never drops below 1.3.

`explainDue` turns a state into a plain-language reason, for example "Answered incorrectly 2 days ago; due for another try" or "Last answered correctly 6 days ago; the 6-day interval has passed". The reason shown for each card is stored on the session item when the session is created.

One correct answer is **not** treated as long-term retention: a card only reaches multi-week intervals after several consecutive successes.

## 6. Study sessions

**Starting.** `POST /api/study/sessions` with an optional `deckId`.
- With a deck: the queue is the deck's eligible cards that are **due** (most overdue first), then **new** (never practised) cards in deck order, up to `limit` (default 20, max 50).
- Without a deck (global review): only cards that are due, across everything the learner has practised.
- If nothing qualifies, the API answers `409 nothing_to_study` and says when the next card is due.

**Snapshot.** The queue is stored as `study_session_items` when the session starts. The session is therefore stable and resumable (`GET /api/study/sessions?status=active`), and each card appears **once** per session. A card answered incorrectly is due again in 10 minutes and shows up in a later session, not repeated in this one.

**Answering** is a single database transaction: lock the session, check it is active and the card belongs to it and has not been answered, evaluate on the server using the card's current content, insert the response (recording the card `revision` answered), update the review state, and complete the session if that was the last card. A double submit gets `409 already_answered`. The server never trusts the client for correctness.

**Ending.** The session completes automatically after the last card. `POST /api/study/sessions/:id/end` ends it early (`abandoned` when cards remain unanswered). Ended sessions cannot take answers (`409 session_not_active`).

**What the client may know before answering.** The prompt, the card type, and (multiple choice only) the list of choices. The correct answer, accepted answers, and correct index are withheld; the model answer is sent only for self-assessed cards, where seeing it is the point.

## 7. Evidence recorded

Each response stores: the submitted answer, the verdict, the evaluation method, the feedback shown, the confidence (if given), the card revision, the time, and evaluator metadata (for example the numeric value parsed and the tolerance used). The `study_responses` table is the evidence log. Progress views (Batch 6) will be computed from it. They must distinguish: never practised (no review state), practised but last answer incorrect, answered correctly, and consistently recalled over time (several consecutive successes with a multi-day interval).

## 8. Deleting cards

Deleting a card deletes its review state, session items and responses with it (database cascade). The UI must ask for confirmation before deleting a practised card. Deleting a deck keeps its cards and its study history (sessions keep a `NULL` deck).

## 9. Extension points (not built)

- **Hybrid:** a planned sequence of the other modes. It reuses sessions, responses and the scheduler unchanged.
- AI evaluation of paraphrased short answers.
- **Weighting self-assessed evidence** differently from deterministic evidence in progress views.


## Progress states (Batch 6a)

Progress is derived from review state and the response log, never stored or estimated. A studyable card is in exactly one state: **never practised**, **needs work** (latest answer partly right or wrong), **learning** (latest right, but not yet established) or **holding up** (3+ right reviews in a row and a scheduled gap of 14+ days, shown to the learner as consistent so far, not proof of retention). The thresholds live in `progress.repository.ts` and are pinned by tests that insert review states directly. Self-assessed answers are counted separately because they are weaker evidence than automatic checks. No overall score is shown, and small samples are labelled as such.

## 10. Written-answer modes (Batch 6b)

**Which cards.** `open_ended` cards carry a `learning_mode` (`explain`, `connections` or `apply`; a database check ties the mode to the card type). A session in one of those modes queues only approved open-ended cards of that mode; Recall queues every other type. A card is therefore in exactly one mode's queue. The schedule (`card_review_state`) is per card and shared as before.

**Flow of one answer** (`POST /api/study/sessions/:id/responses` with `{ cardId, answer }`):
1. Cheap checks with no locks: session active, card in the session, not already answered, non-empty answer. These never spend AI quota.
2. Reserve an attempt in `ai_evaluations` (advisory lock, per-user and global daily limits, `429 evaluation_limit_reached` / `evaluation_capacity_reached`).
3. Call the AI **outside any database transaction**.
4. If the call fails or the reply is unusable: mark the attempt `failed` and answer with the error. **Nothing else is written.** The card is unanswered; the learner retries.
5. If the verdict is `ambiguous`: answer `200 { needsClarification, feedback }` (the AI's question). Nothing is recorded.
6. Otherwise, in one transaction: lock the session, re-check it is active and the card unanswered, re-read the card and compare `revision` with the one that was judged (`409 card_changed` if it was edited), insert the response (`eval_method = 'ai'`, metadata: model, prompt version, mode, feedback parts), schedule with the same scheduler, mark the attempt `succeeded`, complete the session if it was the last card.

**Evidence and honesty.** The verdict comes only from the AI's validated reply; a failure never becomes `incorrect` or `correct`. The screen labels AI judgements as able to be wrong. Confidence is stored and never sent to the evaluator or used by the scheduler. The model answer is sent to the learner only in the result, never before. Progress counts AI-judged answers separately from automatic and self-graded ones.

**Not done.** Judgement quality against a real model is unverified (see `AI_PROVIDER.md`).
