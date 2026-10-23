import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { overviewSchema, sessionDetailSchema, submitResultSchema, type SessionDetail } from "@witlab/contracts";
import { asUser, createTestApp, createTestUser, openTestPool } from "../../testing/testDb.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date("2026-03-01T09:00:00.000Z");

let pool: pg.Pool;
let app: Express;
let clock: Date;
let userA: string;
let userB: string;

beforeAll(async () => {
  pool = await openTestPool();
  app = createTestApp(pool, () => clock);
  userA = await createTestUser(pool, "a");
  userB = await createTestUser(pool, "b");
});

beforeEach(() => {
  clock = new Date(T0);
});

afterAll(async () => {
  await pool.end();
});

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

// --- card fixtures -------------------------------------------------------

const shortCard = { cardType: "short_answer", prompt: "What does VM stand for?", answer: "VM", answerSpec: { acceptedAnswers: ["virtual machine"] } };
const mcCard = {
  cardType: "multiple_choice",
  prompt: "Which is isolated?",
  answer: "Beta",
  answerSpec: { choices: ["Alpha", "Beta", "Gamma"], correctIndex: 1 },
  explanation: "Beta is the isolated one.",
};
const numericCard = { cardType: "numeric", prompt: "Value of x?", answer: "10", answerSpec: { value: 10, tolerance: 0.5 } };
const termCard = { cardType: "term_definition", prompt: "Define availability zone", answer: "An isolated location within a region." };
const openCard = { cardType: "open_ended", prompt: "Explain resilience", answer: "Failures are contained.", rubric: { criteria: ["mentions isolation"] } };

async function makeDeck(userId: string, cards: Array<Record<string, unknown>>, title = "Deck"): Promise<{ deckId: string; cardIds: string[] }> {
  const deck = await asUser(app, userId).post("/api/decks").send({ title });
  const cardIds: string[] = [];
  for (const card of cards) {
    const created = await asUser(app, userId).post("/api/cards").send(card);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    cardIds.push(created.body.id);
    // open_ended cards can be in decks too; they are just not studyable in Recall yet.
    const added = await asUser(app, userId).post(`/api/decks/${deck.body.id}/cards`).send({ cardId: created.body.id });
    expect(added.status).toBe(201);
  }
  return { deckId: deck.body.id, cardIds };
}

