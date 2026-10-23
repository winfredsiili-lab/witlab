# WitLab

Source-grounded learning app: turn learning material into editable flashcards, study with active recall, and review on an evidence-based schedule. See `docs/BUILD_PLAN.md` for the build order, `docs/PROJECT.md` for the full specification, `docs/DATA_MODEL.md` for the schema and `docs/API_CONTRACTS.md` for the endpoints.

Current state: **Batches 1 to 7 complete**: all five study modes (Recall, Explain, Connections, Apply, Hybrid) work, and the hardening checks pass. **Not ready for real users**: sign-in is still a development stub, and the AI judging has only been tested against stand-in providers, not a real model. See `docs/HARDENING.md`. You can paste text or upload a PDF, pick the part to read, generate draft cards with AI, review them (edit, approve or reject, one or many, straight into a deck) and study the approved cards. Screens are functional but not yet designed. Also read `docs/LEARNING_ENGINE.md` for how answers are evaluated and scheduled.

## Try it (after Setup and Run below)

Open http://localhost:5173, then:

1. **Library**: create a deck.
2. In the deck, **create cards** (term/definition, short answer, multiple choice, or number).
3. **Start studying.** Answer each card, read the feedback, continue. Incorrect answers come back in about 10 minutes; correct ones return after 1 day, then 6, then longer.
4. **Home** shows how many cards are due for review.

### Making cards from a source

1. **Library > Make a deck from a source** (or Home > Make a deck): paste text, or upload a PDF (up to 15 MB and 300 pages, with selectable text; scanned PDFs are rejected with an explanation because OCR is not supported).
2. On the source page choose what to read (whole source, a section, or a page/character range; at most 12,000 characters per request) and press **Generate cards**. This needs an AI key (see below); without one the button reports that generation is not set up.
3. Generated cards are **drafts**, each with the passage it came from. Open **Library > To review** to check them against the quote, edit, and approve or reject one or many. By default approved cards go into a deck named after their source (created if needed), so they can always be studied. On the **Make a deck** page you can tick **Skip review** to put the AI cards straight into the deck: they stay marked as AI-made, and the default is to review.
4. **Library > Read through** lets you read approved cards (search, filter by deck, reveal answers, card by card) without being tested; nothing is recorded.
5. Any card can be edited from the Library (all types). Changing the question, answer, choices or criteria makes a new version; your history and schedule are kept.

### AI setup (optional)

Without it, Recall, manual cards and everything else works; card generation and the Explain, Connections and Apply study modes need it. The default is Groq's free tier (see `docs/AI_PROVIDER.md` for the decision, the limits, and what is not yet verified).

```powershell
# 1. Create a key at https://console.groq.com/keys, then add it to apps\api\.env
notepad apps\api\.env      # add the line: AI_API_KEY=your-key
# 2. Restart the API (npm run dev:api)
```

Other AI settings are in `.env.example`. The key stays on the server and is never sent to the browser.

Term/definition cards are graded by you (the app cannot reliably judge free wording without AI); the other types are checked automatically. Written-answer (open-ended) cards are studied in Explain, Connections or Apply and judged by AI against a model answer, criteria and the source passage: if the AI is unavailable nothing is recorded and you can retry. Hybrid runs the four modes in a fixed order (Recall, Explain, Connections, Apply).

## Prerequisites

- Node.js 20 or newer (the PDF reader, pdfjs-dist 4.10.x, supports Node 20)
- **PostgreSQL 15 or newer** running locally

## Setup (Windows PowerShell)

```powershell
# 1. Create two databases (once): one for development, one for tests. Adjust the user if yours differs.
psql -U postgres -c "CREATE DATABASE witlab;"
psql -U postgres -c "CREATE DATABASE witlab_test;"

# 2. Install dependencies for all workspaces
npm install

# 3. Create your local environment file; put your real password in DATABASE_URL and TEST_DATABASE_URL
Copy-Item .env.example apps\api\.env
notepad apps\api\.env

# 4. Build the shared contracts package (the API and web app import it)
npm run build --workspace @witlab/contracts

# 5. Create the tables
npm run migrate
```

`npm run migrate` applies any new files in `apps/api/src/db/migrations` in order and records them in `schema_migrations`. It is safe to run repeatedly.

