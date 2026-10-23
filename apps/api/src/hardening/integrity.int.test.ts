import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { asUser, createTestApp, createTestUser, getTestDatabaseUrl } from "../testing/testDb.js";
import type { AiProvider } from "../modules/ai/provider.js";
import { CHECKS, runIntegrityChecks } from "./integrity.js";

/**
 * Runs in its own scratch database so that other test files (which sometimes write rows directly to prove a point)
 * cannot make the global checks flap. The scratch database is created and dropped by this file.
 */
let admin: pg.Pool;
let pool: pg.Pool;
let app: Express;
let dbName: string;
let user: string;

const TEXT = "An availability zone is an isolated location within a region. Zones have independent power, cooling and networking.";
const provider: AiProvider = {
  model: "stub",
  generateStructured: async (r) => {
    if (r.schemaName === "answer_evaluation") {
      return { verdict: "partial", strengths: "Isolation.", gaps: "Regions.", stronger_answer: "Add regions.", misconception: "", clarifying_question: "" };
    }
    return {
      cards: [{ card_type: "term_definition", prompt: "What is an availability zone?", answer: "An isolated location within a region.", explanation: "", choices: [], correct_choice_index: -1, accepted_answers: [], numeric_answer: "", numeric_tolerance: "", quote: "An availability zone is an isolated location within a region." }],
    };
  },
};

