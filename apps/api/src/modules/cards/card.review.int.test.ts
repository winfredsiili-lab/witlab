import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bulkReviewResultSchema } from "@witlab/contracts";
import { asUser, createTestApp, createTestUser, openTestPool } from "../../testing/testDb.js";
import { createCardService } from "./card.service.js";

let pool: pg.Pool;
let app: Express;
let userA: string;
let userB: string;

beforeAll(async () => {
  pool = await openTestPool();
  app = createTestApp(pool);
  userA = await createTestUser(pool, "a");
  userB = await createTestUser(pool, "b");
});
afterAll(async () => {
  await pool.end();
});

async function source(user: string) {
  return (await asUser(app, user).post("/api/sources").send({ title: "S", sourceType: "text", contentText: "Some source text for drafts." })).body.id as string;
}
/** AI drafts can only be created through the service, exactly as the generation service does. */
async function draft(user: string, sourceId: string, prompt = `Q ${Math.random()}?`) {
  return createCardService(pool).create(
    user,
    { cardType: "term_definition", prompt, answer: "A", sourceRefs: [{ sourceId, excerpt: "Some source text" }] } as never,
    "ai_generated",
  );
}
const deck = async (user: string) => (await asUser(app, user).post("/api/decks").send({ title: "D" })).body.id as string;
const status = async (id: string) => (await pool.query("SELECT status FROM cards WHERE id=$1", [id])).rows[0].status as string;
const deckCards = async (id: string) => (await pool.query("SELECT card_id FROM deck_cards WHERE deck_id=$1 ORDER BY position", [id])).rows.map((r) => r.card_id as string);

describe("approve with a deck", () => {
  it("approves and adds to the deck in one step", async () => {
    const d = await draft(userA, await source(userA));
    const deckId = await deck(userA);
    const res = await asUser(app, userA).post(`/api/cards/${d.id}/approve`).send({ deckId });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(await deckCards(deckId)).toEqual([d.id]);
  });

  it("someone else's deck: 404 and the card stays a draft (rolled back)", async () => {
    const d = await draft(userA, await source(userA));
    const foreign = await deck(userB);
    expect((await asUser(app, userA).post(`/api/cards/${d.id}/approve`).send({ deckId: foreign })).status).toBe(404);
    expect(await status(d.id)).toBe("draft");
    expect(await deckCards(foreign)).toEqual([]);
  });

  it("still works with no body, and rejects unknown body fields", async () => {
    const d = await draft(userA, await source(userA));
    expect((await asUser(app, userA).post(`/api/cards/${d.id}/approve`).send({ status: "approved", extra: 1 })).status).toBe(400);
    expect((await asUser(app, userA).post(`/api/cards/${d.id}/approve`)).status).toBe(200);
  });
});