## Run

Open two PowerShell windows in the project root.

```powershell
# Window 1: API on http://localhost:4000 (needs the migration above)
npm run dev:api

# Window 2: web app on http://localhost:5173
npm run dev:web
```

**Sign-in:** open the app and choose *Create an account* (email + password, at least 10 characters). If you used an earlier version, register with the same email as the old development account (`DEV_USER_EMAIL`, default `dev@witlab.local`) to keep its data. For quick local work without sign-in set `AUTH_MODE=dev-stub` in `.env` (development only; refused in production). Browser test scripts need `AUTH_MODE=dev-stub`, except `e2e:auth`.

Try the API with the PowerShell examples at the bottom of `docs/API_CONTRACTS.md`, or check health:

```powershell
Invoke-RestMethod http://localhost:4000/api/health
```

## Testing

```powershell
npm test            # everything, including integration tests against the real PostgreSQL test database
npm run test:unit   # only tests that need no database
npm run typecheck   # contracts, API and web
npm run build       # production builds
npm run check:db    # database integrity checks against your development database (read-only)
```

### End-to-end walk-through (manual, real browser)

`npm run e2e` drives the real app in a browser: create a deck and four cards, study them, check feedback and scheduling, review, and phone-width layout (25 checks, screenshots saved to `tests/e2e/screenshots`). It is a smoke test, not part of `npm test`.

```powershell
# One-time: a third database that the script is allowed to EMPTY (its name must end in _e2e)
psql -U postgres -c "CREATE DATABASE witlab_e2e;"

# Window 1: API pointed at the e2e database
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/witlab_e2e"
npm run migrate
npm run dev:api

# Window 2: web app
npm run dev:web

# Window 3: run the walk-through (needs Chrome installed; or set E2E_CHROME_PATH to a Chromium/Edge executable)
$env:E2E_DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/witlab_e2e"
npm run e2e
```

The script refuses to run against any database whose name does not end in `_e2e`.

A second walk-through covers Batch 4 (paste, PDF, scope, generation, approval, failures). It starts its own **stub** of the AI provider, so it proves the app's wiring, not the real provider. Start the API with the stub's address, then run it:

```powershell
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/witlab_e2e"
$env:AI_API_KEY = "e2e-key"
$env:AI_BASE_URL = "http://127.0.0.1:4999/v1"
npm run dev:api
# in another window (with E2E_DATABASE_URL set as above):
npm run e2e:sources   # paste, PDF, scope, generation, failures
npm run e2e:review    # review queue, edit, approve into a deck, study
npm run e2e:learner   # dashboard, settings, mode picker, resume, progress evidence, phone layout (no AI needed)
npm run e2e:written   # AI-judged written answers: failure keeps your text and records nothing, clarification, partial/correct, usage (stub AI)
npm run e2e:auth      # real sign-in, sign-out, password change, account deletion (AUTH_MODE=password)
npm run e2e:editing   # edit approved cards of every type (AUTH_MODE=dev-stub)
npm run e2e:makedeck  # one-step Make a deck, automatic deck, read-through (needs the AI stub env)
npm run e2e:library   # approved cards in no deck: find, read, add to a deck, study (no AI needed)
```

### Release checks (Batch 7)

`npm test` includes `apps/api/src/hardening/`: security and ownership sweeps over every route, database integrity rules (also runnable on a real database with `npm run check:db`), performance at 6,000 cards and 40,000 answers, failure and recovery, and configuration checks. See `docs/HARDENING.md` for what each proves, what it does not, and the release blockers that remain (most importantly: sign-in is still a development stub).

### Notes on the tests

Integration tests use `TEST_DATABASE_URL`, migrate it automatically, and refuse to run unless the database name ends in `_test`. Each test creates its own users, so tests never wipe data and can run in parallel. If `TEST_DATABASE_URL` is missing, integration tests fail with a clear message instead of silently skipping.

## Layout

- `apps/api` Express + TypeScript backend. Each domain under `src/modules/<name>` has `routes`, `service` and `repository` files.
- `apps/web` React + Vite frontend
- `packages/contracts` request/response schemas shared by both (Zod)
- `docs` specification and plans