async function startSession(userId: string, deckId?: string, extra: Record<string, unknown> = {}): Promise<SessionDetail> {
  const res = await asUser(app, userId).post("/api/study/sessions").send({ deckId, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return sessionDetailSchema.parse(res.body);
}

const answer = (userId: string, sessionId: string, body: Record<string, unknown>) =>
  asUser(app, userId).post(`/api/study/sessions/${sessionId}/responses`).send(body);

async function reviewState(userId: string, cardId: string) {
  const res = await pool.query("SELECT *, ease::float8 AS ease_n FROM card_review_state WHERE user_id = $1 AND card_id = $2", [userId, cardId]);
  return res.rows[0] as undefined | { due_at: Date; interval_days: number; repetitions: number; lapses: number; last_verdict: string; ease_n: number };
}

// --- starting a session --------------------------------------------------

describe("starting a session", () => {
  it("queues the deck's new cards in deck order, each with a reason, and excludes cards that cannot be studied yet", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, openCard, mcCard, termCard]);
    const session = await startSession(userA, deckId);

    expect(session).toMatchObject({ mode: "recall", status: "active", deckId, progress: { total: 3, answered: 0 } });
    expect(session.current?.cardId).toBe(cardIds[0]);
    expect(session.current?.reason).toMatch(/New card/);
    expect(session.results).toEqual([]);
    // The open-ended card is in the deck but not eligible for Recall.
    const detail = JSON.stringify(session);
    expect(detail).not.toContain(cardIds[1]);
  });

  it("does not leak the correct answer before answering (auto cards), but reveals it for self-assessed cards", async () => {
    const { deckId } = await makeDeck(userA, [shortCard, mcCard, numericCard, termCard]);
    let session = await startSession(userA, deckId);
    const seen: Record<string, unknown> = {};

    while (session.current) {
      const item = session.current;
      seen[item.cardType] = item;
      // Only the card being asked is checked. Answered cards legitimately show their answers in `results`.
      const body = JSON.stringify(item);
      if (item.evaluation === "auto") {
        expect(body).not.toContain("correctIndex");
        expect(body).not.toContain("acceptedAnswers");
        expect(body).not.toContain("virtual machine");
        expect(item.revealAnswer).toBeNull();
      } else {
        expect(item.revealAnswer).toBe(termCard.answer);
      }
      const submit =
        item.cardType === "multiple_choice"
          ? { selectedIndex: 0 }
          : item.cardType === "term_definition"
            ? { selfGrade: "correct" }
            : { answer: "0" };
      const res = await answer(userA, session.id, { cardId: item.cardId, ...submit });
      session = submitResultSchema.parse(res.body).session;
    }

    expect((seen.multiple_choice as { choices: string[] }).choices).toEqual(["Alpha", "Beta", "Gamma"]);
    expect((seen.short_answer as { choices: unknown }).choices).toBeNull();
  });

  it("respects the limit", async () => {
    const { deckId } = await makeDeck(userA, [shortCard, mcCard, numericCard, termCard]);
    const session = await startSession(userA, deckId, { limit: 2 });
    expect(session.progress.total).toBe(2);
  });

  it("unknown modes cannot be started; written-answer modes and hybrid need an AI key (503) while recall keeps working", async () => {
    const { deckId } = await makeDeck(userA, [shortCard]);
    for (const mode of ["nonsense", "mixed"]) {
      const res = await asUser(app, userA).post("/api/study/sessions").send({ deckId, mode });
      expect(res.status, mode).toBe(400);
    }
    for (const mode of ["connections", "explain", "apply", "hybrid"]) {
      const res = await asUser(app, userA).post("/api/study/sessions").send({ deckId, mode });
      expect(res.status, mode).toBe(503);
      expect(res.body.error.code).toBe("ai_not_configured");
    }
    expect((await asUser(app, userA).post("/api/study/sessions").send({ deckId, mode: "recall" })).status).toBe(201);
  });

  it("returns 409 nothing_to_study for an empty deck or one with only open-ended cards", async () => {
    const empty = await makeDeck(userA, []);
    const emptyRes = await asUser(app, userA).post("/api/study/sessions").send({ deckId: empty.deckId });
    expect(emptyRes.status).toBe(409);
    expect(emptyRes.body.error.code).toBe("nothing_to_study");

    const onlyOpen = await makeDeck(userA, [openCard]);
    const openRes = await asUser(app, userA).post("/api/study/sessions").send({ deckId: onlyOpen.deckId });
    expect(openRes.status).toBe(409);
    expect(openRes.body.error.message).toMatch(/no approved cards that can be studied in Recall mode/);
  });

  it("rejects unknown fields and invalid input", async () => {
    const { deckId } = await makeDeck(userA, [shortCard]);
    expect((await asUser(app, userA).post("/api/study/sessions").send({ deckId, status: "completed" })).status).toBe(400);
    expect((await asUser(app, userA).post("/api/study/sessions").send({ deckId, limit: 0 })).status).toBe(400);
    expect((await asUser(app, userA).post("/api/study/sessions").send({ deckId: "nope" })).status).toBe(400);
  });
});

// --- answering -----------------------------------------------------------

