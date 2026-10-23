# API Contracts (Batches 2 to 6b)

Source of truth for request/response shapes: `packages/contracts/src/*.ts` (Zod schemas). This document is the human-readable summary.

All paths are under `/api`. All bodies are JSON. Every endpoint except `/api/health` requires an authenticated user (dev-stub in development; see `DATA_MODEL.md` section 6). Missing authentication returns `401`.

## Conventions

- Ids are UUIDs. A malformed id returns `400 validation_error`.
- Timestamps are ISO 8601 strings.
- **Ownership:** a record that does not exist and a record owned by someone else are indistinguishable: both return `404 not_found`. A user id in a request body is ignored.
- List endpoints accept `?limit=` (1 to 200, default 50) and `?offset=` and return `{ "items": [...], "total": n }`.
- Errors always have this shape:

```json
{ "error": { "code": "validation_error", "message": "Invalid request. ...", "issues": [{ "path": "title", "message": "..." }] } }
```

| status | code | meaning |
|---|---|---|
| 400 | `validation_error` | body, query or id failed validation (`issues` lists each problem) |
| 400 | `invalid_json` | body is not valid JSON |
| 400 | `unknown_source` | a `sourceRefs` entry points at a source that does not exist or is not yours |
| 400 | `provenance_required` | AI-generated card without a source reference (service layer) |
| 400 | `invalid_order` | reorder list does not match the deck's cards exactly |
| 400 | `invalid_answer` | the answer cannot be interpreted for this card (for example text that is not a number, or a missing self-grade). Nothing is recorded, so the learner can retry |
| 401 | `unauthorized` | not authenticated |
| 404 | `not_found` | does not exist, or is not yours |
| 409 | `invalid_state` | wrong card state for this action (for example approving a non-draft) |
| 409 | `card_not_approved` | only approved cards can be added to a deck |
| 409 | `already_in_deck` | the card is already in this deck |
| 409 | `nothing_to_study` | no card is due or new for this deck (or, for a global review, nothing is due). The message says when the next review is due |
| 409 | `session_not_active` | the study session has ended or completed and takes no more answers |
| 409 | `already_answered` | this card was already answered in this session |
| 409 | `constraint_violation` | a database integrity rule stopped the request (should not normally be reachable) |
| 400 | `invalid_scope` | the chosen section, pages or characters do not exist or do not fit this kind of source |
| 400 | `scope_empty` | the selection has less than 40 characters of text |
| 400 | `scope_too_large` | the selection is over 12,000 characters. Nothing is cut; choose less |
| 409 | `source_not_ready` | the source failed to import, so nothing can be made from it |
| 409 | `generation_in_progress` | you already have a generation running |
| 415 | `unsupported_media_type` | PDF upload without `Content-Type: application/pdf` |
| 429 | `generation_limit_reached` | your daily generation limit is used (default 20 per rolling 24 hours) |
| 429 | `generation_capacity_reached` | the shared daily allowance for all users is used (default 500) |
| 429 | `ai_rate_limited` | the AI provider is rate limiting the server; the message says how long to wait when the provider says |
| 502 | `ai_unavailable`, `ai_auth`, `ai_bad_response`, `ai_truncated` | the AI provider failed, rejected the server's key, answered unusably, or was cut off |
| 503 | `ai_not_configured` | no `AI_API_KEY` on the server. Everything else works |
| 504 | `ai_timeout` | the AI provider did not answer in time |
| 413 | `payload_too_large` | JSON body over 2 MB, or a PDF over 15 MB |

## Health

`GET /api/health` returns `200` with `status: "ok"`, or `503` with `status: "degraded"` and the database error.

## Sources

| method and path | purpose |
|---|---|
| `POST /api/sources` | create from pasted text. Body `{ title, sourceType: "text", contentText }`. Returns `201` and the source with its text. Markdown headings (and, for long text, automatic parts) become sections |
| `POST /api/sources/pdf?title=&filename=` | import a PDF. The **body is the raw file** with `Content-Type: application/pdf` (max 15 MB, 300 pages). Returns `201 { source, warnings[] }`. If the file cannot be read (scanned/image-only, password protected, damaged, not a PDF) the response is still `201` but `source.status` is `"failed"` and `source.errorMessage` explains why; the failed source is kept so it can be seen and deleted. `warnings` lists things like pages without text. `title` defaults to the file name |
| `GET /api/sources` | list summaries (no text; `contentLength` instead; PDFs also have `pageCount`, `fileSize`) |
| `GET /api/sources/:id` | detail including `contentText` (null for PDFs) |
| `GET /api/sources/:id/sections` | `{ items: [{ id, position, kind, title, level, pageStart, pageEnd, charStart, charEnd, textLength }] }`. Empty when no structure was found |
| `GET /api/sources/:id/pages` | PDF: `{ items: [{ pageNumber, charLength }] }` |
| `GET /api/sources/:id/pages/:n` | PDF: `{ pageNumber, content }` |
| `POST /api/sources/:id/generate` | make DRAFT cards. See "Generation" below |
| `GET /api/sources/:id/generations` | `{ items: [job] }`, newest first (last 20) |
| `PATCH /api/sources/:id` | rename. Body `{ title }` |
| `DELETE /api/sources/:id` | delete. Cards made from it survive and keep their provenance excerpt. `204` |

