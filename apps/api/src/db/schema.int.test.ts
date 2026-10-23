import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { createTestUser, openTestPool } from "../testing/testDb.js";

let pool: pg.Pool;
let userA: string;
let userB: string;

beforeAll(async () => {
  pool = await openTestPool();
  userA = await createTestUser(pool, "a");
  userB = await createTestUser(pool, "b");
});

afterAll(async () => {
  await pool.end();
});

async function insertCard(userId: string, status: "draft" | "approved" | "rejected", approvedAt: string | null): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO cards (user_id, status, origin, card_type, prompt, answer, approved_at)
     VALUES ($1, $2, 'manual', 'term_definition', 'Q?', 'A', $3) RETURNING id`,
    [userId, status, approvedAt],
  );
  return res.rows[0]!.id;
}

async function insertDeck(userId: string): Promise<string> {
  const res = await pool.query<{ id: string }>("INSERT INTO decks (user_id, title) VALUES ($1, 'D') RETURNING id", [userId]);
  return res.rows[0]!.id;
}

/** Runs a query that must be rejected by the database, and returns the Postgres error. */
async function expectDbError(sql: string, params: unknown[]): Promise<{ code?: string; message: string }> {
  try {
    await pool.query(sql, params);
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error("Expected the database to reject this statement, but it succeeded.");
}

describe("migrations", () => {
  it("are recorded and a second run applies nothing", async () => {
    const applied = await runMigrations(pool);
    expect(applied).toEqual([]);
    const rows = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
    expect(rows.rows.map((r) => r.version)).toContain("0001_init.sql");
  });
});

describe("database constraints are a real backstop (bypassing the API entirely)", () => {
  it("a card cannot be approved without an approved_at, or have approved_at while draft", async () => {
    const a = await expectDbError(
      `INSERT INTO cards (user_id, status, origin, card_type, prompt, answer) VALUES ($1, 'approved', 'manual', 'term_definition', 'Q', 'A')`,
      [userA],
    );
    expect(a.code).toBe("23514");
    const b = await expectDbError(
      `INSERT INTO cards (user_id, status, origin, card_type, prompt, answer, approved_at) VALUES ($1, 'draft', 'manual', 'term_definition', 'Q', 'A', now())`,
      [userA],
    );
    expect(b.code).toBe("23514");
  });

  it("rejects invalid status, type and origin values", async () => {
    for (const [status, origin, type] of [
      ["published", "manual", "term_definition"],
      ["draft", "robot", "term_definition"],
      ["draft", "manual", "essay"],
    ]) {
      const err = await expectDbError(
        "INSERT INTO cards (user_id, status, origin, card_type, prompt, answer) VALUES ($1, $2, $3, $4, 'Q', 'A')",
        [userA, status, origin, type],
      );
      expect(err.code).toBe("23514");
    }
  });

  it("a draft or rejected card cannot be inserted into a deck", async () => {
    const deckId = await insertDeck(userA);
    for (const status of ["draft", "rejected"] as const) {
      const cardId = await insertCard(userA, status, null);
      const err = await expectDbError("INSERT INTO deck_cards (deck_id, card_id, user_id, position) VALUES ($1, $2, $3, 0)", [deckId, cardId, userA]);
      expect(err.code).toBe("23514");
      expect(err.message).toContain("Only approved cards");
    }
  });

  it("a card in a deck cannot leave the approved state", async () => {
    const deckId = await insertDeck(userA);
    const cardId = await insertCard(userA, "approved", new Date().toISOString());
    await pool.query("INSERT INTO deck_cards (deck_id, card_id, user_id, position) VALUES ($1, $2, $3, 0)", [deckId, cardId, userA]);
    const err = await expectDbError("UPDATE cards SET status = 'draft', approved_at = NULL WHERE id = $1", [cardId]);
    expect(err.code).toBe("23514");
    expect(err.message).toContain("is in a deck");
  });

  it("composite foreign keys stop a deck from holding another user's card", async () => {
    const deckOfA = await insertDeck(userA);
    const cardOfB = await insertCard(userB, "approved", new Date().toISOString());
    // Claiming the card belongs to A fails because (card, A) does not exist...
    const err1 = await expectDbError("INSERT INTO deck_cards (deck_id, card_id, user_id, position) VALUES ($1, $2, $3, 0)", [deckOfA, cardOfB, userA]);
    expect(err1.code).toBe("23503");
    // ...and claiming it belongs to B fails because (deck, B) does not exist.
    const err2 = await expectDbError("INSERT INTO deck_cards (deck_id, card_id, user_id, position) VALUES ($1, $2, $3, 0)", [deckOfA, cardOfB, userB]);
    expect(err2.code).toBe("23503");
  });

  it("provenance cannot point at another user's source", async () => {
    const cardOfA = await insertCard(userA, "approved", new Date().toISOString());
    const sourceOfB = (
      await pool.query<{ id: string }>("INSERT INTO sources (user_id, title, source_type, content_text) VALUES ($1, 'S', 'text', 't') RETURNING id", [userB])
    ).rows[0]!.id;
    const err = await expectDbError(
      "INSERT INTO card_sources (card_id, user_id, source_id, source_title, excerpt) VALUES ($1, $2, $3, 'S', 'x')",
      [cardOfA, userA, sourceOfB],
    );
    expect(err.code).toBe("23503");
  });

  it("emails are unique regardless of case", async () => {
    const email = `Case-${Date.now()}@Test.local`;
    await pool.query("INSERT INTO users (email) VALUES ($1)", [email]);
    const err = await expectDbError("INSERT INTO users (email) VALUES ($1)", [email.toLowerCase()]);
    expect(err.code).toBe("23505");
  });

  describe("study tables", () => {
    async function insertSession(userId: string): Promise<string> {
      const res = await pool.query<{ id: string }>("INSERT INTO study_sessions (user_id, mode) VALUES ($1, 'recall') RETURNING id", [userId]);
      return res.rows[0]!.id;
    }
    const respond = (sessionId: string, cardId: string, userId: string, verdict = "correct") =>
      pool.query(
        `INSERT INTO study_responses (session_id, card_id, user_id, card_revision, verdict, eval_method, feedback)
         VALUES ($1, $2, $3, 1, $4, 'deterministic', 'f')`,
        [sessionId, cardId, userId, verdict],
      );

    it("a response must belong to a card that is actually in that session", async () => {
      const sessionId = await insertSession(userA);
      const cardId = await insertCard(userA, "approved", new Date().toISOString());
      const err = await expectDbError(
        `INSERT INTO study_responses (session_id, card_id, user_id, card_revision, verdict, eval_method, feedback)
         VALUES ($1, $2, $3, 1, 'correct', 'deterministic', 'f')`,
        [sessionId, cardId, userA],
      );
      expect(err.code).toBe("23503");
    });

    it("a card can be answered only once per session, and verdict, method and confidence are constrained", async () => {
      const sessionId = await insertSession(userA);
      const cardId = await insertCard(userA, "approved", new Date().toISOString());
      await pool.query("INSERT INTO study_session_items (session_id, card_id, user_id, position, queue_reason) VALUES ($1, $2, $3, 0, 'r')", [sessionId, cardId, userA]);
      await respond(sessionId, cardId, userA);
      expect((await expectDbError("INSERT INTO study_responses (session_id, card_id, user_id, card_revision, verdict, eval_method, feedback) VALUES ($1, $2, $3, 1, 'correct', 'deterministic', 'f')", [sessionId, cardId, userA])).code).toBe("23505");

      const other = await insertCard(userA, "approved", new Date().toISOString());
      await pool.query("INSERT INTO study_session_items (session_id, card_id, user_id, position, queue_reason) VALUES ($1, $2, $3, 1, 'r')", [sessionId, other, userA]);
      expect((await expectDbError("INSERT INTO study_responses (session_id, card_id, user_id, card_revision, verdict, eval_method, feedback) VALUES ($1, $2, $3, 1, 'brilliant', 'deterministic', 'f')", [sessionId, other, userA])).code).toBe("23514");
      expect((await expectDbError("INSERT INTO study_responses (session_id, card_id, user_id, card_revision, verdict, eval_method, feedback) VALUES ($1, $2, $3, 1, 'correct', 'magic', 'f')", [sessionId, other, userA])).code).toBe("23514");
      expect((await expectDbError("INSERT INTO study_responses (session_id, card_id, user_id, card_revision, verdict, eval_method, feedback, confidence) VALUES ($1, $2, $3, 1, 'correct', 'deterministic', 'f', 6)", [sessionId, other, userA])).code).toBe("23514");
    });

    it("sessions cannot include another user's card or deck", async () => {
      const sessionOfA = await insertSession(userA);
      const cardOfB = await insertCard(userB, "approved", new Date().toISOString());
      const item = await expectDbError("INSERT INTO study_session_items (session_id, card_id, user_id, position, queue_reason) VALUES ($1, $2, $3, 0, 'r')", [sessionOfA, cardOfB, userA]);
      expect(item.code).toBe("23503");
      const deckOfB = await insertDeck(userB);
      const session = await expectDbError("INSERT INTO study_sessions (user_id, deck_id, mode) VALUES ($1, $2, 'recall')", [userA, deckOfB]);
      expect(session.code).toBe("23503");
    });

    it("an active session has no end time and an ended one must have it", async () => {
      expect((await expectDbError("INSERT INTO study_sessions (user_id, mode, status) VALUES ($1, 'recall', 'completed')", [userA])).code).toBe("23514");
      expect((await expectDbError("INSERT INTO study_sessions (user_id, mode, status, ended_at) VALUES ($1, 'recall', 'active', now())", [userA])).code).toBe("23514");
      expect((await expectDbError("INSERT INTO study_sessions (user_id, mode) VALUES ($1, 'cram')", [userA])).code).toBe("23514");
    });

    it("review state cannot belong to another user's card, and ease cannot fall below the minimum", async () => {
      const cardOfB = await insertCard(userB, "approved", new Date().toISOString());
      const err = await expectDbError(
        "INSERT INTO card_review_state (user_id, card_id, due_at, interval_days, ease, repetitions, lapses, last_reviewed_at, last_verdict) VALUES ($1, $2, now(), 1, 2.5, 1, 0, now(), 'correct')",
        [userA, cardOfB],
      );
      expect(err.code).toBe("23503");
      const cardOfA = await insertCard(userA, "approved", new Date().toISOString());
      const low = await expectDbError(
        "INSERT INTO card_review_state (user_id, card_id, due_at, interval_days, ease, repetitions, lapses, last_reviewed_at, last_verdict) VALUES ($1, $2, now(), 1, 1.0, 1, 0, now(), 'correct')",
        [userA, cardOfA],
      );
      expect(low.code).toBe("23514");
    });
  });

  it("deleting a user removes all of their data", async () => {
    const doomed = await createTestUser(pool, "doomed");
    const deckId = await insertDeck(doomed);
    const cardId = await insertCard(doomed, "approved", new Date().toISOString());
    await pool.query("INSERT INTO deck_cards (deck_id, card_id, user_id, position) VALUES ($1, $2, $3, 0)", [deckId, cardId, doomed]);
    await pool.query("DELETE FROM users WHERE id = $1", [doomed]);
    for (const table of ["decks", "cards", "deck_cards", "sources", "card_sources"]) {
      const res = await pool.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [doomed]);
      expect(res.rowCount, table).toBe(0);
    }
  });
});