describe("answering each card type", () => {
  it("multiple choice: correct and incorrect, with feedback and explanation, persisted as evidence", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [mcCard, mcCard]);
    const session = await startSession(userA, deckId);

    const right = submitResultSchema.parse((await answer(userA, session.id, { cardId: cardIds[0], selectedIndex: 1 })).body);
    expect(right.result).toMatchObject({ verdict: "correct", evalMethod: "deterministic", correctAnswer: "Beta", explanation: "Beta is the isolated one." });

    const wrong = submitResultSchema.parse((await answer(userA, session.id, { cardId: cardIds[1], selectedIndex: 2 })).body);
    expect(wrong.result.verdict).toBe("incorrect");
    expect(wrong.result.feedback).toContain("Gamma");
    expect(wrong.result.feedback).toContain("Beta");

    const rows = await pool.query("SELECT card_id, verdict, eval_method, submitted_answer, card_revision FROM study_responses WHERE session_id = $1 ORDER BY card_id", [session.id]);
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.find((r) => r.card_id === cardIds[0])).toMatchObject({ verdict: "correct", eval_method: "deterministic", submitted_answer: "Beta", card_revision: 1 });
  });

  it("numeric: tolerance applies, and unreadable text is a 400 that records nothing", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [numericCard]);
    const session = await startSession(userA, deckId);

    const bad = await answer(userA, session.id, { cardId: cardIds[0], answer: "ten" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_answer");
    expect((await pool.query("SELECT 1 FROM study_responses WHERE session_id = $1", [session.id])).rowCount).toBe(0);
    expect(await reviewState(userA, cardIds[0]!)).toBeUndefined();
    expect((await asUser(app, userA).get(`/api/study/sessions/${session.id}`)).body.status).toBe("active");

    const good = submitResultSchema.parse((await answer(userA, session.id, { cardId: cardIds[0], answer: "10.4" })).body);
    expect(good.result.verdict).toBe("correct");
  });

  it("short answer: accepted variants are correct, anything else is incorrect", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, shortCard]);
    const session = await startSession(userA, deckId);
    const a = submitResultSchema.parse((await answer(userA, session.id, { cardId: cardIds[0], answer: "  Virtual Machine. " })).body);
    expect(a.result.verdict).toBe("correct");
    const b = submitResultSchema.parse((await answer(userA, session.id, { cardId: cardIds[1], answer: "container" })).body);
    expect(b.result.verdict).toBe("incorrect");
    expect(b.result.feedback).toContain("virtual machine");
  });

  it("self-assessed cards need an explicit self-grade, which is recorded as self_assessed", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [termCard]);
    const session = await startSession(userA, deckId);

    const missing = await answer(userA, session.id, { cardId: cardIds[0], answer: "a place" });
    expect(missing.status).toBe(400);
    expect((await pool.query("SELECT 1 FROM study_responses WHERE session_id = $1", [session.id])).rowCount).toBe(0);

    const ok = submitResultSchema.parse((await answer(userA, session.id, { cardId: cardIds[0], answer: "a place", selfGrade: "partial" })).body);
    expect(ok.result).toMatchObject({ verdict: "partial", evalMethod: "self_assessed" });
  });

  it("rejects fields that do not belong to the card type and unknown fields", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard]);
    const session = await startSession(userA, deckId);
    // The client cannot grade an automatic card itself.
    expect((await answer(userA, session.id, { cardId: cardIds[0], answer: "VM", selfGrade: "correct" })).status).toBe(400);
    expect((await answer(userA, session.id, { cardId: cardIds[0], verdict: "correct" })).status).toBe(400);
    expect((await answer(userA, session.id, { cardId: cardIds[1], selectedIndex: 9 })).status).toBe(400);
    expect((await answer(userA, session.id, { cardId: cardIds[1], answer: "Beta" })).status).toBe(400);
    expect((await pool.query("SELECT 1 FROM study_responses WHERE session_id = $1", [session.id])).rowCount).toBe(0);
  });

  it("a blank answer on an automatic card is recorded as incorrect (I don't know)", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard]);
    const session = await startSession(userA, deckId);
    const res = submitResultSchema.parse((await answer(userA, session.id, { cardId: cardIds[0], answer: "" })).body);
    expect(res.result.verdict).toBe("incorrect");
    expect(res.result.feedback).toContain("No answer was given");
  });

  it("records the card revision that was answered", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard]);
    const session = await startSession(userA, deckId);
    await asUser(app, userA).patch(`/api/cards/${cardIds[0]}`).send({ prompt: "Reworded: VM stands for?" });
    await answer(userA, session.id, { cardId: cardIds[0], answer: "vm" });
    const row = await pool.query("SELECT card_revision FROM study_responses WHERE session_id = $1", [session.id]);
    expect(row.rows[0].card_revision).toBe(2);
  });
});

