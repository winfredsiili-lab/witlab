import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardPageSchema, cardSchema, type CreateCardInput } from "@witlab/contracts";
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

const definitionCard = { cardType: "term_definition", prompt: "What is an availability zone?", answer: "An isolated location within a region." };

async function createSource(userId: string, title = "Cloud basics"): Promise<string> {
  const res = await asUser(app, userId).post("/api/sources").send({ title, sourceType: "text", contentText: "Zones are isolated." });
  return res.body.id as string;
}

/** AI-generated drafts can only come from the service layer; the HTTP API never creates them. */
async function createDraft(userId: string, sourceId: string): Promise<string> {
  const input: CreateCardInput = {
    cardType: "term_definition",
    prompt: "Draft question?",
    answer: "Draft answer",
    sourceRefs: [{ sourceId, excerpt: "Zones are isolated.", pageStart: 1, pageEnd: 1 }],
  };
  const card = await createCardService(pool).create(userId, input, "ai_generated");
  return card.id;
}

describe("cards: manual creation", () => {
  it("creates a manual card that is approved immediately, revision 1", async () => {
    const res = await asUser(app, userA).post("/api/cards").send(definitionCard);
    expect(res.status).toBe(201);
    const card = cardSchema.parse(res.body);
    expect(card.status).toBe("approved");
    expect(card.origin).toBe("manual");
    expect(card.revision).toBe(1);
    expect(card.approvedAt).not.toBeNull();
    expect(card.sourceRefs).toEqual([]);
  });

  it("stores type-specific data and returns it normalised", async () => {
    const res = await asUser(app, userA)
      .post("/api/cards")
      .send({
        cardType: "multiple_choice",
        prompt: "Which is isolated?",
        answer: "Zone",
        answerSpec: { choices: [" Zone ", "Planet"], correctIndex: 0 },
      });
    expect(res.status).toBe(201);
    expect(res.body.answerSpec).toEqual({ choices: ["Zone", "Planet"], correctIndex: 0 });
  });

  it("cannot be used to create a draft or smuggle in status/origin fields", async () => {
    const res = await asUser(app, userA)
      .post("/api/cards")
      .send({ ...definitionCard, status: "draft", origin: "ai_generated" });
    expect(res.status).toBe(400);
    const plain = await asUser(app, userA).post("/api/cards").send(definitionCard);
    expect(plain.body).toMatchObject({ status: "approved", origin: "manual" });
  });

  it.each([
    ["multiple_choice without spec", { cardType: "multiple_choice", prompt: "Q", answer: "A" }],
    ["numeric with negative tolerance", { cardType: "numeric", prompt: "Q", answer: "1", answerSpec: { value: 1, tolerance: -1 } }],
    ["rubric on a term_definition card", { ...definitionCard, rubric: { criteria: ["x"] } }],
    ["unknown card type", { ...definitionCard, cardType: "essay" }],
    ["blank prompt", { ...definitionCard, prompt: "  " }],
  ])("rejects %s", async (_label, body) => {
    const res = await asUser(app, userA).post("/api/cards").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("cards: draft, approve, reject", () => {
  it("AI-generated cards start as drafts, carry provenance, and need explicit approval", async () => {
    const sourceId = await createSource(userA);
    const draftId = await createDraft(userA, sourceId);

    const draft = (await asUser(app, userA).get(`/api/cards/${draftId}`)).body;
    expect(draft.status).toBe("draft");
    expect(draft.origin).toBe("ai_generated");
    expect(draft.approvedAt).toBeNull();
    expect(draft.sourceRefs).toHaveLength(1);
    expect(draft.sourceRefs[0]).toMatchObject({ sourceId, sourceTitle: "Cloud basics", excerpt: "Zones are isolated.", pageStart: 1 });

    const approved = await asUser(app, userA).post(`/api/cards/${draftId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.approvedAt).not.toBeNull();
  });

  it("refuses AI-generated cards that have no source reference", async () => {
    await expect(
      createCardService(pool).create(userA, { cardType: "term_definition", prompt: "Q", answer: "A" }, "ai_generated"),
    ).rejects.toMatchObject({ status: 400, code: "provenance_required" });
  });

  it("rejecting a draft keeps it but marks it rejected; it cannot then be approved or edited", async () => {
    const draftId = await createDraft(userA, await createSource(userA));
    const rejected = await asUser(app, userA).post(`/api/cards/${draftId}/reject`);
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rejected");

    expect((await asUser(app, userA).post(`/api/cards/${draftId}/approve`)).status).toBe(409);
    expect((await asUser(app, userA).patch(`/api/cards/${draftId}`).send({ prompt: "x?" })).status).toBe(409);
  });

  it("only drafts can be approved or rejected", async () => {
    const manual = (await asUser(app, userA).post("/api/cards").send(definitionCard)).body;
    const approve = await asUser(app, userA).post(`/api/cards/${manual.id}/approve`);
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe("invalid_state");
    expect((await asUser(app, userA).post(`/api/cards/${manual.id}/reject`)).status).toBe(409);
  });

  it("filters the list by status", async () => {
    const owner = await createTestUser(pool, "filter");
    const sourceId = await createSource(owner);
    await createDraft(owner, sourceId);
    await asUser(app, owner).post("/api/cards").send(definitionCard);

    const drafts = cardPageSchema.parse((await asUser(app, owner).get("/api/cards?status=draft")).body);
    const approved = cardPageSchema.parse((await asUser(app, owner).get("/api/cards?status=approved")).body);
    const all = cardPageSchema.parse((await asUser(app, owner).get("/api/cards")).body);
    expect(drafts.items.map((c) => c.status)).toEqual(["draft"]);
    expect(approved.items.map((c) => c.status)).toEqual(["approved"]);
    expect(all.total).toBe(2);

    expect((await asUser(app, owner).get("/api/cards?status=bogus")).status).toBe(400);
  });
});

describe("cards: editing and revisions", () => {
  it("changing evaluated content of an approved card keeps it approved and bumps the revision", async () => {
    const card = (await asUser(app, userA).post("/api/cards").send(definitionCard)).body;
    const res = await asUser(app, userA).patch(`/api/cards/${card.id}`).send({ prompt: "Define availability zone." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.revision).toBe(2);
    expect(res.body.prompt).toBe("Define availability zone.");
  });

  it("an explanation-only edit or a no-op edit does not bump the revision", async () => {
    const card = (await asUser(app, userA).post("/api/cards").send(definitionCard)).body;
    const explained = await asUser(app, userA).patch(`/api/cards/${card.id}`).send({ explanation: "Because isolation." });
    expect(explained.body.revision).toBe(1);
    expect(explained.body.explanation).toBe("Because isolation.");
    const same = await asUser(app, userA).patch(`/api/cards/${card.id}`).send({ prompt: card.prompt });
    expect(same.body.revision).toBe(1);
  });

  it("editing a draft does not bump the revision", async () => {
    const draftId = await createDraft(userA, await createSource(userA));
    const res = await asUser(app, userA).patch(`/api/cards/${draftId}`).send({ answer: "Better answer" });
    expect(res.body.status).toBe("draft");
    expect(res.body.revision).toBe(1);
    expect(res.body.answer).toBe("Better answer");
  });

  it("re-validates the merged card: an edit cannot break a multiple_choice card", async () => {
    const card = (
      await asUser(app, userA)
        .post("/api/cards")
        .send({ cardType: "multiple_choice", prompt: "Q?", answer: "Zone", answerSpec: { choices: ["Zone", "Planet"], correctIndex: 0 } })
    ).body;
    const bad = await asUser(app, userA).patch(`/api/cards/${card.id}`).send({ answer: "Planet" });
    expect(bad.status).toBe(400);
    const good = await asUser(app, userA)
      .patch(`/api/cards/${card.id}`)
      .send({ answer: "Planet", answerSpec: { choices: ["Zone", "Planet"], correctIndex: 1 } });
    expect(good.status).toBe(200);
    expect(good.body.revision).toBe(2);
  });

  it("a written-answer card can change study mode; that counts as a content change; other types cannot have one", async () => {
    const written = (
      await asUser(app, userA)
        .post("/api/cards")
        .send({ cardType: "open_ended", learningMode: "explain", prompt: "Why zones?", answer: "Isolation limits blast radius.", rubric: { criteria: ["mentions isolation"] } })
    ).body;
    expect(written.learningMode).toBe("explain");
    const res = await asUser(app, userA).patch(`/api/cards/${written.id}`).send({ learningMode: "apply" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ learningMode: "apply", revision: 2 });
    const same = await asUser(app, userA).patch(`/api/cards/${written.id}`).send({ learningMode: "apply" });
    expect(same.body.revision).toBe(2);
    const plain = (await asUser(app, userA).post("/api/cards").send(definitionCard)).body;
    expect((await asUser(app, userA).patch(`/api/cards/${plain.id}`).send({ learningMode: "apply" })).status).toBe(400);
    expect((await asUser(app, userA).patch(`/api/cards/${written.id}`).send({ learningMode: "banana" })).status).toBe(400);
  });

  it("cannot change status, type or ownership through an edit", async () => {
    const card = (await asUser(app, userA).post("/api/cards").send(definitionCard)).body;
    for (const forbidden of [{ status: "draft" }, { cardType: "numeric" }, { userId: userB }, { revision: 99 }]) {
      const res = await asUser(app, userA).patch(`/api/cards/${card.id}`).send(forbidden);
      expect(res.status).toBe(400);
    }
    expect((await asUser(app, userA).get(`/api/cards/${card.id}`)).body.status).toBe("approved");
  });
});

describe("cards: provenance", () => {
  it("a manual card can reference the user's own source", async () => {
    const sourceId = await createSource(userA, "My notes");
    const res = await asUser(app, userA)
      .post("/api/cards")
      .send({ ...definitionCard, sourceRefs: [{ sourceId, excerpt: "Zones are isolated.", charStart: 0, charEnd: 19 }] });
    expect(res.status).toBe(201);
    expect(res.body.sourceRefs[0]).toMatchObject({ sourceId, sourceTitle: "My notes", charStart: 0, charEnd: 19 });
  });

  it("rejects a reference to a source that does not exist or belongs to someone else, and stores nothing", async () => {
    const othersSource = await createSource(userB);
    const before = (await asUser(app, userA).get("/api/cards")).body.total;

    for (const sourceId of [othersSource, "22222222-2222-4222-8222-222222222222"]) {
      const res = await asUser(app, userA)
        .post("/api/cards")
        .send({ ...definitionCard, sourceRefs: [{ sourceId, excerpt: "x" }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("unknown_source");
    }
    expect((await asUser(app, userA).get("/api/cards")).body.total).toBe(before);
  });

  it("deleting a source keeps the card and its provenance excerpt and title", async () => {
    const sourceId = await createSource(userA, "Doomed source");
    const card = (
      await asUser(app, userA)
        .post("/api/cards")
        .send({ ...definitionCard, sourceRefs: [{ sourceId, excerpt: "Zones are isolated." }] })
    ).body;

    expect((await asUser(app, userA).delete(`/api/sources/${sourceId}`)).status).toBe(204);

    const after = await asUser(app, userA).get(`/api/cards/${card.id}`);
    expect(after.status).toBe(200);
    expect(after.body.sourceRefs).toHaveLength(1);
    expect(after.body.sourceRefs[0]).toMatchObject({ sourceId: null, sourceTitle: "Doomed source", excerpt: "Zones are isolated." });
  });
});

describe("cards: ownership isolation", () => {
  it("another user cannot read, edit, approve, reject or delete a card", async () => {
    const sourceId = await createSource(userA);
    const draftId = await createDraft(userA, sourceId);
    const approvedId = (await asUser(app, userA).post("/api/cards").send(definitionCard)).body.id as string;

    for (const id of [draftId, approvedId]) {
      expect((await asUser(app, userB).get(`/api/cards/${id}`)).status).toBe(404);
      expect((await asUser(app, userB).patch(`/api/cards/${id}`).send({ prompt: "Hijack?" })).status).toBe(404);
      expect((await asUser(app, userB).post(`/api/cards/${id}/approve`)).status).toBe(404);
      expect((await asUser(app, userB).post(`/api/cards/${id}/reject`)).status).toBe(404);
      expect((await asUser(app, userB).delete(`/api/cards/${id}`)).status).toBe(404);
    }

    // The draft was not approved by user B, and nothing changed.
    expect((await asUser(app, userA).get(`/api/cards/${draftId}`)).body.status).toBe("draft");
    expect((await asUser(app, userA).get(`/api/cards/${approvedId}`)).body.prompt).toBe(definitionCard.prompt);
    const listB = (await asUser(app, userB).get("/api/cards")).body.items.map((c: { id: string }) => c.id);
    expect(listB).not.toContain(draftId);
    expect(listB).not.toContain(approvedId);
  });
});

describe("cards: deletion", () => {
  it("deletes a card and its provenance links", async () => {
    const sourceId = await createSource(userA);
    const draftId = await createDraft(userA, sourceId);
    expect((await asUser(app, userA).delete(`/api/cards/${draftId}`)).status).toBe(204);
    expect((await asUser(app, userA).get(`/api/cards/${draftId}`)).status).toBe(404);
    const refs = await pool.query("SELECT 1 FROM card_sources WHERE card_id = $1", [draftId]);
    expect(refs.rowCount).toBe(0);
  });
});

describe("cards: library list shows deck membership", () => {
  it("each listed card says which decks it is in (none means it cannot be studied), only your own decks", async () => {
    const lonely = (await asUser(app, userA).post("/api/cards").send({ cardType: "short_answer", prompt: "Lonely card question?", answer: "x" })).body.id;
    const filed = (await asUser(app, userA).post("/api/cards").send({ cardType: "short_answer", prompt: "Filed card question?", answer: "x" })).body.id;
    const deck = (await asUser(app, userA).post("/api/decks").send({ title: "Membership deck" })).body;
    await asUser(app, userA).post(`/api/decks/${deck.id}/cards`).send({ cardId: filed });
    const items = (await asUser(app, userA).get("/api/cards?limit=200")).body.items as Array<{ id: string; decks: Array<{ id: string; title: string }> }>;
    expect(items.find((c) => c.id === lonely)!.decks).toEqual([]);
    expect(items.find((c) => c.id === filed)!.decks).toEqual([{ id: deck.id, title: "Membership deck" }]);
    // another user cannot see the deck name through their own list
    expect(JSON.stringify((await asUser(app, userB).get("/api/cards?limit=200")).body)).not.toContain("Membership deck");
  });
});