describe("bulk review", () => {
  it("approves many and adds them to the deck in the order given", async () => {
    const s = await source(userA);
    const [x, y, z] = [await draft(userA, s), await draft(userA, s), await draft(userA, s)];
    const deckId = await deck(userA);
    const res = await asUser(app, userA).post("/api/cards/bulk").send({ action: "approve", cardIds: [z.id, x.id, y.id], deckId });
    expect(res.status).toBe(200);
    const body = bulkReviewResultSchema.parse(res.body);
    expect(body.cards.map((c) => c.status)).toEqual(["approved", "approved", "approved"]);
    expect(body.addedToDeckId).toBe(deckId);
    expect(await deckCards(deckId)).toEqual([z.id, x.id, y.id]);
  });

  it("rejects many", async () => {
    const s = await source(userA);
    const [x, y] = [await draft(userA, s), await draft(userA, s)];
    const res = await asUser(app, userA).post("/api/cards/bulk").send({ action: "reject", cardIds: [x.id, y.id] });
    expect(res.body.cards.map((c: { status: string }) => c.status)).toEqual(["rejected", "rejected"]);
    expect(res.body.addedToDeckId).toBeNull();
  });

  it("is all-or-nothing: one card that is not a draft fails the whole request", async () => {
    const s = await source(userA);
    const [x, y] = [await draft(userA, s), await draft(userA, s)];
    await asUser(app, userA).post(`/api/cards/${y.id}/reject`);
    const deckId = await deck(userA);
    const res = await asUser(app, userA).post("/api/cards/bulk").send({ action: "approve", cardIds: [x.id, y.id], deckId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_state");
    expect(await status(x.id)).toBe("draft");
    expect(await deckCards(deckId)).toEqual([]);
  });

  it("is all-or-nothing for a missing or foreign card (404, nothing changed)", async () => {
    const mine = await draft(userA, await source(userA));
    const theirs = await draft(userB, await source(userB));
    const res = await asUser(app, userA).post("/api/cards/bulk").send({ action: "reject", cardIds: [mine.id, theirs.id] });
    expect(res.status).toBe(404);
    expect(await status(mine.id)).toBe("draft");
    expect(await status(theirs.id)).toBe("draft");
    const ghost = await asUser(app, userA).post("/api/cards/bulk").send({ action: "reject", cardIds: [mine.id, "11111111-1111-4111-8111-111111111111"] });
    expect(ghost.status).toBe(404);
    expect(await status(mine.id)).toBe("draft");
  });

  it("validates the request", async () => {
    const d = await draft(userA, await source(userA));
    const deckId = await deck(userA);
    const bad: unknown[] = [
      { action: "approve", cardIds: [] },
      { action: "approve", cardIds: [d.id, d.id] },
      { action: "reject", cardIds: [d.id], deckId },
      { action: "delete", cardIds: [d.id] },
      { action: "approve", cardIds: Array.from({ length: 101 }, () => "11111111-1111-4111-8111-111111111111") },
      { action: "approve", cardIds: ["nope"] },
      { action: "approve", cardIds: [d.id], status: "approved" },
    ];
    for (const body of bad) expect((await asUser(app, userA).post("/api/cards/bulk").send(body as object)).status).toBe(400);
    expect(await status(d.id)).toBe("draft");
  });

  it("two concurrent bulk approvals of the same drafts: exactly one wins, the other gets 409", async () => {
    const s = await source(userA);
    const ids = [(await draft(userA, s)).id, (await draft(userA, s)).id, (await draft(userA, s)).id];
    const d1 = await deck(userA);
    const d2 = await deck(userA);
    const [r1, r2] = await Promise.all([
      asUser(app, userA).post("/api/cards/bulk").send({ action: "approve", cardIds: ids, deckId: d1 }),
      asUser(app, userA).post("/api/cards/bulk").send({ action: "approve", cardIds: [...ids].reverse(), deckId: d2 }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const winner = r1.status === 200 ? d1 : d2;
    const loser = r1.status === 200 ? d2 : d1;
    expect((await deckCards(winner)).length).toBe(3);
    expect(await deckCards(loser)).toEqual([]);
  });

  it("requires authentication", async () => {
    const res = await (await import("supertest")).default(app).post("/api/cards/bulk").send({ action: "reject", cardIds: ["11111111-1111-4111-8111-111111111111"] });
    expect(res.status).toBe(401);
  });
});

describe("review queue filters and editing before approval", () => {
  it("filters by origin and source, and counts correctly", async () => {
    const u = await createTestUser(pool, "filter");
    const s1 = await source(u);
    const s2 = await source(u);
    const a = await draft(u, s1);
    await draft(u, s2);
    await asUser(app, u).post("/api/cards").send({ cardType: "term_definition", prompt: "Manual one?", answer: "x" });
    const bySource = (await asUser(app, u).get(`/api/cards?status=draft&sourceId=${s1}`)).body;
    expect(bySource.total).toBe(1);
    expect(bySource.items[0].id).toBe(a.id);
    const ai = (await asUser(app, u).get("/api/cards?origin=ai_generated")).body;
    expect(ai.total).toBe(2);
    expect((await asUser(app, u).get("/api/cards?origin=manual")).body.total).toBe(1);
    expect((await asUser(app, u).get("/api/cards?sourceId=not-a-uuid")).status).toBe(400);
    // another user's source id returns nothing, not an error
    expect((await asUser(app, userB).get(`/api/cards?sourceId=${s1}`)).body.total).toBe(0);
  });

  it("edit a draft, then approve: the edit is kept, the revision is still 1, provenance intact", async () => {
    const d = await draft(userA, await source(userA));
    const edited = await asUser(app, userA).patch(`/api/cards/${d.id}`).send({ prompt: "A better question?", explanation: "Because." });
    expect(edited.body).toMatchObject({ status: "draft", prompt: "A better question?", revision: 1 });
    const approved = (await asUser(app, userA).post(`/api/cards/${d.id}/approve`)).body;
    expect(approved).toMatchObject({ status: "approved", prompt: "A better question?", explanation: "Because.", revision: 1 });
    expect(approved.sourceRefs).toHaveLength(1);
  });
});