describe("answer rules", () => {
  it("a card can be answered only once per session, even with simultaneous submissions", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard]);
    const session = await startSession(userA, deckId);

    const attempts = await Promise.all(Array.from({ length: 8 }, () => answer(userA, session.id, { cardId: cardIds[0], answer: "vm" })));
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
    for (const rejected of attempts.filter((r) => r.status !== 201)) {
      expect(rejected.status).toBe(409);
      expect(rejected.body.error.code).toBe("already_answered");
    }
    expect((await pool.query("SELECT 1 FROM study_responses WHERE session_id = $1", [session.id])).rowCount).toBe(1);
    expect((await reviewState(userA, cardIds[0]!))?.repetitions).toBe(1);
  });

  it("answers within one session are serialised on the session row (deterministic check of the lock)", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard]);
    const session = await startSession(userA, deckId);

    // Another connection holds a lock on the session row, as a concurrent answer would. FOR NO KEY UPDATE is used
    // on purpose: it does not block the foreign-key checks of an insert, so only the service's own explicit
    // row lock (FOR UPDATE) can make the answer wait. Without that lock the answer would complete immediately.
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM study_sessions WHERE id = $1 FOR NO KEY UPDATE", [session.id]);

    let settled = false;
    const pending = Promise.resolve(answer(userA, session.id, { cardId: cardIds[0], answer: "vm" })).then((res) => {
      settled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled, "the answer must wait while the session row is locked").toBe(false);

    await holder.query("COMMIT");
    holder.release();
    expect((await pending).status).toBe(201);
  });

  it("a card that is not part of the session cannot be answered", async () => {
    const { deckId } = await makeDeck(userA, [shortCard]);
    const other = await makeDeck(userA, [mcCard]);
    const session = await startSession(userA, deckId);
    const res = await answer(userA, session.id, { cardId: other.cardIds[0], selectedIndex: 1 });
    expect(res.status).toBe(404);
  });

  it("the session completes automatically after the last card, and then takes no more answers", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard]);
    const session = await startSession(userA, deckId);
    await answer(userA, session.id, { cardId: cardIds[0], answer: "vm" });
    const last = submitResultSchema.parse((await answer(userA, session.id, { cardId: cardIds[1], selectedIndex: 1 })).body);

    expect(last.session).toMatchObject({ status: "completed", current: null, progress: { total: 2, answered: 2, correct: 2 } });
    expect(last.session.endedAt).not.toBeNull();
    expect(last.session.results.map((r) => r.verdict)).toEqual(["correct", "correct"]);

    const late = await answer(userA, session.id, { cardId: cardIds[0], answer: "vm" });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("session_not_active");
  });

  it("each answer advances to the next card and reports progress", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard, numericCard]);
    const session = await startSession(userA, deckId);
    const res = submitResultSchema.parse((await answer(userA, session.id, { cardId: cardIds[0], answer: "nope" })).body);
    expect(res.session.progress).toEqual({ total: 3, answered: 1, correct: 0, partial: 0, incorrect: 1 });
    expect(res.session.current?.cardId).toBe(cardIds[1]);
  });
});

describe("ending a session", () => {
  it("ending early abandons it, and it can be fetched but not answered", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard]);
    const session = await startSession(userA, deckId);
    await answer(userA, session.id, { cardId: cardIds[0], answer: "vm" });

    const ended = await asUser(app, userA).post(`/api/study/sessions/${session.id}/end`);
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ status: "abandoned", current: null, progress: { answered: 1, total: 2 } });
    expect((await answer(userA, session.id, { cardId: cardIds[1], selectedIndex: 1 })).status).toBe(409);
    // Answered work is kept.
    expect((await reviewState(userA, cardIds[0]!))?.repetitions).toBe(1);
    // Ending twice is harmless.
    expect((await asUser(app, userA).post(`/api/study/sessions/${session.id}/end`)).body.status).toBe("abandoned");
  });

  it("an active session can be found again to resume", async () => {
    const { deckId } = await makeDeck(userA, [shortCard]);
    const session = await startSession(userA, deckId);
    const list = await asUser(app, userA).get(`/api/study/sessions?status=active&deckId=${deckId}`);
    expect(list.body.items.map((s: { id: string }) => s.id)).toContain(session.id);
    expect(list.body.items[0]).toMatchObject({ total: 1, answered: 0, deckTitle: "Deck" });
  });
});

