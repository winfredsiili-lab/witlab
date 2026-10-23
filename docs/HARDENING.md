# Hardening and Release Readiness (Batch 7)

This page says what was checked, how to run it, what the results mean, and what is **not** ready. It is deliberately blunt: a check that passes proves only what it tests.

## Release verdict

**Not ready for real users.** The application works end to end and the checks below pass, but these blockers remain:

1. **Sign-in exists but has had no external review and runs on a single server.** Accounts use email + password (scrypt), server-side sessions in the database (only a hash of the token is stored), an HttpOnly SameSite=Lax cookie (Secure in production), an Origin check on writes, a generic login error, and an in-memory login throttle. Limits: the throttle resets on restart and is per process; there is no email verification, no password reset by email, no 2FA, and HTTPS must be provided by whatever hosts it (set `NODE_ENV=production`, `CORS_ORIGIN` to the site's exact origin, and `ALLOW_REGISTRATION=false` once your account exists). Set `AUTH_MODE=dev-stub` only for local development.
2. **AI judgement quality is unverified against a real model.** All AI paths are tested with stand-in providers. The evaluator prompt needs tuning with a real key, and Groq's data terms have not been checked (`docs/AI_PROVIDER.md`).
3. **No HTTPS or shared rate-limit store in the app itself.** These belong with deployment.
4. **No accessibility audit with a screen reader.** A visual pass (light and dark) is done; screens are keyboard-usable and checked at phone width, but not audited.

## What is checked, and how to run it

| area | where | run |
|---|---|---|
| Authentication on every route | `hardening/security.int.test.ts` | `npm test` |
| Ownership: another user gets 404 on every id route, and the owner's data is unchanged afterwards | same | `npm test` |
| A guard that fails if a new route is added without being added to those sweeps | same | `npm test` |
| Input handling: bad ids, SQL-like text, HTML/script text, malformed JSON, oversize bodies, unknown fields, wrong types, garbage PDFs | same | `npm test` |
| Responses: no stack traces or SQL in errors, protective headers, CORS, no secrets from `/api/me` | same | `npm test` |
| Database integrity: 17 rules the schema cannot express, each proven to detect its own breakage | `hardening/integrity.int.test.ts` | `npm test` |
| Same rules on your real data | `hardening/integrity.ts` | `npm run check:db` |
| Performance at 6,000 cards, 100 decks, 40,000 answers; no per-row queries; indexes used | `hardening/perf.int.test.ts` | `npm test` (prints timings) |
| Failure and recovery: database outage and return, a failure halfway through recording an answer, restart mid-session, stuck jobs, provider outage | `hardening/recovery.int.test.ts` | `npm test` |
| Configuration: every setting documented in `.env.example`, unsafe settings refused, no secrets in the example | `hardening/config.test.ts` | `npm test` |
| The whole learning journey in a real browser | `tests/e2e/*.mjs` | `npm run e2e`, `e2e:sources`, `e2e:review`, `e2e:learner`, `e2e:written` |

The integrity and performance tests run in a scratch database that they create and drop, so other tests cannot make them flap.

## Findings from this batch (all fixed)

- Several request bodies silently ignored unknown fields (including `userId`, `status`, `origin` on cards, and extra fields on decks and sources). They are now rejected with 400. The owner was never taken from the body, so this was not exploitable, but a quiet "ignored" is a bad habit for a security boundary.
- API responses had no protective headers. They now send `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- The test database accumulated AI-usage rows across runs, so the shared daily limits made later runs fail. The test setup now clears those ledgers (found while verifying Batch 6b).
- One performance run showed a 3.2 second first read of overall progress right after bulk-loading 40,000 rows, never reproduced in later runs (130 to 330 ms). The test now vacuums after seeding, as autovacuum would. If you see a slow first load on a freshly imported large database, that is the likely cause.

## Dependency audit (`npm audit --omit=dev`, run 2026-10-22)

Two moderate advisories, both in `react-router` 6.x (an open redirect through backslashes in `<Link>`/`navigate`, and a server-side-rendering hydration issue). The first only matters when a link target comes from user input, and this app only links to its own routes and server-issued ids; the second applies to server-side rendering, which this app does not use. The fix is a major upgrade to React Router 7, which was not done in this batch because it is a breaking change that needs its own testing. Treat it as a tracked item, not as resolved. Re-run `npm audit` before any release.

## Known limits of these checks

- Security tests are black-box and automated. They are not a penetration test, and they cannot see issues in dependencies (run `npm audit` before release).
- The web app's own protections (React escapes text by default; a search found no `dangerouslySetInnerHTML` or `innerHTML` in `apps/web/src`) are not covered by an automated test. The API test proves HTML is stored and returned as plain data.
- Performance numbers are from a single learner on one machine. Many concurrent users, a hosted database and network latency are untested.
- Upload size and PDF parsing limits are tested for refusal, not for hostile PDFs.
- Backups, restores and migration rollbacks are not covered. Migrations only move forward.

## Setup and run (unchanged)

See `README.md`: prerequisites, setup, run, testing, the AI key, and the end-to-end walk-throughs. Every setting is listed in `.env.example`.
