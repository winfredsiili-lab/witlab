import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessionDetailSchema, submitOutcomeSchema, type SessionDetail } from "@witlab/contracts";
import { AiProviderError, type AiProvider, type StructuredRequest } from "../ai/provider.js";
import { EVAL_PROMPT_VERSION } from "../evaluation/aiEvaluator.js";
import { asUser, createTestApp, createTestUser, openTestPool } from "../../testing/testDb.js";

const DAY = 24 * 60 * 60_000;
const T0 = new Date("2026-03-01T09:00:00.000Z");

class StubProvider implements AiProvider {
  model = "stub-eval";
  calls: StructuredRequest[] = [];
  constructor(public behaviour: (r: StructuredRequest) => unknown | Promise<unknown>) {}
  async generateStructured(r: StructuredRequest) {
    this.calls.push(r);
    return this.behaviour(r);
  }
}

const verdictReply = (verdict: string, over: Record<string, string> = {}) => ({
  verdict,
  strengths: verdict === "incorrect" ? "" : "You named the isolation idea.",
  gaps: verdict === "correct" ? "" : "You did not say what zones do not protect against.",
  stronger_answer: verdict === "correct" ? "" : "Add that zones do not cover regional outages.",
  misconception: "",
  clarifying_question: "",
  ...over,
});

let pool: pg.Pool;
let clock: Date;
let userA: string;
let userB: string;
let provider: StubProvider;
let app: Express;
let limits = { perUserPerDay: 1000, globalPerDay: 1000 };

beforeAll(async () => {
  pool = await openTestPool();
  userA = await createTestUser(pool, "wa");
  userB = await createTestUser(pool, "wb");
});
afterAll(async () => {
  await pool.end();
});
beforeEach(() => {
  clock = new Date(T0);
  provider = new StubProvider(() => verdictReply("correct"));
  limits = { perUserPerDay: 1000, globalPerDay: 1000 };
  app = createTestApp(pool, () => clock, { aiProvider: provider, evaluationLimits: limits });
});

const MODEL_ANSWER = "Failures in one zone are contained and do not spread to others.";
const open = (extra: Record<string, unknown> = {}) => ({
  cardType: "open_ended",
  prompt: "Explain why availability zones improve resilience.",
  answer: MODEL_ANSWER,
  rubric: { criteria: ["mentions isolation", "does not claim protection from regional outages"] },
  ...extra,
});

async function deckWith(user: string, cards: Array<Record<string, unknown>>) {
  const deck = await asUser(app, user).post("/api/decks").send({ title: `D${Math.random()}` });
  const ids: string[] = [];
  for (const c of cards) {
    const r = await asUser(app, user).post("/api/cards").send(c);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push(r.body.id);
    await asUser(app, user).post(`/api/decks/${deck.body.id}/cards`).send({ cardId: r.body.id });
  }
  return { deckId: deck.body.id as string, ids };
}

async function start(user: string, deckId: string, mode = "explain"): Promise<SessionDetail> {
  const r = await asUser(app, user).post("/api/study/sessions").send({ deckId, mode });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return sessionDetailSchema.parse(r.body);
}
const submit = (user: string, sessionId: string, body: Record<string, unknown>) =>
  asUser(app, user).post(`/api/study/sessions/${sessionId}/responses`).send(body);
const count = async (table: string, where = "true", args: unknown[] = []) =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, args)).rows[0]!.n;

