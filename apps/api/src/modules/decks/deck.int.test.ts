import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deckDetailSchema, deckPageSchema } from "@witlab/contracts";
import { asUser, createTestApp, createTestUser, openTestPool } from "../../testing/testDb.js";
import { createCardService } from "../cards/card.service.js";

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

async function newCard(userId: string, prompt = "Q?"): Promise<string> {
  const res = await asUser(app, userId).post("/api/cards").send({ cardType: "term_definition", prompt, answer: "A" });
  return res.body.id as string;
}

async function newDeck(userId: string, title = "Deck"): Promise<string> {
  const res = await asUser(app, userId).post("/api/decks").send({ title });
  return res.body.id as string;
}

async function newDraft(userId: string): Promise<string> {
  const source = await asUser(app, userId).post("/api/sources").send({ title: "S", sourceType: "text", contentText: "text" });
  const card = await createCardService(pool).create(
    userId,
    { cardType: "term_definition", prompt: "Draft?", answer: "A", sourceRefs: [{ sourceId: source.body.id, excerpt: "text" }] },
    "ai_generated",
  );
  return card.id;
}

describe("decks: create, read, update, delete", () => {
  it("creates a deck and returns it with zero cards", async () => {
    const res = await asUser(app, userA).post("/api/decks").send({ title: "  Cloud basics ", description: "Week 1" });
    expect(res.status).toBe(201);
    const deck = deckDetailSchema.parse(res.body);
    expect(deck).toMatchObject({ title: "Cloud basics", description: "Week 1", cardCount: 0, cards: [] });
  });

  it("lists decks with card counts", async () => {
    const owner = await createTestUser(pool, "lister");
    const deckId = await newDeck(owner, "Counted");
    await asUser(app, owner).post(`/api/decks/${deckId}/cards`).send({ cardId: await newCard(owner) });
    await newDeck(owner, "Empty");

    const page = deckPageSchema.parse((await asUser(app, owner).get("/api/decks")).body);
    expect(page.total).toBe(2);
    expect(page.items.find((d) => d.title === "Counted")?.cardCount).toBe(1);
    expect(page.items.find((d) => d.title === "Empty")?.cardCount).toBe(0);
  });

  it("updates title and description, and can clear the description", async () => {
    const id = await newDeck(userA);
    const res = await asUser(app, userA).patch(`/api/decks/${id}`).send({ title: "New title", description: "Desc" });
    expect(res.body).toMatchObject({ title: "New title", description: "Desc" });
    const cleared = await asUser(app, userA).patch(`/api/decks/${id}`).send({ description: null });
    expect(cleared.body).toMatchObject({ title: "New title", description: null });
  });

  it.each([
    ["blank title", { title: " " }],
    ["title over 120 characters", { title: "x".repeat(121) }],
    ["missing title", { description: "only" }],
  ])("rejects creating a deck with %s", async (_label, body) => {
    const res = await asUser(app, userA).post("/api/decks").send(body);
    expect(res.status).toBe(400);
  });

  it("rejects an empty update", async () => {
    const id = await newDeck(userA);
    expect((await asUser(app, userA).patch(`/api/decks/${id}`).send({})).status).toBe(400);
  });

  it("deleting a deck keeps its cards", async () => {
    const deckId = await newDeck(userA);
    const cardId = await newCard(userA);
    await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId });

    expect((await asUser(app, userA).delete(`/api/decks/${deckId}`)).status).toBe(204);
    expect((await asUser(app, userA).get(`/api/decks/${deckId}`)).status).toBe(404);
    expect((await asUser(app, userA).get(`/api/cards/${cardId}`)).status).toBe(200);
  });
});

