import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { learningProgressSchema } from "@witlab/contracts";
import { asUser, createTestApp, createTestUser, openTestPool } from "../../testing/testDb.js";
import { createCardService } from "../cards/card.service.js";

let pool: pg.Pool;
let app: Express;
let clock = new Date("2026-03-01T10:00:00Z");

beforeAll(async () => {
  pool = await openTestPool();
  app = createTestApp(pool, () => clock);
});
afterAll(async () => {
  await pool.end();
});

const manual = async (user: string, body: Record<string, unknown>) => (await asUser(app, user).post("/api/cards").send(body)).body;
const short = (user: string, prompt: string) =>
  manual(user, { cardType: "short_answer", prompt, answer: "right", answerSpec: { acceptedAnswers: ["right"] } });

async function setup() {
  const user = await createTestUser(pool, "prog");
  const deck = (await asUser(app, user).post("/api/decks").send({ title: "Deck" })).body.id as string;
  const cards: { id: string; prompt: string }[] = [];
  for (const p of ["c1?", "c2?", "c3?", "c4?", "c5?"]) {
    const c = await short(user, p);
    await asUser(app, user).post(`/api/decks/${deck}/cards`).send({ cardId: c.id });
    cards.push(c);
  }
  return { user, deck, cards };
}

/** Starts a global or deck session and answers every card; `right` decides which cards are answered correctly. */
async function study(user: string, deck: string | null, right: (id: string) => boolean) {
  const started = await asUser(app, user).post("/api/study/sessions").send(deck ? { deckId: deck } : {});
  expect(started.status).toBe(201);
  let session = started.body;
  while (session.current) {
    const id = session.current.cardId as string;
    const res = await asUser(app, user).post(`/api/study/sessions/${session.id}/responses`).send({ cardId: id, answer: right(id) ? "right" : "wrong" });
    expect(res.status).toBe(201);
    session = res.body.session;
  }
}
const progress = async (user: string, query = "") => learningProgressSchema.parse((await asUser(app, user).get(`/api/progress${query}`)).body);

