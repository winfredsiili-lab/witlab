import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { asUser, createTestApp, createTestUser, getTestDatabaseUrl } from "../testing/testDb.js";

/**
 * Performance checks sized for a heavy single learner: 6,000 cards, 100 decks, 40,000 recorded answers, 3,000 review
 * states. Runs in a scratch database. The limits are generous (they catch a missing index or an N+1 query, not a slow laptop):
 * a regression to a full scan or per-row queries at this size is 10x to 100x slower, not 2x.
 */
let admin: pg.Pool;
let pool: pg.Pool;
let app: Express;
let dbName: string;
let user: string;
let deckId: string;
let sessionId: string;
const timings: Array<[string, number]> = [];

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - t);
  timings.push([label, ms]);
  return { value, ms };
}

beforeAll(async () => {
  const testUrl = new URL(getTestDatabaseUrl());
  admin = createPool(testUrl.toString());
  dbName = `witlab_perf_${randomUUID().slice(0, 8)}_test`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const scratch = new URL(testUrl.toString());
  scratch.pathname = `/${dbName}`;
  pool = createPool(scratch.toString());
  await runMigrations(pool);
  app = createTestApp(pool);
  user = await createTestUser(pool, "perf");

  await pool.query(
    `INSERT INTO cards (id, user_id, status, origin, card_type, prompt, answer, approved_at)
     SELECT gen_random_uuid(), $1, 'approved', 'manual', 'short_answer', 'Question number ' || g || '?', 'a', now() FROM generate_series(1, 6000) g`,
    [user],
  );
  await pool.query(
    `INSERT INTO decks (id, user_id, title) SELECT gen_random_uuid(), $1, 'Deck ' || g FROM generate_series(1, 100) g`,
    [user],
  );
  // 60 cards per deck, positions 0..59
  await pool.query(
    `INSERT INTO deck_cards (deck_id, card_id, user_id, position)
     SELECT d.id, c.id, $1, (c.rn - 1) % 60
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM cards WHERE user_id = $1) c
       JOIN (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM decks WHERE user_id = $1) d ON d.rn = ((c.rn - 1) / 60) + 1`,
    [user],
  );
  deckId = (await pool.query("SELECT deck_id FROM deck_cards GROUP BY deck_id ORDER BY deck_id LIMIT 1")).rows[0].deck_id;
  // 800 sessions of 50 items each, all answered (40,000 responses)
  await pool.query(
    `INSERT INTO study_sessions (id, user_id, deck_id, mode, status, started_at, ended_at)
     SELECT gen_random_uuid(), $1, NULL, 'recall', 'completed', now() - (g || ' hours')::interval, now() - (g || ' hours')::interval + interval '5 minutes'
       FROM generate_series(1, 800) g`,
    [user],
  );
  await pool.query(
    `INSERT INTO study_session_items (session_id, card_id, user_id, position, queue_reason)
     SELECT s.id, c.id, $1, (c.rn - 1) % 50, 'New card'
       FROM (SELECT id, row_number() OVER (ORDER BY started_at) AS rn FROM study_sessions WHERE user_id = $1) s
       JOIN (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM cards WHERE user_id = $1) c
         ON c.rn > (s.rn - 1) * 7 AND c.rn <= (s.rn - 1) * 7 + 50 AND c.rn <= 6000`,
    [user],
  );
  // 800 sessions x up to 50 distinct cards each; keep what the unique(session, position) allows.
  await pool.query(
    `INSERT INTO study_responses (session_id, card_id, user_id, card_revision, submitted_answer, verdict, eval_method, feedback, responded_at)
     SELECT i.session_id, i.card_id, $1, 1, 'a', (ARRAY['correct','partial','incorrect'])[1 + (i.position % 3)], 'deterministic', 'ok', now() - (i.position || ' minutes')::interval
       FROM study_session_items i WHERE i.user_id = $1`,
    [user],
  );
  await pool.query(
    `INSERT INTO card_review_state (user_id, card_id, due_at, interval_days, ease, repetitions, lapses, last_reviewed_at, last_verdict)
     SELECT $1, id, now() - interval '1 day', 6, 2.5, 3, 0, now() - interval '7 days', 'correct' FROM cards WHERE user_id = $1 LIMIT 3000`,
    [user],
  );
  await pool.query("VACUUM ANALYZE"); // as autovacuum would: sets visibility hints so the first reader does not pay for it
  // An active session with 50 items for session-detail timing
  const started = await asUser(app, user).post("/api/study/sessions").send({ deckId, limit: 50 });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  sessionId = started.body.id;
}, 180_000);