// --- scheduling, end to end ----------------------------------------------

describe("scheduling through the API (controlled clock)", () => {
  it("correct answers push the card out: 1 day, then 6 days", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard]);
    const card = cardIds[0]!;

    let session = await startSession(userA, deckId);
    const first = submitResultSchema.parse((await answer(userA, session.id, { cardId: card, answer: "vm" })).body);
    expect(first.nextReview).toMatchObject({ intervalDays: 1, dueAt: new Date(T0.getTime() + DAY).toISOString() });
    expect(first.nextReview.reason).toBe("Scheduled again in 1 day.");

    // Not due yet.
    advance(HOUR);
    const early = await asUser(app, userA).post("/api/study/sessions").send({ deckId });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("nothing_to_study");
    expect(early.body.error.message).toContain(new Date(T0.getTime() + DAY).toISOString());

    // Due after a day, with an explanation.
    advance(DAY);
    session = await startSession(userA, deckId);
    expect(session.current?.reason).toBe("Last answered correctly 1 day ago; the 1-day interval has passed.".replace("1 day ago", "25 hours ago"));
    const second = submitResultSchema.parse((await answer(userA, session.id, { cardId: card, answer: "vm" })).body);
    expect(second.nextReview.intervalDays).toBe(6);
    expect(await reviewState(userA, card)).toMatchObject({ repetitions: 2, interval_days: 6, lapses: 0 });
  });

  it("a wrong answer comes back in about 10 minutes and is explained", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard]);
    const card = cardIds[0]!;
    let session = await startSession(userA, deckId);
    const wrong = submitResultSchema.parse((await answer(userA, session.id, { cardId: card, answer: "nope" })).body);
    expect(wrong.nextReview.dueAt).toBe(new Date(T0.getTime() + 10 * MIN).toISOString());
    expect(wrong.nextReview.reason).toMatch(/10 minutes/);

    advance(5 * MIN);
    expect((await asUser(app, userA).post("/api/study/sessions").send({ deckId })).status).toBe(409);

    advance(6 * MIN);
    session = await startSession(userA, deckId);
    expect(session.current?.reason).toBe("Answered incorrectly less than an hour ago; due for another try.");
  });

  it("forgetting a card that was known counts as a lapse and restarts the ladder", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard]);
    const card = cardIds[0]!;
    let session = await startSession(userA, deckId);
    await answer(userA, session.id, { cardId: card, answer: "vm" });
    advance(DAY + MIN);
    session = await startSession(userA, deckId);
    await answer(userA, session.id, { cardId: card, answer: "wrong" });
    expect(await reviewState(userA, card)).toMatchObject({ repetitions: 0, interval_days: 0, lapses: 1, last_verdict: "incorrect" });
  });

  it("confidence is stored as evidence but never changes the verdict or the schedule", async () => {
    const low = await makeDeck(userA, [shortCard, shortCard]);
    const session = await startSession(userA, low.deckId);
    // Same correct answer with opposite confidence, and same wrong answer with opposite confidence.
    const a = submitResultSchema.parse((await answer(userA, session.id, { cardId: low.cardIds[0], answer: "vm", confidence: 1 })).body);
    const b = submitResultSchema.parse((await answer(userA, session.id, { cardId: low.cardIds[1], answer: "vm", confidence: 5 })).body);
    expect(a.result.verdict).toBe("correct");
    expect(b.result.verdict).toBe("correct");
    // The complete stored schedule is identical whatever the confidence was (comparing every field, because
    // a correct and a partial answer on a new card share the same 1-day interval).
    const stateOf = async (cardId: string) => {
      const s = await reviewState(userA, cardId);
      return { repetitions: s!.repetitions, lapses: s!.lapses, interval: s!.interval_days, ease: s!.ease_n, verdict: s!.last_verdict };
    };
    expect(await stateOf(low.cardIds[0]!)).toEqual({ repetitions: 1, lapses: 0, interval: 1, ease: 2.5, verdict: "correct" });
    expect(await stateOf(low.cardIds[1]!)).toEqual(await stateOf(low.cardIds[0]!));

    const wrongHigh = await makeDeck(userA, [shortCard]);
    const s2 = await startSession(userA, wrongHigh.deckId);
    const c = submitResultSchema.parse((await answer(userA, s2.id, { cardId: wrongHigh.cardIds[0], answer: "nope", confidence: 5 })).body);
    expect(c.result.verdict).toBe("incorrect");
    expect(c.nextReview.intervalDays).toBe(0);
    expect(await stateOf(wrongHigh.cardIds[0]!)).toEqual({ repetitions: 0, lapses: 0, interval: 0, ease: 2.3, verdict: "incorrect" });

    const stored = await pool.query("SELECT confidence FROM study_responses WHERE session_id = $1 ORDER BY card_id", [session.id]);
    expect(stored.rows.map((r) => r.confidence).sort()).toEqual([1, 5]);
    expect((await answer(userA, s2.id, { cardId: wrongHigh.cardIds[0], answer: "x", confidence: 9 })).status).toBe(400);
  });

  it("due cards come before new cards, most overdue first", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard, numericCard]);
    // Card 1 became due 3 days ago, card 2 became due 2 days ago, card 0 was never practised.
    await pool.query(
      `INSERT INTO card_review_state (user_id, card_id, due_at, interval_days, ease, repetitions, lapses, last_reviewed_at, last_verdict)
       VALUES ($1, $2, $4, 1, 2.5, 1, 0, $5, 'correct'), ($1, $3, $6, 1, 2.5, 1, 0, $5, 'correct')`,
      [userA, cardIds[1], cardIds[2], new Date(T0.getTime() - 3 * DAY), new Date(T0.getTime() - 4 * DAY), new Date(T0.getTime() - 2 * DAY)],
    );
    const s = await startSession(userA, deckId);
    expect(s.current?.cardId).toBe(cardIds[1]); // the one due 3 days ago comes first
    const order = (await pool.query("SELECT card_id FROM study_session_items WHERE session_id = $1 ORDER BY position", [s.id])).rows.map((r) => r.card_id);
    expect(order).toEqual([cardIds[1], cardIds[2], cardIds[0]]); // due (most overdue first), then new
  });
});