beforeAll(async () => {
  const testUrl = new URL(getTestDatabaseUrl());
  admin = createPool(testUrl.toString());
  dbName = `witlab_integrity_${randomUUID().slice(0, 8)}_test`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const scratch = new URL(testUrl.toString());
  scratch.pathname = `/${dbName}`;
  pool = createPool(scratch.toString());
  await runMigrations(pool);
  app = createTestApp(pool, undefined, { aiProvider: provider, generationLimits: { perUserPerDay: 100, globalPerDay: 100 } });
  user = await createTestUser(pool, "integrity");

  // A realistic journey through every feature that writes data.
  const a = asUser(app, user);
  const deck = (await a.post("/api/decks").send({ title: "Everything" })).body.id;
  const add = async (card: object) => {
    const c = (await a.post("/api/cards").send(card)).body;
    await a.post(`/api/decks/${deck}/cards`).send({ cardId: c.id });
    return c;
  };
  await add({ cardType: "short_answer", prompt: "What does VM stand for?", answer: "VM" });
  await add({ cardType: "multiple_choice", prompt: "Which is isolated?", answer: "Beta", answerSpec: { choices: ["Alpha", "Beta"], correctIndex: 1 } });
  await add({ cardType: "term_definition", prompt: "Define zone", answer: "Isolated." });
  await add({ cardType: "open_ended", prompt: "Explain why zones help resilience.", answer: "Isolation.", rubric: { criteria: ["mentions isolation"] } });
  const src = (await a.post("/api/sources").send({ title: "Notes", sourceType: "text", contentText: TEXT })).body.id;
  const gen = (await a.post(`/api/sources/${src}/generate`).send({})).body;
  await a.post(`/api/cards/${gen.cards[0].id}/approve`).send({ deckId: deck });
  const s = (await a.post("/api/study/sessions").send({ deckId: deck, mode: "hybrid" })).body;
  let cur = s;
  while (cur.current) {
    const c = cur.current;
    const body = c.evaluation === "ai" ? { answer: "Isolated zones." } : c.evaluation === "self" ? { selfGrade: "partial" } : c.choices ? { selectedIndex: 1 } : { answer: "VM" };
    cur = (await a.post(`/api/study/sessions/${cur.id}/responses`).send({ cardId: c.cardId, ...body })).body.session;
  }
  // An unfinished session on a second deck with fresh cards.
  const deck2 = (await a.post("/api/decks").send({ title: "Unfinished" })).body.id;
  for (const q of ["First fresh question?", "Second fresh question?"]) {
    const c = (await a.post("/api/cards").send({ cardType: "short_answer", prompt: q, answer: "x" })).body;
    await a.post(`/api/decks/${deck2}/cards`).send({ cardId: c.id });
  }
  const open = await a.post("/api/study/sessions").send({ deckId: deck2, mode: "recall" });
  expect(open.status).toBe(201);
  await a.post(`/api/study/sessions/${open.body.id}/responses`).send({ cardId: open.body.current.cardId, answer: "x" });
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe("database integrity", () => {
  it("every rule holds after a realistic journey (manual, generated, written, hybrid, unfinished sessions)", async () => {
    const results = await runIntegrityChecks(pool);
    expect(results.map((r) => r.name)).toEqual(CHECKS.map((c) => c.name));
    expect(results.filter((r) => r.violations > 0)).toEqual([]);
    // The journey really produced the data the checks look at.
    const counts = (await pool.query("SELECT (SELECT count(*)::int FROM study_responses) r, (SELECT count(*)::int FROM study_responses WHERE eval_method='ai') ai, (SELECT count(*)::int FROM card_sources) src, (SELECT count(*)::int FROM card_review_state) rs")).rows[0];
    expect(counts.r).toBeGreaterThanOrEqual(5);
    expect(counts.ai).toBeGreaterThanOrEqual(1);
    expect(counts.src).toBeGreaterThanOrEqual(1);
  });

  // Each check must actually detect the breakage it exists for. Corrupt one thing, expect exactly that check to fire.
  const breakages: Array<[string, string]> = [
    ["approved-have-timestamp", "UPDATE cards SET approved_at = NULL WHERE id = (SELECT id FROM cards WHERE status='approved' LIMIT 1) AND false"],
    ["only-approved-in-decks", "UPDATE cards SET status='rejected', approved_at=NULL WHERE id = (SELECT card_id FROM deck_cards LIMIT 1)"],
    ["ai-cards-have-provenance", "DELETE FROM card_sources WHERE card_id = (SELECT id FROM cards WHERE origin='ai_generated' LIMIT 1)"],
    ["excerpts-match-text-sources", "UPDATE card_sources SET excerpt = 'tampered excerpt text' WHERE char_start IS NOT NULL"],
    ["response-revision-not-in-future", "UPDATE study_responses SET card_revision = 99 WHERE id = (SELECT id FROM study_responses LIMIT 1)"],
    ["ai-responses-have-ledger-entry", "DELETE FROM ai_evaluations"],
    ["ai-responses-name-their-model", "UPDATE study_responses SET evaluator_metadata = '{}' WHERE eval_method = 'ai'"],
    ["review-state-has-evidence", "DELETE FROM study_responses WHERE eval_method = 'deterministic' AND card_id = (SELECT card_id FROM study_responses WHERE eval_method='deterministic' LIMIT 1)"],
    ["review-state-matches-last-response", "UPDATE card_review_state SET last_verdict = CASE WHEN last_verdict='correct' THEN 'incorrect' ELSE 'correct' END"],
    ["completed-sessions-fully-answered", "UPDATE study_sessions SET status='completed', ended_at=now() WHERE status='active'"],
    ["deck-positions-contiguous", "UPDATE deck_cards SET position = position + 5 WHERE position = 0"],
  ];
  it.each(breakages.filter(([, sql]) => !sql.endsWith("AND false")))("%s detects its own breakage", async (name, sql) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica"); // let us write rows the foreign keys would otherwise refuse
      await client.query(sql);
      const hit = (await runIntegrityChecks(client)).find((r) => r.name === name)!;
      expect(hit.violations, name).toBeGreaterThan(0);
      expect(hit.severity).toBe("error");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("the scratch database is clean again after the rolled-back corruption", async () => {
    expect((await runIntegrityChecks(pool)).filter((r) => r.violations > 0)).toEqual([]);
  });
});