describe("learning progress", () => {
  it("shows four distinct states from real evidence, never inventing any", async () => {
    clock = new Date("2026-03-01T10:00:00Z");
    const { user, deck, cards } = await setup();
    const [c1, c2] = cards as [typeof cards[0], typeof cards[0]];

    // Before any practice: everything is "never practised", no activity, no evidence.
    let p = await progress(user);
    expect(p.states).toEqual({ never: 5, struggling: 0, learning: 0, established: 0 });
    expect(p.totalCards).toBe(5);
    expect(p.last30Days).toMatchObject({ answered: 0, correct: 0, cardsPracticed: 0 });
    expect(p.activity).toHaveLength(14);
    expect(p.activity.every((d) => d.answered === 0)).toBe(true);
    expect(p.needsAttention).toEqual([]);

    // Day 0: c1 right, c2 wrong (limit the session to two cards by answering only those: use a deck of 5, answer all)
    await study(user, deck, (id) => id === c1.id);
    p = await progress(user);
    // c1 right once -> learning; c2..c5 wrong -> struggling
    expect(p.states).toEqual({ never: 0, struggling: 4, learning: 1, established: 0 });
    expect(p.last30Days).toMatchObject({ answered: 5, correct: 1, incorrect: 4, partial: 0, automatic: 5, selfAssessed: 0, cardsPracticed: 5 });
    expect(p.activity.at(-1)).toEqual({ date: "2026-03-01", answered: 5, correct: 1 });
    expect(p.needsAttention.map((n) => n.cardId).sort()).toEqual(cards.filter((c) => c.id !== c1.id).map((c) => c.id).sort());
    expect(p.needsAttention[0]).toMatchObject({ lastVerdict: "incorrect", lapses: 0 });

    // Day 1: c1 right again (second correct review) -> still "learning" (needs 3 in a row AND a gap of 14+ days)
    clock = new Date("2026-03-02T10:00:00Z");
    await study(user, null, (id) => id === c1.id);
    p = await progress(user);
    expect(p.states.learning).toBe(1);
    expect(p.states.established).toBe(0);

    // Day 7: third correct review -> interval 15 days -> established
    clock = new Date("2026-03-09T10:00:00Z");
    await study(user, null, (id) => id === c1.id);
    p = await progress(user);
    expect(p.states).toEqual({ never: 0, struggling: 4, learning: 0, established: 1 });
    expect(p.activity.find((d) => d.date === "2026-03-09")).toMatchObject({ answered: 5, correct: 1 });
    expect(p.last30Days.answered).toBe(15);

    // A wrong answer later takes a card OUT of established (one correct answer is not proof, neither is one wrong)
    clock = new Date("2026-03-25T10:00:00Z");
    await study(user, null, () => false);
    p = await progress(user);
    expect(p.states.established).toBe(0);
    expect(p.states.struggling).toBe(5);
    expect(p.needsAttention.find((n) => n.cardId === c1.id)).toMatchObject({ lapses: 1 });
    // 30-day window: 2026-03-01 answers are now 24 days old (inside); 02-... all inside
    expect(p.last30Days.answered).toBe(20);
    void c2;
  });

  it("'established' needs BOTH 3+ correct reviews in a row AND a scheduled gap of 14+ days (checked on stored states, independent of the scheduler)", async () => {
    clock = new Date("2026-06-01T10:00:00Z");
    const { user, cards } = await setup();
    const rows: [number, number, string][] = [
      [3, 14, "correct"], // established
      [3, 13, "correct"], // gap too short
      [2, 30, "correct"], // too few reviews
      [5, 40, "partial"], // last answer not right
    ];
    for (const [i, [reps, interval, verdict]] of rows.entries()) {
      await pool.query(
        `INSERT INTO card_review_state (user_id, card_id, due_at, interval_days, ease, repetitions, lapses, last_reviewed_at, last_verdict)
         VALUES ($1, $2, $3, $4, 2.5, $5, 0, $3, $6)`,
        [user, cards[i]!.id, clock, interval, reps, verdict],
      );
    }
    expect((await progress(user)).states).toEqual({ never: 1, struggling: 1, learning: 2, established: 1 });
  });

  it("counts self-assessed answers separately from automatic ones", async () => {
    clock = new Date("2026-04-01T10:00:00Z");
    const user = await createTestUser(pool, "self");
    const deck = (await asUser(app, user).post("/api/decks").send({ title: "D" })).body.id as string;
    const td = await manual(user, { cardType: "term_definition", prompt: "Define x", answer: "x" });
    await asUser(app, user).post(`/api/decks/${deck}/cards`).send({ cardId: td.id });
    const s = (await asUser(app, user).post("/api/study/sessions").send({ deckId: deck })).body;
    await asUser(app, user).post(`/api/study/sessions/${s.id}/responses`).send({ cardId: td.id, selfGrade: "partial" });
    const p = await progress(user);
    expect(p.last30Days).toMatchObject({ answered: 1, partial: 1, selfAssessed: 1, automatic: 0 });
    expect(p.states.struggling).toBe(1);
    expect(p.needsAttention[0]).toMatchObject({ lastVerdict: "partial" });
  });

  it("ignores drafts, rejected cards and cards in no deck, but counts approved written-answer cards; filters by deck; isolates users", async () => {
    clock = new Date("2026-04-01T10:00:00Z");
    const { user, deck, cards } = await setup();
    const src = (await asUser(app, user).post("/api/sources").send({ title: "S", sourceType: "text", contentText: "Some source text here." })).body.id;
    await createCardService(pool).create(user, { cardType: "term_definition", prompt: "Draft?", answer: "a", sourceRefs: [{ sourceId: src, excerpt: "Some source" }] } as never, "ai_generated");
    const open = await manual(user, { cardType: "open_ended", prompt: "Explain it", answer: "model", rubric: { criteria: ["mentions x"] } });
    await asUser(app, user).post(`/api/decks/${deck}/cards`).send({ cardId: open.id });
    await short(user, "Not in any deck?");
    expect((await progress(user)).totalCards).toBe(cards.length + 1);

    const other = (await asUser(app, user).post("/api/decks").send({ title: "Other" })).body.id as string;
    const extra = await short(user, "Only in other?");
    await asUser(app, user).post(`/api/decks/${other}/cards`).send({ cardId: extra.id });
    expect((await progress(user, `?deckId=${other}`)).totalCards).toBe(1);
    expect((await progress(user, `?deckId=${deck}`)).totalCards).toBe(cards.length + 1);
    const all = await progress(user);
    expect(all.totalCards).toBe(cards.length + 2);
    expect(all.decks.map((d) => [d.title, d.totalCards]).sort()).toEqual([["Deck", cards.length + 1], ["Other", 1]]);

    const stranger = await createTestUser(pool, "stranger");
    expect((await progress(stranger)).totalCards).toBe(0);
    expect((await asUser(app, stranger).get(`/api/progress?deckId=${deck}`)).status).toBe(404);
    expect((await asUser(app, user).get("/api/progress?deckId=nope")).status).toBe(400);
  });

  it("a card removed from its deck after practice still counts through its review state (overall), not for the deck", async () => {
    clock = new Date("2026-05-01T10:00:00Z");
    const { user, deck, cards } = await setup();
    await study(user, deck, () => true);
    await asUser(app, user).delete(`/api/decks/${deck}/cards/${cards[0]!.id}`);
    expect((await progress(user)).totalCards).toBe(5);
    expect((await progress(user, `?deckId=${deck}`)).totalCards).toBe(4);
  });

  it("requires authentication", async () => {
    const res = await (await import("supertest")).default(app).get("/api/progress");
    expect(res.status).toBe(401);
  });
});