### Generation

`POST /api/sources/:id/generate` body (all optional):

```json
{ "scope": { "type": "all" } , "maxCards": 6, "style": "recall" }
```

`style` is `recall` (default), `explain`, `connections` or `apply`. The last three draft written-answer (`open_ended`) cards with a model answer and 1 to 10 criteria, with that `learningMode`; a card with no criteria, or of the wrong kind for the style, is dropped like any other bad candidate.

`scope` is one of `{ "type": "all" }`, `{ "type": "section", "sectionId" }`, `{ "type": "pages", "pageStart", "pageEnd" }` (PDF only) or `{ "type": "chars", "charStart", "charEnd" }` (text only, `charEnd` exclusive). `maxCards` is 1 to 12 (default 6). The selection may hold at most 12,000 characters.

Returns `201 { job, cards }`. `cards` are **drafts** (`status: "draft"`, `origin: "ai_generated"`), each with one `sourceRefs` entry whose `excerpt` and position are copied from the source (never from the AI's claim) and, for PDFs, the page. `job` reports `candidatesReturned`, `draftsCreated` and `discarded: [{ prompt, reason }]`. Zero drafts is a valid, honestly reported outcome.

What is dropped, with the reason shown to the learner: a card whose supporting quote does not appear verbatim in the selected text, an incomplete or malformed card, a card failing the per-type card rules, a duplicate of a question this source already has (rejected cards do not count), and any beyond `maxCards`.

If the AI call fails, no cards are created, the source is untouched, and the attempt is recorded as a `failed` job. Drafts do nothing until approved with `POST /api/cards/:id/approve`.

## Cards

Cards of type `open_ended` have `learningMode` (`explain` default, `connections`, `apply`) and a `rubric` of `{ criteria: string[] }`; other types have `learningMode: null` and sending one is `400`. `GET /api/me` `aiUsage` also reports `evaluationsUsedToday` and `evaluationDailyLimit`.

| method and path | purpose |
|---|---|
| `POST /api/cards` | create a **manual** card; it is approved immediately. Body `{ cardType, prompt, answer, explanation?, answerSpec?, rubric?, sourceRefs? }` |
| `GET /api/cards?status=draft\|approved\|rejected&origin=manual\|ai_generated&sourceId=` | list; filters combine. `sourceId` keeps only cards that quote that source |
| `GET /api/cards/:id` | detail with `sourceRefs` (provenance) |
| `PATCH /api/cards/:id` | edit `prompt`, `answer`, `explanation`, `answerSpec`, `rubric`. Status, type, revision and owner cannot be set. Rejected cards cannot be edited |
| `POST /api/cards/:id/approve` | draft to approved. Optional body `{ deckId }` also adds the card to that deck in the same transaction; if the deck is not yours (404) the card stays a draft |
| `POST /api/cards/:id/reject` | draft to rejected |
| `POST /api/cards/bulk` | body `{ action: "approve" \| "reject", cardIds: [1..100 distinct], deckId? }` (`deckId` only with approve). **All-or-nothing**: if any card is missing, not yours (404) or not a draft (409 `invalid_state`), nothing changes. Returns `{ action, cards, addedToDeckId }`; with a deck, cards are appended in the order given |
| `DELETE /api/cards/:id` | delete the card, its deck memberships and provenance. `204` |

`cardType` is one of `term_definition`, `short_answer`, `multiple_choice`, `numeric`, `open_ended`. See `DATA_MODEL.md` for the `answerSpec` shape of each.

`sourceRefs[]`: `{ sourceId, excerpt, pageStart?, pageEnd?, charStart?, charEnd? }`.

## Decks

| method and path | purpose |
|---|---|
| `POST /api/decks` | create. Body `{ title, description? }`. Returns `201` and the deck detail |
| `GET /api/decks` | list summaries with `cardCount` |
| `GET /api/decks/:id` | detail with its cards in order |
| `PATCH /api/decks/:id` | edit `title` and/or `description` (`null` clears it) |
| `DELETE /api/decks/:id` | delete the deck only; its cards stay. `204` |
| `POST /api/decks/:id/cards` | add an approved card. Body `{ cardId }`. Appended at the end. Returns `201` and the deck detail |
| `DELETE /api/decks/:id/cards/:cardId` | remove a card from the deck (the card is kept). Returns the deck detail |
| `PUT /api/decks/:id/cards/order` | set the order. Body `{ cardIds }` must list every card in the deck exactly once |

## Profile, preferences and progress

| method and path | purpose |
|---|---|
| `GET /api/me` | `{ id, email, displayName, preferences: { sessionSize, askConfidence }, aiUsage: { configured, usedToday, dailyLimit } }` |
| `PATCH /api/me` | any of `displayName` (1 to 60 chars, or `null` to clear), `sessionSize` (integer 5 to 50, default 20), `askConfidence` (boolean, default true). Unknown fields are rejected. Returns the updated profile |
| `GET /api/progress?deckId=` | learning evidence for one deck or everything. See below |

`sessionSize` is the default length of a study session when the start request has no `limit`; an explicit `limit` wins. `askConfidence` only controls whether the study screen shows the optional confidence rating; the server stores confidence whenever it is sent and never uses it for verdicts or scheduling.

**Progress** counts approved, Recall-checkable cards that are in a deck (or, for the overall view, already practised). Each card is in exactly one state, from its review state:

| state | meaning |
|---|---|
| `never` | in a deck, never answered |
| `struggling` | the latest answer was partly right or wrong |
| `learning` | the latest answer was right, but not (3+ right reviews in a row **and** a scheduled gap of 14+ days) |
| `established` | 3+ right reviews in a row and a scheduled gap of 14+ days. Consistent recall so far; not proof of long-term retention |

The response also has `activity` (the last 14 UTC days, oldest first, zeros included), `last30Days` (counts of right, partly right and wrong answers, how many were `selfAssessed` versus `automatic`, and distinct cards practised), `needsAttention` (up to 10 cards whose latest answer was not right) and, for the overall view, a per-deck breakdown. There is deliberately **no score or percentage**.

## Study

Behaviour is specified in `LEARNING_ENGINE.md`. Modes: `recall`, `explain`, `connections`, `apply`. The last three study written-answer cards and answer `503 ai_not_configured` without an AI key. `hybrid` is rejected with `400`.

| method and path | purpose |
|---|---|
| `GET /api/study/overview?deckId=&mode=` (mode default `recall`) | `{ dueCount, newCount, eligibleCount, nextDueAt }` for a deck, or across everything practised when `deckId` is omitted (then `newCount` is 0) |
| `POST /api/study/sessions` | start a session. Body `{ deckId?, mode?: "recall" | "explain" | "connections" | "apply", limit?: 1..50 }` (default: your `sessionSize` preference, 20 unless changed). Queue: due cards (most overdue first), then new cards in deck order; without a deck, due cards only. `201` with the session detail, or `409 nothing_to_study` |
| `GET /api/study/sessions?status=&deckId=&limit=` | list session summaries (use `status=active` to find one to resume) |
| `GET /api/study/sessions/:id` | session detail |
| `POST /api/study/sessions/:id/responses` | answer the current card. Returns `201` with the verdict, feedback, correct answer (the model answer for written cards), explanation, the next review time and the updated session (including the next card). For written cards the AI may instead return `200 { needsClarification: true, feedback }` (nothing recorded). AI failures return the error with nothing recorded: `429 ai_rate_limited`, `504 ai_timeout`, `502 ai_unavailable | ai_auth | ai_truncated | ai_bad_response`; limits: `429 evaluation_limit_reached | evaluation_capacity_reached`; edited mid-judgement: `409 card_changed` |
| `POST /api/study/sessions/:id/end` | end early: `completed` if everything was answered, otherwise `abandoned`. Safe to repeat |

**Session detail**: `{ id, mode, status, deckId, deckTitle, startedAt, endedAt, progress: { total, answered, correct, partial, incorrect }, current, results }`. `current` is the next unanswered card or `null`:
`{ cardId, position, cardType, prompt, choices, evaluation: "auto" | "self" | "ai", reason, revealAnswer }`. The correct answer, accepted answers and correct choice index are **never** sent for automatically evaluated cards; `revealAnswer` is set only for self-assessed cards. `results` lists answered cards with their verdict, feedback, your answer and the correct answer.

**Answer body**: `{ cardId, answer?, selectedIndex?, selfGrade?, confidence? }` (no other fields are accepted). What is allowed depends on the card type:

| card type | send |
|---|---|
| `multiple_choice` | `selectedIndex` (omit for "I don't know") |
| `numeric` | `answer` as a plain number (omit or blank for "I don't know"; text that is not a number is `400 invalid_answer`) |
| `short_answer` | `answer` (blank for "I don't know") |
| `term_definition` | `selfGrade`: `correct`, `partial` or `incorrect` (required); `answer` optional |
| `open_ended` | `answer` (non-empty text, up to 4000 characters); judged by AI. `selectedIndex` and `selfGrade` are `400` |

`confidence` (1 to 5) is optional and is stored as evidence only. The server decides correctness; a client cannot send a verdict for an automatically evaluated card.

## PowerShell examples

### Sign-in (`/api/auth`)

Cookie `witlab_session` (HttpOnly, SameSite=Lax, Secure in production). Writes whose `Origin` header names another site get `403 bad_origin`.

| Method and path | Auth | Notes |
|---|---|---|
| `POST /auth/register` | no | `{email, password, displayName?}` -> 201 `{user}` + cookie. `409 email_in_use`, `400 weak_password`, `403 registration_closed` |
| `POST /auth/login` | no | `{email, password}` -> `{user}` + cookie. Same `401 invalid_credentials` for unknown email and wrong password; `429 too_many_attempts` after 5 failures / 15 min |
| `POST /auth/logout` | no | 204; ends the server session |
| `GET /auth/session` | yes | `{user}` |
| `POST /auth/password` | yes | `{currentPassword,newPassword}` -> 204; signs out all other devices |
| `POST /auth/logout-all` | yes | 204 |
| `POST /auth/delete-account` | yes | `{password}` -> 204; deletes the account and all its data |

`PATCH /cards/:id` also accepts `learningMode` (written-answer cards only; counts as a content change and bumps the revision).

With `AUTH_MODE=dev-stub` (development only) every request acts as the seeded dev user.

```powershell
$api = "http://localhost:4000/api"
$json = @{ title = "Cloud notes"; sourceType = "text"; contentText = "Availability zones are isolated locations." } | ConvertTo-Json
$source = Invoke-RestMethod -Method Post -Uri "$api/sources" -ContentType "application/json" -Body $json

$card = @{
  cardType = "term_definition"
  prompt   = "What is an availability zone?"
  answer   = "An isolated location within a region."
  sourceRefs = @(@{ sourceId = $source.id; excerpt = "Availability zones are isolated locations." })
} | ConvertTo-Json -Depth 5
$card = Invoke-RestMethod -Method Post -Uri "$api/cards" -ContentType "application/json" -Body $card

$deck = Invoke-RestMethod -Method Post -Uri "$api/decks" -ContentType "application/json" -Body (@{ title = "Cloud basics" } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$api/decks/$($deck.id)/cards" -ContentType "application/json" -Body (@{ cardId = $card.id } | ConvertTo-Json)

# Import a PDF (raw body) and make draft cards (needs AI_API_KEY on the server)
$pdf = Invoke-RestMethod -Method Post -Uri "$api/sources/pdf?filename=notes.pdf" -ContentType "application/pdf" -InFile ".\notes.pdf"
$pdf.source.status
Invoke-RestMethod "$api/sources/$($pdf.source.id)/sections"
$gen = Invoke-RestMethod -Method Post -Uri "$api/sources/$($pdf.source.id)/generate" -ContentType "application/json" -Body (@{ scope = @{ type = "pages"; pageStart = 1; pageEnd = 2 }; maxCards = 4 } | ConvertTo-Json -Depth 4)
$gen.job; $gen.cards | Select-Object status, prompt, answer
Invoke-RestMethod -Method Post -Uri "$api/cards/$($gen.cards[0].id)/approve"

# Study the deck (a term_definition card is graded by you)
$session = Invoke-RestMethod -Method Post -Uri "$api/study/sessions" -ContentType "application/json" -Body (@{ deckId = $deck.id } | ConvertTo-Json)
$session.current
$answer = @{ cardId = $session.current.cardId; selfGrade = "correct"; confidence = 4 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/study/sessions/$($session.id)/responses" -ContentType "application/json" -Body $answer
```