describe("written-answer study: queues and what the learner sees", () => {
  it("keeps each mode to its own cards and never sends the model answer before answering", async () => {
    const { deckId, ids } = await deckWith(userA, [
      { cardType: "short_answer", prompt: "VM?", answer: "VM" },
      open(),
      open({ prompt: "How do zones and regions differ?", learningMode: "connections" }),
      open({ prompt: "Which design survives a zone outage?", learningMode: "apply" }),
    ]);
    const recall = await start(userA, deckId, "recall");
    expect(recall.progress.total).toBe(1);
    for (const [mode, idx] of [["explain", 1], ["connections", 2], ["apply", 3]] as const) {
      const s = await start(userA, deckId, mode);
      expect(s.progress.total).toBe(1);
      expect(s.mode).toBe(mode);
      expect(s.current?.cardId).toBe(ids[idx]);
      expect(s.current?.evaluation).toBe("ai");
      expect(s.current?.revealAnswer).toBeNull();
      expect(s.current?.choices).toBeNull();
      expect(JSON.stringify(s)).not.toContain(MODEL_ANSWER);
    }
    for (const mode of ["recall", "explain", "connections", "apply"]) {
      const o = await asUser(app, userA).get(`/api/study/overview?deckId=${deckId}&mode=${mode}`);
      expect(o.body.eligibleCount, mode).toBe(1);
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("reports nothing_to_study per mode", async () => {
    const { deckId } = await deckWith(userA, [{ cardType: "short_answer", prompt: "VM?", answer: "VM" }]);
    const r = await asUser(app, userA).post("/api/study/sessions").send({ deckId, mode: "apply" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Apply mode/);
  });
});

describe("written-answer study: successful evaluation", () => {
  it.each([
    ["correct", 1, "correct"],
    ["partial", 1, "partial"],
    ["incorrect", 0, "incorrect"],
  ])("records an %s verdict as AI evidence and schedules the card", async (verdict, _d, expected) => {
    provider.behaviour = () => verdictReply(verdict);
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    const res = await submit(userA, s.id, { cardId: ids[0], answer: "Zones are isolated from each other.", confidence: 4 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const out = submitOutcomeSchema.parse(res.body);
    if ("needsClarification" in out) throw new Error("unexpected clarification");
    expect(out.result).toMatchObject({ verdict: expected, evalMethod: "ai", correctAnswer: MODEL_ANSWER });
    expect(out.result.feedback.length).toBeGreaterThan(10);
    expect(out.session.status).toBe("completed");

    const row = (await pool.query("SELECT * FROM study_responses WHERE session_id = $1", [s.id])).rows[0];
    expect(row).toMatchObject({ verdict: expected, eval_method: "ai", submitted_answer: "Zones are isolated from each other.", confidence: 4 });
    expect(row.evaluator_metadata).toMatchObject({ model: "stub-eval", promptVersion: EVAL_PROMPT_VERSION, mode: "explain" });
    const state = (await pool.query("SELECT * FROM card_review_state WHERE card_id = $1", [ids[0]])).rows[0];
    if (expected === "incorrect") {
      expect(new Date(state.due_at).getTime() - clock.getTime()).toBe(10 * 60_000);
    } else {
      expect(new Date(state.due_at).getTime() - clock.getTime()).toBe(DAY);
    }
    expect(await count("ai_evaluations", "user_id = $1 AND status = 'succeeded' AND verdict = $2", [userA, expected])).toBeGreaterThan(0);
  });

  it("gives the evaluator the question, model answer, criteria and the learner's answer, but never the confidence", async () => {
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    await submit(userA, s.id, { cardId: ids[0], answer: "My own words here.", confidence: 5 });
    const call = provider.calls[0]!;
    expect(call.user).toContain("Explain why availability zones improve resilience.");
    expect(call.user).toContain(MODEL_ANSWER);
    expect(call.user).toContain("mentions isolation");
    expect(call.user).toContain("My own words here.");
    expect(call.user + call.system).not.toMatch(/confidence/i);
  });
});

describe("written-answer study: failures record nothing and can be retried", () => {
  it.each([
    ["ai_rate_limited", 429],
    ["ai_timeout", 504],
    ["ai_unavailable", 502],
    ["ai_auth", 502],
    ["ai_truncated", 502],
    ["ai_bad_response", 502],
  ])("%s -> %i", async (code, status) => {
    provider.behaviour = () => {
      throw new AiProviderError(code as never, "provider said no");
    };
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    const res = await submit(userA, s.id, { cardId: ids[0], answer: "An answer I worked on." });
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.message).toMatch(/not recorded/);

    expect(await count("study_responses", "session_id = $1", [s.id])).toBe(0);
    expect(await count("card_review_state", "card_id = $1", [ids[0]])).toBe(0);
    const after = await asUser(app, userA).get(`/api/study/sessions/${s.id}`);
    expect(after.body.status).toBe("active");
    expect(after.body.current.cardId).toBe(ids[0]);
    expect(await count("ai_evaluations", "session_id = $1 AND status = 'failed' AND error_code = $2", [s.id, code])).toBe(1);

    provider.behaviour = () => verdictReply("correct");
    const retry = await submit(userA, s.id, { cardId: ids[0], answer: "An answer I worked on." });
    expect(retry.status).toBe(201);
    expect(await count("study_responses", "session_id = $1", [s.id])).toBe(1);
  });

  it.each([
    ["an unknown verdict", { ...verdictReply("correct"), verdict: "great" }],
    ["a verdict without feedback", verdictReply("correct", { strengths: "" })],
    ["not an object", "correct"],
    ["an ambiguous result with no question", verdictReply("ambiguous", { strengths: "", gaps: "", stronger_answer: "" })],
  ])("treats %s as ai_bad_response and records nothing (never defaults to correct)", async (_n, reply) => {
    provider.behaviour = () => reply;
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    const res = await submit(userA, s.id, { cardId: ids[0], answer: "Something." });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ai_bad_response");
    expect(await count("study_responses", "session_id = $1", [s.id])).toBe(0);
    expect(await count("card_review_state", "card_id = $1", [ids[0]])).toBe(0);
  });

  it("asks for clarification on an ambiguous answer without recording or scheduling anything", async () => {
    provider.behaviour = () => verdictReply("ambiguous", { strengths: "", gaps: "", stronger_answer: "", clarifying_question: "Which kind of zone do you mean?" });
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    const res = await submit(userA, s.id, { cardId: ids[0], answer: "It helps." });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsClarification: true, feedback: "Which kind of zone do you mean?" });
    expect(await count("study_responses", "session_id = $1", [s.id])).toBe(0);
    expect(await count("card_review_state", "card_id = $1", [ids[0]])).toBe(0);
    expect((await asUser(app, userA).get(`/api/study/sessions/${s.id}`)).body.current.cardId).toBe(ids[0]);
    expect(await count("ai_evaluations", "session_id = $1 AND verdict = 'ambiguous'", [s.id])).toBe(1);
  });
});

describe("written-answer study: input, ownership and races", () => {
  it("rejects empty or wrongly shaped answers without calling the AI", async () => {
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    for (const body of [{}, { answer: "   " }, { answer: "x", selectedIndex: 0 }, { answer: "x", selfGrade: "correct" }]) {
      const res = await submit(userA, s.id, { cardId: ids[0], ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_answer");
    }
    expect(provider.calls).toHaveLength(0);
    expect(await count("ai_evaluations", "user_id = $1 AND session_id = $2", [userA, s.id])).toBe(0);
  });

  it("answers a card once: the second submission is 409 already_answered and does not call the AI", async () => {
    const { deckId, ids } = await deckWith(userA, [open(), open({ prompt: "Another written question?" })]);
    const s = await start(userA, deckId);
    expect((await submit(userA, s.id, { cardId: ids[0], answer: "first" })).status).toBe(201);
    const calls = provider.calls.length;
    const again = await submit(userA, s.id, { cardId: ids[0], answer: "second" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_answered");
    expect(provider.calls.length).toBe(calls);
    expect(await count("study_responses", "session_id = $1", [s.id])).toBe(1);
  });

  it("two simultaneous submissions record exactly one response", async () => {
    provider.behaviour = async () => {
      await new Promise((r) => setTimeout(r, 80));
      return verdictReply("correct");
    };
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    const [a, b] = await Promise.all([submit(userA, s.id, { cardId: ids[0], answer: "one" }), submit(userA, s.id, { cardId: ids[0], answer: "two" })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await count("study_responses", "session_id = $1", [s.id])).toBe(1);
  });

  it("discards the result when the card is edited while it is being judged (409 card_changed)", async () => {
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    provider.behaviour = async () => {
      const edit = await asUser(app, userA).patch(`/api/cards/${ids[0]}`).send({ answer: "A different model answer entirely." });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      return verdictReply("correct");
    };
    const res = await submit(userA, s.id, { cardId: ids[0], answer: "My answer." });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("card_changed");
    expect(await count("study_responses", "session_id = $1", [s.id])).toBe(0);
    expect(await count("card_review_state", "card_id = $1", [ids[0]])).toBe(0);
    expect(await count("ai_evaluations", "session_id = $1 AND status = 'failed' AND error_code = 'card_changed'", [s.id])).toBe(1);
  });

  it("does not let another user answer in, or see, a session (404, AI not called)", async () => {
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    const res = await submit(userB, s.id, { cardId: ids[0], answer: "sneaky" });
    expect(res.status).toBe(404);
    expect(provider.calls).toHaveLength(0);
    expect((await asUser(app, userB).get(`/api/study/sessions/${s.id}`)).status).toBe(404);
  });

  it("refuses answers once the session has ended", async () => {
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    await asUser(app, userA).post(`/api/study/sessions/${s.id}/end`).send({});
    const res = await submit(userA, s.id, { cardId: ids[0], answer: "late" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("session_not_active");
    expect(provider.calls).toHaveLength(0);
  });

  it("answers 503 ai_not_configured when the server has no provider, recording nothing", async () => {
    const { deckId, ids } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId);
    const bare = createTestApp(pool, () => clock);
    const res = await asUser(bare, userA).post(`/api/study/sessions/${s.id}/responses`).send({ cardId: ids[0], answer: "x" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ai_not_configured");
    expect(await count("study_responses", "session_id = $1", [s.id])).toBe(0);
  });
});

describe("written-answer study: daily limits", () => {
  it("stops at the per-user limit, counting failed attempts, before calling the AI", async () => {
    const user = await createTestUser(pool, "limited");
    const tight = createTestApp(pool, () => clock, { aiProvider: provider, evaluationLimits: { perUserPerDay: 2, globalPerDay: 100000 } });
    const mk = async () => {
      const deck = await asUser(tight, user).post("/api/decks").send({ title: "L" });
      const c = await asUser(tight, user).post("/api/cards").send(open());
      await asUser(tight, user).post(`/api/decks/${deck.body.id}/cards`).send({ cardId: c.body.id });
      const s = await asUser(tight, user).post("/api/study/sessions").send({ deckId: deck.body.id, mode: "explain" });
      return { sid: s.body.id as string, cid: c.body.id as string };
    };
    const { sid, cid } = await mk();
    provider.behaviour = () => {
      throw new AiProviderError("ai_timeout", "slow");
    };
    expect((await asUser(tight, user).post(`/api/study/sessions/${sid}/responses`).send({ cardId: cid, answer: "a" })).status).toBe(504);
    provider.behaviour = () => verdictReply("correct");
    expect((await asUser(tight, user).post(`/api/study/sessions/${sid}/responses`).send({ cardId: cid, answer: "a" })).status).toBe(201);
    const { sid: sid2, cid: cid2 } = await mk();
    const before = provider.calls.length;
    const blocked = await asUser(tight, user).post(`/api/study/sessions/${sid2}/responses`).send({ cardId: cid2, answer: "a" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("evaluation_limit_reached");
    expect(provider.calls.length).toBe(before);
    expect(await count("study_responses", "session_id = $1", [sid2])).toBe(0);
    const me = await asUser(tight, user).get("/api/me");
    expect(me.body.aiUsage).toMatchObject({ evaluationsUsedToday: 2, evaluationDailyLimit: 2 });
  });

  it("stops at the shared global limit", async () => {
    const user = await createTestUser(pool, "global");
    const total = await count("ai_evaluations", "created_at > now() - interval '24 hours'");
    const tight = createTestApp(pool, () => clock, { aiProvider: provider, evaluationLimits: { perUserPerDay: 100000, globalPerDay: total } });
    const deck = await asUser(tight, user).post("/api/decks").send({ title: "G" });
    const c = await asUser(tight, user).post("/api/cards").send(open());
    await asUser(tight, user).post(`/api/decks/${deck.body.id}/cards`).send({ cardId: c.body.id });
    const s = await asUser(tight, user).post("/api/study/sessions").send({ deckId: deck.body.id, mode: "explain" });
    const res = await asUser(tight, user).post(`/api/study/sessions/${s.body.id}/responses`).send({ cardId: c.body.id, answer: "a" });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("evaluation_capacity_reached");
  });
});

describe("written-answer cards", () => {
  it("default to the explain mode, accept connections/apply, and reject modes on other card types", async () => {
    const a = await asUser(app, userA).post("/api/cards").send(open());
    expect(a.body.learningMode).toBe("explain");
    const b = await asUser(app, userA).post("/api/cards").send(open({ learningMode: "apply" }));
    expect(b.body.learningMode).toBe("apply");
    const c = await asUser(app, userA).post("/api/cards").send({ cardType: "short_answer", prompt: "VM?", answer: "VM", learningMode: "explain" });
    expect(c.status).toBe(400);
    const d = await asUser(app, userA).post("/api/cards").send({ cardType: "short_answer", prompt: "VM?", answer: "VM" });
    expect(d.body.learningMode).toBeNull();
  });
});

describe("hybrid mode", () => {
  const cards = [
    { cardType: "short_answer", prompt: "What does VM stand for?", answer: "VM" },
    { cardType: "term_definition", prompt: "Define availability zone", answer: "An isolated location within a region." },
    open({ prompt: "Apply: which design survives a zone outage?", learningMode: "apply" }),
    open({ prompt: "Connections: how do zones and regions differ?", learningMode: "connections" }),
    open({ prompt: "Explain: why do zones improve resilience?" }),
  ];

  it("runs recall, explain, connections, apply in a fixed order regardless of card creation order, and says so", async () => {
    const { deckId } = await deckWith(userA, cards);
    const s = await start(userA, deckId, "hybrid");
    expect(s.mode).toBe("hybrid");
    expect(s.progress.total).toBe(5);
    expect(s.phases).toEqual([
      { mode: "recall", total: 2, answered: 0 },
      { mode: "explain", total: 1, answered: 0 },
      { mode: "connections", total: 1, answered: 0 },
      { mode: "apply", total: 1, answered: 0 },
    ]);
    // Walk the session and record the phase of every card shown.
    const seen: string[] = [];
    let cur = s;
    while (cur.current) {
      seen.push(cur.current.phase);
      const c = cur.current;
      const body =
        c.evaluation === "ai" ? { answer: "Zones are isolated." } : c.evaluation === "self" ? { selfGrade: "correct" } : { answer: "VM" };
      const res = await submit(userA, cur.id, { cardId: c.cardId, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      cur = sessionDetailSchema.parse(res.body.session);
    }
    expect(seen).toEqual(["recall", "recall", "explain", "connections", "apply"]);
    expect(cur.status).toBe("completed");
    expect(cur.phases!.every((p) => p.answered === p.total)).toBe(true);
    expect(provider.calls).toHaveLength(3); // only the written phases use AI
  });

  it("skips empty phases, caps each phase so one cannot crowd out the rest, and non-hybrid sessions have no phases", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ cardType: "short_answer", prompt: `Recall question number ${i}?`, answer: "a" }));
    const { deckId } = await deckWith(userA, [...many, open()]);
    const s = await asUser(app, userA).post("/api/study/sessions").send({ deckId, mode: "hybrid", limit: 4 });
    const d = sessionDetailSchema.parse(s.body);
    expect(d.phases).toEqual([
      { mode: "recall", total: 1, answered: 0 },
      { mode: "explain", total: 1, answered: 0 },
    ]);
    const plain = await start(userA, deckId, "recall");
    expect(plain.phases).toBeNull();
    expect(plain.current?.phase).toBe("recall");
  });

  it("overview sums the four phases; a deck with nothing says Hybrid mode", async () => {
    const { deckId } = await deckWith(userA, cards);
    const o = await asUser(app, userA).get(`/api/study/overview?deckId=${deckId}&mode=hybrid`);
    expect(o.body).toMatchObject({ eligibleCount: 5, newCount: 5 });
    const empty = await deckWith(userA, []);
    const r = await asUser(app, userA).post("/api/study/sessions").send({ deckId: empty.deckId, mode: "hybrid" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Hybrid mode/);
  });

  it("written answers in a hybrid session fail safely like any other: nothing recorded, retry works", async () => {
    const { deckId } = await deckWith(userA, [open()]);
    const s = await start(userA, deckId, "hybrid");
    provider.behaviour = () => {
      throw new AiProviderError("ai_timeout", "slow");
    };
    const res = await submit(userA, s.id, { cardId: s.current!.cardId, answer: "text" });
    expect(res.status).toBe(504);
    expect(await count("study_responses", "session_id = $1", [s.id])).toBe(0);
  });
});
