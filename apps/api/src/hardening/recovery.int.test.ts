import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "../db/pool.js";
import { asUser, createTestApp, createTestUser, getTestDatabaseUrl, openTestPool } from "../testing/testDb.js";
import { AiProviderError, type AiProvider } from "../modules/ai/provider.js";

let pool: pg.Pool;
let user: string;
beforeAll(async () => {
  pool = await openTestPool();
  user = await createTestUser(pool, "recovery");
});
afterAll(async () => {
  await pool.end();
});

const verdict = { verdict: "correct", strengths: "Good.", gaps: "", stronger_answer: "", misconception: "", clarifying_question: "" };
const provider: AiProvider = { model: "stub", generateStructured: async () => verdict };
const count = async (sql: string, args: unknown[]) => (await pool.query<{ n: number }>(sql, args)).rows[0]!.n;

describe("the database goes away and comes back", () => {
  it("requests fail with a generic 500 (no internals), health says degraded, and the app recovers by itself", async () => {
    let down = false;
    const flaky = new Proxy(pool, {
      get(target, prop, receiver) {
        if ((prop === "query" || prop === "connect") && down) {
          return () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432 (password=hunter2)"), { code: "ECONNREFUSED" }));
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as pg.Pool;
    const app = createTestApp(flaky);
    expect((await asUser(app, user).get("/api/decks")).status).toBe(200);

    down = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await asUser(app, user).get("/api/decks");
    spy.mockRestore();
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe("internal_error");
    expect(JSON.stringify(failed.body)).not.toMatch(/ECONNREFUSED|hunter2|5432/);
    const health = await asUser(app, user).get("/api/health");
    expect(health.status).toBe(503);
    expect(health.body.status).toBe("degraded");

    down = false;
    expect((await asUser(app, user).get("/api/decks")).status).toBe(200);
    expect((await asUser(app, user).get("/api/health")).status).toBe(200);
  });
});

/** A trigger that refuses writes for one card, to simulate the database failing halfway through an answer. */
async function breakScheduleFor(cardId: string): Promise<() => Promise<void>> {
  const fn = `fail_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.card_id = '${cardId}' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON card_review_state FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  return async () => {
    await pool.query(`DROP TRIGGER ${fn} ON card_review_state`);
    await pool.query(`DROP FUNCTION ${fn}()`);
  };
}

describe("a failure in the middle of recording an answer leaves nothing half-saved", () => {
  it("recall answer: no response, no schedule, session still active; after recovery the same answer works", async () => {
    const app = createTestApp(pool);
    const a = asUser(app, user);
    const deck = (await a.post("/api/decks").send({ title: "R" })).body.id;
    const card = (await a.post("/api/cards").send({ cardType: "short_answer", prompt: "Recovery question?", answer: "yes" })).body.id;
    await a.post(`/api/decks/${deck}/cards`).send({ cardId: card });
    const session = (await a.post("/api/study/sessions").send({ deckId: deck })).body.id;

    const restore = await breakScheduleFor(card);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await a.post(`/api/study/sessions/${session}/responses`).send({ cardId: card, answer: "yes" });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await count("SELECT count(*)::int n FROM study_responses WHERE session_id = $1", [session])).toBe(0);
    expect(await count("SELECT count(*)::int n FROM card_review_state WHERE card_id = $1", [card])).toBe(0);
    const still = (await a.get(`/api/study/sessions/${session}`)).body;
    expect(still.status).toBe("active");
    expect(still.current.cardId).toBe(card);

    await restore();
    const retry = await a.post(`/api/study/sessions/${session}/responses`).send({ cardId: card, answer: "yes" });
    expect(retry.status).toBe(201);
    expect(retry.body.result.verdict).toBe("correct");
  });

  it("AI-judged answer: the judgement is discarded, the attempt is logged as failed, nothing is recorded, retry works", async () => {
    const app = createTestApp(pool, undefined, { aiProvider: provider });
    const a = asUser(app, user);
    const deck = (await a.post("/api/decks").send({ title: "W" })).body.id;
    const card = (await a.post("/api/cards").send({ cardType: "open_ended", prompt: "Explain recovery in your own words.", answer: "model", rubric: { criteria: ["x"] } })).body.id;
    await a.post(`/api/decks/${deck}/cards`).send({ cardId: card });
    const session = (await a.post("/api/study/sessions").send({ deckId: deck, mode: "explain" })).body.id;

    const restore = await breakScheduleFor(card);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await a.post(`/api/study/sessions/${session}/responses`).send({ cardId: card, answer: "my answer" });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await count("SELECT count(*)::int n FROM study_responses WHERE session_id = $1", [session])).toBe(0);
    expect(await count("SELECT count(*)::int n FROM ai_evaluations WHERE session_id = $1 AND status = 'failed'", [session])).toBe(1);
    expect(await count("SELECT count(*)::int n FROM ai_evaluations WHERE session_id = $1 AND status = 'pending'", [session])).toBe(0);

    await restore();
    expect((await a.post(`/api/study/sessions/${session}/responses`).send({ cardId: card, answer: "my answer" })).status).toBe(201);
  });

  it("a session survives a server restart (new pool, new app) and can be finished", async () => {
    const app = createTestApp(pool);
    const a = asUser(app, user);
    const deck = (await a.post("/api/decks").send({ title: "Restart" })).body.id;
    for (const q of ["Restart question one?", "Restart question two?"]) {
      const c = (await a.post("/api/cards").send({ cardType: "short_answer", prompt: q, answer: "a" })).body.id;
      await a.post(`/api/decks/${deck}/cards`).send({ cardId: c });
    }
    const s = (await a.post("/api/study/sessions").send({ deckId: deck })).body;
    await a.post(`/api/study/sessions/${s.id}/responses`).send({ cardId: s.current.cardId, answer: "a" });

    const pool2 = createPool(getTestDatabaseUrl());
    try {
      const app2 = createTestApp(pool2);
      const resumed = (await asUser(app2, user).get(`/api/study/sessions/${s.id}`)).body;
      expect(resumed.status).toBe("active");
      expect(resumed.progress).toMatchObject({ total: 2, answered: 1 });
      const done = await asUser(app2, user).post(`/api/study/sessions/${s.id}/responses`).send({ cardId: resumed.current.cardId, answer: "a" });
      expect(done.body.session.status).toBe("completed");
    } finally {
      await pool2.end();
    }
  });
});

describe("work that was interrupted does not block the learner", () => {
  const TEXT = "An availability zone is an isolated location within a region. Zones have independent power.";
  const gen = { model: "stub", generateStructured: async () => ({ cards: [] }) } satisfies AiProvider;

  it("a generation job stuck in 'running' blocks only for its window, then a new one is allowed", async () => {
    const app = createTestApp(pool, undefined, { aiProvider: gen, generationLimits: { perUserPerDay: 100, globalPerDay: 100000 } });
    const a = asUser(app, user);
    const src = (await a.post("/api/sources").send({ title: "Stuck", sourceType: "text", contentText: TEXT })).body.id;
    await pool.query("INSERT INTO generation_jobs (user_id, source_id, status, scope, scope_chars, model, requested_cards) VALUES ($1, $2, 'running', '{\"type\":\"all\"}', 10, 'stub', 3)", [user, src]);
    expect((await a.post(`/api/sources/${src}/generate`).send({})).status).toBe(409);
    await pool.query("UPDATE generation_jobs SET created_at = now() - interval '5 minutes' WHERE user_id = $1 AND status = 'running'", [user]);
    expect((await a.post(`/api/sources/${src}/generate`).send({})).status).toBe(201);
  });

  it("an abandoned 'pending' AI attempt (server stopped mid-call) counts toward the limit but never blocks answering", async () => {
    const app = createTestApp(pool, undefined, { aiProvider: provider });
    const a = asUser(app, user);
    const deck = (await a.post("/api/decks").send({ title: "Pending" })).body.id;
    const card = (await a.post("/api/cards").send({ cardType: "open_ended", prompt: "Explain pending attempts here.", answer: "m", rubric: { criteria: ["x"] } })).body.id;
    await a.post(`/api/decks/${deck}/cards`).send({ cardId: card });
    const session = (await a.post("/api/study/sessions").send({ deckId: deck, mode: "explain" })).body.id;
    await pool.query("INSERT INTO ai_evaluations (user_id, card_id, session_id, status, model, created_at) VALUES ($1, $2, $3, 'pending', 'stub', now() - interval '1 hour')", [user, card, session]);
    expect((await a.post(`/api/study/sessions/${session}/responses`).send({ cardId: card, answer: "ok" })).status).toBe(201);
  });

  it("provider outage then recovery in the same session", async () => {
    let failing = true;
    const flaky: AiProvider = {
      model: "stub",
      generateStructured: async () => {
        if (failing) throw new AiProviderError("ai_unavailable", "provider down");
        return verdict;
      },
    };
    const app = createTestApp(pool, undefined, { aiProvider: flaky });
    const a = asUser(app, user);
    const deck = (await a.post("/api/decks").send({ title: "Outage" })).body.id;
    const card = (await a.post("/api/cards").send({ cardType: "open_ended", prompt: "Explain outages and recovery.", answer: "m", rubric: { criteria: ["x"] } })).body.id;
    await a.post(`/api/decks/${deck}/cards`).send({ cardId: card });
    const session = (await a.post("/api/study/sessions").send({ deckId: deck, mode: "explain" })).body.id;
    for (let i = 0; i < 3; i++) expect((await a.post(`/api/study/sessions/${session}/responses`).send({ cardId: card, answer: "text" })).status).toBe(502);
    failing = false;
    expect((await a.post(`/api/study/sessions/${session}/responses`).send({ cardId: card, answer: "text" })).status).toBe(201);
    expect(await count("SELECT count(*)::int n FROM study_responses WHERE session_id = $1", [session])).toBe(1);
  });
});