describe("overview and global review", () => {
  it("overview counts new and due cards for a deck", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard, openCard]);
    expect(overviewSchema.parse((await asUser(app, userA).get(`/api/study/overview?deckId=${deckId}`)).body)).toEqual({
      dueCount: 0,
      newCount: 2,
      eligibleCount: 2,
      nextDueAt: null,
    });

    const session = await startSession(userA, deckId);
    await answer(userA, session.id, { cardId: cardIds[0], answer: "vm" });
    const after = overviewSchema.parse((await asUser(app, userA).get(`/api/study/overview?deckId=${deckId}`)).body);
    expect(after).toMatchObject({ dueCount: 0, newCount: 1, eligibleCount: 2, nextDueAt: new Date(T0.getTime() + DAY).toISOString() });

    advance(2 * DAY);
    expect(overviewSchema.parse((await asUser(app, userA).get(`/api/study/overview?deckId=${deckId}`)).body)).toMatchObject({ dueCount: 1, newCount: 1 });
  });

  it("global review gathers due cards from every deck, and never includes new cards", async () => {
    const user = await createTestUser(pool, "global");
    const d1 = await makeDeck(user, [shortCard], "One");
    const d2 = await makeDeck(user, [mcCard], "Two");
    const untouched = await makeDeck(user, [numericCard], "Untouched");

    for (const [deck, body] of [
      [d1, { answer: "vm" }],
      [d2, { selectedIndex: 1 }],
    ] as const) {
      const s = await startSession(user, deck.deckId);
      await answer(user, s.id, { cardId: deck.cardIds[0], ...body });
    }

    const none = await asUser(app, user).post("/api/study/sessions").send({});
    expect(none.status).toBe(409);

    advance(2 * DAY);
    expect(overviewSchema.parse((await asUser(app, user).get("/api/study/overview")).body)).toMatchObject({ dueCount: 2, newCount: 0 });
    const global = await startSession(user);
    expect(global).toMatchObject({ deckId: null, deckTitle: null, progress: { total: 2 } });
    const ids = (await pool.query("SELECT card_id FROM study_session_items WHERE session_id = $1", [global.id])).rows.map((r) => r.card_id);
    expect(ids.sort()).toEqual([d1.cardIds[0], d2.cardIds[0]].sort());
    expect(ids).not.toContain(untouched.cardIds[0]);
  });
});