describe("decks: membership and the approval rule", () => {
  it("adds approved cards in order and returns them in the deck detail", async () => {
    const deckId = await newDeck(userA);
    const first = await newCard(userA, "First?");
    const second = await newCard(userA, "Second?");
    await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId: first });
    const res = await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId: second });
    expect(res.status).toBe(201);
    const deck = deckDetailSchema.parse(res.body);
    expect(deck.cardCount).toBe(2);
    expect(deck.cards.map((c) => c.prompt)).toEqual(["First?", "Second?"]);
  });

  it("refuses to add a draft card (409) and the deck stays empty", async () => {
    const deckId = await newDeck(userA);
    const draftId = await newDraft(userA);
    const res = await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId: draftId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("card_not_approved");
    expect((await asUser(app, userA).get(`/api/decks/${deckId}`)).body.cardCount).toBe(0);
  });

  it("a draft becomes addable only after explicit approval", async () => {
    const deckId = await newDeck(userA);
    const draftId = await newDraft(userA);
    await asUser(app, userA).post(`/api/cards/${draftId}/approve`);
    const res = await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId: draftId });
    expect(res.status).toBe(201);
  });

  it("refuses to add a rejected card", async () => {
    const deckId = await newDeck(userA);
    const draftId = await newDraft(userA);
    await asUser(app, userA).post(`/api/cards/${draftId}/reject`);
    const res = await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId: draftId });
    expect(res.status).toBe(409);
  });

  it("refuses to add the same card twice", async () => {
    const deckId = await newDeck(userA);
    const cardId = await newCard(userA);
    await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId });
    const again = await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_in_deck");
  });

  it("one card can live in several decks without being copied", async () => {
    const cardId = await newCard(userA);
    const deck1 = await newDeck(userA, "One");
    const deck2 = await newDeck(userA, "Two");
    await asUser(app, userA).post(`/api/decks/${deck1}/cards`).send({ cardId });
    await asUser(app, userA).post(`/api/decks/${deck2}/cards`).send({ cardId });

    const d1 = (await asUser(app, userA).get(`/api/decks/${deck1}`)).body;
    const d2 = (await asUser(app, userA).get(`/api/decks/${deck2}`)).body;
    expect(d1.cards[0].id).toBe(cardId);
    expect(d2.cards[0].id).toBe(cardId);
    const rows = await pool.query("SELECT count(*)::int AS n FROM cards WHERE id = $1", [cardId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("provenance stays attached to a card that is in a deck", async () => {
    const source = await asUser(app, userA).post("/api/sources").send({ title: "Origin", sourceType: "text", contentText: "text" });
    const card = await asUser(app, userA)
      .post("/api/cards")
      .send({ cardType: "term_definition", prompt: "Q?", answer: "A", sourceRefs: [{ sourceId: source.body.id, excerpt: "text" }] });
    const deckId = await newDeck(userA);
    await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId: card.body.id });
    const deck = (await asUser(app, userA).get(`/api/decks/${deckId}`)).body;
    expect(deck.cards[0].sourceRefs[0]).toMatchObject({ sourceId: source.body.id, sourceTitle: "Origin" });
  });

  it("removes a card from a deck without deleting the card", async () => {
    const deckId = await newDeck(userA);
    const cardId = await newCard(userA);
    await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId });
    const res = await asUser(app, userA).delete(`/api/decks/${deckId}/cards/${cardId}`);
    expect(res.status).toBe(200);
    expect(res.body.cardCount).toBe(0);
    expect((await asUser(app, userA).get(`/api/cards/${cardId}`)).status).toBe(200);
    expect((await asUser(app, userA).delete(`/api/decks/${deckId}/cards/${cardId}`)).status).toBe(404);
  });

  it("deleting a card removes it from every deck", async () => {
    const deckId = await newDeck(userA);
    const cardId = await newCard(userA);
    await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId });
    await asUser(app, userA).delete(`/api/cards/${cardId}`);
    expect((await asUser(app, userA).get(`/api/decks/${deckId}`)).body.cardCount).toBe(0);
  });
});

describe("decks: reordering", () => {
  it("reorders the cards", async () => {
    const deckId = await newDeck(userA);
    const a = await newCard(userA, "A?");
    const b = await newCard(userA, "B?");
    const c = await newCard(userA, "C?");
    for (const id of [a, b, c]) await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId: id });

    const res = await asUser(app, userA).put(`/api/decks/${deckId}/cards/order`).send({ cardIds: [c, a, b] });
    expect(res.status).toBe(200);
    expect(res.body.cards.map((card: { prompt: string }) => card.prompt)).toEqual(["C?", "A?", "B?"]);
    const reread = await asUser(app, userA).get(`/api/decks/${deckId}`);
    expect(reread.body.cards.map((card: { prompt: string }) => card.prompt)).toEqual(["C?", "A?", "B?"]);
  });

  it("rejects an order that omits, repeats or adds cards", async () => {
    const deckId = await newDeck(userA);
    const a = await newCard(userA);
    const b = await newCard(userA);
    const outsider = await newCard(userA);
    for (const id of [a, b]) await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId: id });

    for (const cardIds of [[a], [a, a], [a, b, outsider], [a, outsider]]) {
      const res = await asUser(app, userA).put(`/api/decks/${deckId}/cards/order`).send({ cardIds });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_order");
    }
  });
});

describe("decks: ownership isolation", () => {
  it("another user cannot read, edit, delete or change the membership of a deck", async () => {
    const deckId = await newDeck(userA, "Private");
    const cardId = await newCard(userA);
    await asUser(app, userA).post(`/api/decks/${deckId}/cards`).send({ cardId });

    expect((await asUser(app, userB).get(`/api/decks/${deckId}`)).status).toBe(404);
    expect((await asUser(app, userB).patch(`/api/decks/${deckId}`).send({ title: "Hijack" })).status).toBe(404);
    expect((await asUser(app, userB).delete(`/api/decks/${deckId}`)).status).toBe(404);
    expect((await asUser(app, userB).delete(`/api/decks/${deckId}/cards/${cardId}`)).status).toBe(404);
    expect((await asUser(app, userB).put(`/api/decks/${deckId}/cards/order`).send({ cardIds: [cardId] })).status).toBe(404);
    expect((await asUser(app, userB).post(`/api/decks/${deckId}/cards`).send({ cardId: await newCard(userB) })).status).toBe(404);

    const listB = (await asUser(app, userB).get("/api/decks")).body.items.map((d: { id: string }) => d.id);
    expect(listB).not.toContain(deckId);

    const intact = (await asUser(app, userA).get(`/api/decks/${deckId}`)).body;
    expect(intact).toMatchObject({ title: "Private", cardCount: 1 });
  });

  it("a user cannot put someone else's card into their own deck", async () => {
    const othersCard = await newCard(userA);
    const myDeck = await newDeck(userB);
    const res = await asUser(app, userB).post(`/api/decks/${myDeck}/cards`).send({ cardId: othersCard });
    expect(res.status).toBe(404);
    expect((await asUser(app, userB).get(`/api/decks/${myDeck}`)).body.cardCount).toBe(0);
  });
});