afterAll(async () => {
  console.log("\nPerformance timings (ms):\n" + timings.map(([l, ms]) => `  ${String(ms).padStart(5)}  ${l}`).join("\n"));
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const LIMIT_MS = 1500;
const get = (path: string) => asUser(app, user).get(path);

describe("performance at 6,000 cards, 100 decks and 40,000 answers", () => {
  it("seeded the expected volume", async () => {
    const n = (await pool.query("SELECT (SELECT count(*)::int FROM cards) c, (SELECT count(*)::int FROM study_responses) r, (SELECT count(*)::int FROM card_review_state) s")).rows[0];
    expect(n.c).toBe(6000);
    expect(n.r).toBeGreaterThan(30_000);
    expect(n.s).toBe(3000);
  });

  it.each([
    ["GET /api/study/overview (global)", "/api/study/overview"],
    ["GET /api/study/overview (deck)", `/api/study/overview?deckId=`],
    ["GET /api/progress (all)", "/api/progress"],
    ["GET /api/progress (one deck)", "/api/progress?deckId="],
    ["GET /api/decks", "/api/decks"],
    ["GET /api/cards (first page)", "/api/cards?status=approved&limit=50"],
    ["GET /api/study/sessions (active)", "/api/study/sessions?status=active"],
    ["GET /api/study/sessions (recent)", "/api/study/sessions?limit=50"],
  ])("%s", async (label, path) => {
    const url = path.endsWith("=") ? path + deckId : path;
    const { value, ms } = await timed(label, () => get(url));
    expect(value.status, JSON.stringify(value.body).slice(0, 200)).toBe(200);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("GET /api/decks/:id (60 cards)", async () => {
    const { value, ms } = await timed("GET /api/decks/:id", () => get(`/api/decks/${deckId}`));
    expect(value.body.cards).toHaveLength(60);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("starts a global review session of 50 from 3,000 due cards", async () => {
    const { value, ms } = await timed("POST /api/study/sessions (global, 50 due)", () => asUser(app, user).post("/api/study/sessions").send({ limit: 50 }));
    expect(value.status).toBe(201);
    expect(value.body.progress.total).toBe(50);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("loads and answers within a 50-card session", async () => {
    const detail = await timed("GET /api/study/sessions/:id (50 items)", () => get(`/api/study/sessions/${sessionId}`));
    expect(detail.value.status).toBe(200);
    expect(detail.ms).toBeLessThan(LIMIT_MS);
    const first = detail.value.body.current;
    const answered = await timed("POST .../responses", () => asUser(app, user).post(`/api/study/sessions/${sessionId}/responses`).send({ cardId: first.cardId, answer: "a" }));
    expect(answered.value.status).toBe(201);
    expect(answered.ms).toBeLessThan(LIMIT_MS);
  });

  it("does not issue per-row queries (query count stays flat as the data grows)", async () => {
    const counts: number[] = [];
    const original = pool.query.bind(pool);
    let n = 0;
    (pool as any).query = (...args: unknown[]) => {
      n++;
      return (original as any)(...args);
    };
    try {
      for (const path of ["/api/decks", "/api/progress", `/api/decks/${deckId}`, `/api/study/sessions/${sessionId}`, "/api/cards?limit=50"]) {
        n = 0;
        await get(path);
        counts.push(n);
      }
    } finally {
      (pool as any).query = original;
    }
    // Each endpoint makes a handful of queries, never one per deck/card/item.
    expect(Math.max(...counts), JSON.stringify(counts)).toBeLessThanOrEqual(12);
  });

  it("the due-queue and history lookups use indexes (no sequential scan of the big tables)", async () => {
    const plan = async (sql: string, params: unknown[]) => (await pool.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    const due = await plan("SELECT card_id FROM card_review_state WHERE user_id = $1 AND due_at <= now() ORDER BY due_at LIMIT 50", [user]);
    expect(due).not.toMatch(/Seq Scan on card_review_state/);
    const hist = await plan("SELECT * FROM study_responses WHERE user_id = $1 AND card_id = (SELECT id FROM cards LIMIT 1) ORDER BY responded_at DESC LIMIT 10", [user]);
    expect(hist).not.toMatch(/Seq Scan on study_responses/);
    const sessions = await plan("SELECT id FROM study_sessions WHERE user_id = $1 AND status = 'active' ORDER BY started_at DESC", [user]);
    expect(sessions).not.toMatch(/Seq Scan on study_sessions/);
  });
});