// --- ownership -----------------------------------------------------------

describe("ownership isolation", () => {
  it("another user cannot start from, read, answer or end someone else's session or deck", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard]);
    const session = await startSession(userA, deckId);

    expect((await asUser(app, userB).post("/api/study/sessions").send({ deckId })).status).toBe(404);
    expect((await asUser(app, userB).get(`/api/study/overview?deckId=${deckId}`)).status).toBe(404);
    expect((await asUser(app, userB).get(`/api/study/sessions/${session.id}`)).status).toBe(404);
    expect((await answer(userB, session.id, { cardId: cardIds[0], answer: "vm" })).status).toBe(404);
    expect((await asUser(app, userB).post(`/api/study/sessions/${session.id}/end`)).status).toBe(404);

    const listB = await asUser(app, userB).get("/api/study/sessions");
    expect(listB.body.items.map((s: { id: string }) => s.id)).not.toContain(session.id);

    // Nothing was recorded or changed for the real owner.
    expect((await pool.query("SELECT 1 FROM study_responses WHERE session_id = $1", [session.id])).rowCount).toBe(0);
    const intact = await asUser(app, userA).get(`/api/study/sessions/${session.id}`);
    expect(intact.body.status).toBe("active");
  });

  it("each user's review schedule is independent", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard]);
    const session = await startSession(userA, deckId);
    await answer(userA, session.id, { cardId: cardIds[0], answer: "vm" });
    expect(await reviewState(userB, cardIds[0]!)).toBeUndefined();
    expect(await reviewState(userA, cardIds[0]!)).toBeDefined();
  });
});

// --- deletion ------------------------------------------------------------

describe("deletion", () => {
  it("deleting a card removes its schedule, session items and responses", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard, mcCard]);
    const session = await startSession(userA, deckId);
    await answer(userA, session.id, { cardId: cardIds[0], answer: "vm" });

    expect((await asUser(app, userA).delete(`/api/cards/${cardIds[0]}`)).status).toBe(204);
    expect(await reviewState(userA, cardIds[0]!)).toBeUndefined();
    expect((await pool.query("SELECT 1 FROM study_responses WHERE card_id = $1", [cardIds[0]])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM study_session_items WHERE card_id = $1", [cardIds[0]])).rowCount).toBe(0);

    // The session continues with what is left.
    const after = sessionDetailSchema.parse((await asUser(app, userA).get(`/api/study/sessions/${session.id}`)).body);
    expect(after.progress.total).toBe(1);
    expect(after.current?.cardId).toBe(cardIds[1]);
  });

  it("deleting a deck keeps its study history and the cards' schedules", async () => {
    const { deckId, cardIds } = await makeDeck(userA, [shortCard]);
    const session = await startSession(userA, deckId);
    await answer(userA, session.id, { cardId: cardIds[0], answer: "vm" });

    expect((await asUser(app, userA).delete(`/api/decks/${deckId}`)).status).toBe(204);
    const after = sessionDetailSchema.parse((await asUser(app, userA).get(`/api/study/sessions/${session.id}`)).body);
    expect(after).toMatchObject({ deckId: null, deckTitle: null, status: "completed", progress: { answered: 1 } });
    expect(await reviewState(userA, cardIds[0]!)).toBeDefined();
  });
});
