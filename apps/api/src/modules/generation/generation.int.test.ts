import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateCardsResponseSchema } from "@witlab/contracts";
import { asUser, createTestApp, createTestUser, openTestPool } from "../../testing/testDb.js";
import { AiProviderError, type AiProvider, type StructuredRequest } from "../ai/provider.js";
import { createOpenAiCompatibleProvider } from "../ai/openaiCompatible.js";
import { createCardService } from "../cards/card.service.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures");
const TEXT =
  "An availability zone is an isolated location within a region. Zones have independent power, cooling and networking. " +
  "A virtual machine is an emulation of a physical computer. Premium SSD disks offer the lowest latency.";

const card = (over: Record<string, unknown> = {}) => ({
  card_type: "term_definition", prompt: "What is an availability zone?", answer: "An isolated location within a region.",
  explanation: "From the passage.", choices: [], correct_choice_index: -1, accepted_answers: [],
  numeric_answer: "", numeric_tolerance: "", quote: "An availability zone is an isolated location within a region.", ...over,
});

class StubProvider implements AiProvider {
  model = "stub-model";
  calls: StructuredRequest[] = [];
  constructor(public behaviour: (r: StructuredRequest) => unknown | Promise<unknown>) {}
  async generateStructured(r: StructuredRequest) {
    this.calls.push(r);
    return this.behaviour(r);
  }
}

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

const appWith = (provider: AiProvider | null, limits?: { perUserPerDay: number; globalPerDay: number }): Express =>
  createTestApp(pool, undefined, { aiProvider: provider, generationLimits: limits });

async function newTextSource(app: Express, user: string, text = TEXT) {
  return (await asUser(app, user).post("/api/sources").send({ title: "Notes", sourceType: "text", contentText: text })).body.id as string;
}
const counts = async (user: string) =>
  (await pool.query("SELECT (SELECT count(*)::int FROM cards WHERE user_id=$1) AS cards, (SELECT count(*)::int FROM card_review_state WHERE user_id=$1) AS progress", [user])).rows[0];

describe("generation: success path", () => {
  it("creates DRAFT cards with provenance taken from the source, and logs the job", async () => {
    const provider = new StubProvider(() => ({
      cards: [
        card(),
        card({ card_type: "multiple_choice", prompt: "Which disk type has the lowest latency?", answer: "x", choices: ["Standard HDD", "Premium SSD", "Archive"], correct_choice_index: 1, quote: "Premium SSD disks offer the lowest latency." }),
      ],
    }));
    const app = appWith(provider);
    const sourceId = await newTextSource(app, userA);
    const res = await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({ maxCards: 5 });
    expect(res.status).toBe(201);
    const body = generateCardsResponseSchema.parse(res.body);
    expect(body.job).toMatchObject({ status: "succeeded", candidatesReturned: 2, draftsCreated: 2, model: "stub-model", requestedCards: 5, discarded: [] });
    expect(body.cards).toHaveLength(2);
    for (const c of body.cards) {
      expect(c.status).toBe("draft");
      expect(c.origin).toBe("ai_generated");
      expect(c.sourceRefs).toHaveLength(1);
      expect(c.sourceRefs[0]!.sourceId).toBe(sourceId);
      expect(TEXT.slice(c.sourceRefs[0]!.charStart!, c.sourceRefs[0]!.charEnd!)).toBe(c.sourceRefs[0]!.excerpt);
    }
    expect(body.cards[1]!.answer).toBe("Premium SSD");
    // The prompt sent to the AI contained the source text and the requested count, and no secrets.
    expect(provider.calls[0]!.user).toContain("up to 5 flashcards");
    expect(provider.calls[0]!.user).toContain("An availability zone is an isolated location");
    // Listed as drafts, and not studyable or in any deck.
    const drafts = (await asUser(app, userA).get("/api/cards?status=draft")).body.items;
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    const jobs = (await asUser(app, userA).get(`/api/sources/${sourceId}/generations`)).body.items;
    expect(jobs).toHaveLength(1);
  });

  it("a generated draft cannot be added to a deck until approved (approval gate still holds)", async () => {
    const app = appWith(new StubProvider(() => ({ cards: [card()] })));
    const sourceId = await newTextSource(app, userA);
    const gen = (await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({})).body;
    const deck = (await asUser(app, userA).post("/api/decks").send({ title: "D" })).body;
    const attempt = await asUser(app, userA).post(`/api/decks/${deck.id}/cards`).send({ cardId: gen.cards[0].id });
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe("card_not_approved");
    expect((await asUser(app, userA).post(`/api/cards/${gen.cards[0].id}/approve`)).status).toBe(200);
    expect((await asUser(app, userA).post(`/api/decks/${deck.id}/cards`).send({ cardId: gen.cards[0].id })).status).toBe(201);
  });

  it("generates from a PDF page range and records the page", async () => {
    const provider = new StubProvider(() => ({
      cards: [card({ prompt: "What does peering do?", answer: "Connects two virtual networks privately.", quote: "Peering connects two virtual networks privately." })],
    }));
    const app = appWith(provider);
    const up = await request(app).post("/api/sources/pdf").set("x-test-user-id", userA).set("Content-Type", "application/pdf").send(readFileSync(join(fixtures, "outline.pdf")));
    const id = up.body.source.id;
    const sections = (await asUser(app, userA).get(`/api/sources/${id}/sections`)).body.items;
    const ch3 = sections.find((s: { title: string }) => s.title.startsWith("Chapter 3"));
    const res = await asUser(app, userA).post(`/api/sources/${id}/generate`).send({ scope: { type: "section", sectionId: ch3.id } });
    expect(res.status).toBe(201);
    expect(res.body.cards[0].sourceRefs[0]).toMatchObject({ pageStart: 5, pageEnd: 5 });
    // Only chapter 3's pages were sent
    expect(provider.calls[0]!.user).toContain("[Page 4]");
    expect(provider.calls[0]!.user).not.toContain("[Page 1]");
  });
});

describe("generation: quality gates", () => {
  it("drops ungrounded and duplicate candidates, reports why, and keeps the good ones", async () => {
    const app = appWith(new StubProvider(() => ({
      cards: [card(), card({ prompt: "What is a virtual machine?", answer: "x", quote: "Virtual machines are made of clouds and wishes." }), card({ prompt: "what is  AN availability zone?" }), { nonsense: true }],
    })));
    const sourceId = await newTextSource(app, userA);
    const res = await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({});
    expect(res.body.job).toMatchObject({ status: "succeeded", candidatesReturned: 4, draftsCreated: 1 });
    expect(res.body.job.discarded.map((d: { reason: string }) => d.reason)).toEqual([
      expect.stringMatching(/does not appear/),
      expect.stringMatching(/incomplete/),
      expect.stringMatching(/Duplicate/),
    ]);
  });

  it("does not re-create a question the source already has as a draft or card, but allows it after rejection", async () => {
    const app = appWith(new StubProvider(() => ({ cards: [card()] })));
    const sourceId = await newTextSource(app, userA);
    const first = (await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({})).body;
    const second = (await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({})).body;
    expect(second.job.draftsCreated).toBe(0);
    expect(second.job.discarded[0].reason).toMatch(/Duplicate/);
    await asUser(app, userA).post(`/api/cards/${first.cards[0].id}/reject`);
    const third = (await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({})).body;
    expect(third.job.draftsCreated).toBe(1);
  });

  it("caps the number of drafts at maxCards", async () => {
    const many = ["What is an availability zone?", "Which disks have the lowest latency?", "What is a virtual machine?"];
    const app = appWith(new StubProvider(() => ({
      cards: [
        card({ prompt: many[0] }),
        card({ prompt: many[1], quote: "Premium SSD disks offer the lowest latency." }),
        card({ prompt: many[2], quote: "A virtual machine is an emulation of a physical computer." }),
      ],
    })));
    const sourceId = await newTextSource(app, userA);
    const res = await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({ maxCards: 2 });
    expect(res.body.cards).toHaveLength(2);
    expect(res.body.job.discarded[0].reason).toMatch(/More cards than requested/);
  });
});

describe("generation: failures create nothing", () => {
  it.each([
    ["rate limited", new AiProviderError("ai_rate_limited", "busy", 5), 429, "ai_rate_limited"],
    ["timeout", new AiProviderError("ai_timeout", "slow"), 504, "ai_timeout"],
    ["unavailable", new AiProviderError("ai_unavailable", "down"), 502, "ai_unavailable"],
    ["bad key", new AiProviderError("ai_auth", "key"), 502, "ai_auth"],
    ["truncated", new AiProviderError("ai_truncated", "cut"), 502, "ai_truncated"],
  ])("%s: error status, failed job, no cards, no progress", async (_n, err, status, code) => {
    const app = appWith(new StubProvider(() => { throw err; }));
    const sourceId = await newTextSource(app, userA);
    const before = await counts(userA);
    const res = await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({});
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(await counts(userA)).toEqual(before);
    const job = (await asUser(app, userA).get(`/api/sources/${sourceId}/generations`)).body.items[0];
    expect(job).toMatchObject({ status: "failed", errorCode: code, draftsCreated: 0 });
    // The source itself is untouched
    const src = (await asUser(app, userA).get(`/api/sources/${sourceId}`)).body;
    expect(src.contentText).toBe(TEXT);
    expect(src.status).toBe("ready");
  });

  it("an answer with the wrong overall shape fails the job and creates nothing", async () => {
    const app = appWith(new StubProvider(() => ({ cards: "not a list" })));
    const sourceId = await newTextSource(app, userA);
    const before = await counts(userA);
    const res = await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ai_bad_response");
    expect(await counts(userA)).toEqual(before);
  });

  it("answers 503 ai_not_configured without creating a job when there is no provider", async () => {
    const app = appWith(null);
    const sourceId = await newTextSource(app, userA);
    const res = await asUser(app, userA).post(`/api/sources/${sourceId}/generate`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ai_not_configured");
    expect((await asUser(app, userA).get(`/api/sources/${sourceId}/generations`)).body.items).toEqual([]);
  });
});

describe("generation: scope and request rules", () => {
  let app: Express;
  beforeAll(() => {
    app = appWith(new StubProvider(() => ({ cards: [] })));
  });
  it("refuses a selection over the character limit, without calling the AI or logging a job", async () => {
    const provider = new StubProvider(() => ({ cards: [] }));
    const a = appWith(provider);
    const id = await newTextSource(a, userA, "word ".repeat(3000)); // 15000 chars, no headings -> auto parts
    const res = await asUser(a, userA).post(`/api/sources/${id}/generate`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("scope_too_large");
    expect(provider.calls).toHaveLength(0);
    const parts = (await asUser(a, userA).get(`/api/sources/${id}/sections`)).body.items;
    expect(parts.length).toBeGreaterThan(1);
    const ok = await asUser(a, userA).post(`/api/sources/${id}/generate`).send({ scope: { type: "section", sectionId: parts[0].id } });
    expect(ok.status).toBe(201);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.user.length).toBeLessThan(13_000);
  });

  it.each([
    [{ type: "pages", pageStart: 1, pageEnd: 2 }],
    [{ type: "chars", charStart: 0, charEnd: 99999 }],
    [{ type: "chars", charStart: 10, charEnd: 5 }],
    [{ type: "section", sectionId: "11111111-1111-4111-8111-111111111111" }],
  ])("rejects invalid scope %j for a text source", async (scope) => {
    const id = await newTextSource(app, userA);
    const res = await asUser(app, userA).post(`/api/sources/${id}/generate`).send({ scope });
    expect(res.status).toBe(400);
  });

  it("rejects a blank-ish selection and bad body values", async () => {
    const id = await newTextSource(app, userA, "Tiny.");
    expect((await asUser(app, userA).post(`/api/sources/${id}/generate`).send({})).body.error.code).toBe("scope_empty");
    const id2 = await newTextSource(app, userA);
    for (const body of [{ maxCards: 0 }, { maxCards: 99 }, { scope: { type: "bogus" } }]) {
      expect((await asUser(app, userA).post(`/api/sources/${id2}/generate`).send(body)).status).toBe(400);
    }
  });

  it("refuses a failed PDF source, and hides sources and jobs from other users", async () => {
    const a = appWith(new StubProvider(() => ({ cards: [card()] })));
    const failed = (await request(a).post("/api/sources/pdf").set("x-test-user-id", userA).set("Content-Type", "application/pdf").send(readFileSync(join(fixtures, "scanned.pdf")))).body.source;
    const res = await asUser(a, userA).post(`/api/sources/${failed.id}/generate`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("source_not_ready");

    const id = await newTextSource(a, userA);
    expect((await asUser(a, userB).post(`/api/sources/${id}/generate`).send({})).status).toBe(404);
    expect((await asUser(a, userB).get(`/api/sources/${id}/generations`)).status).toBe(404);
  });

  it("requires authentication", async () => {
    const id = await newTextSource(app, userA);
    expect((await request(app).post(`/api/sources/${id}/generate`).send({})).status).toBe(401);
  });
});

describe("generation: limits and concurrency", () => {
  it("enforces the per-user daily limit (and other users are unaffected)", async () => {
    const provider = new StubProvider(() => ({ cards: [] }));
    const app = appWith(provider, { perUserPerDay: 2, globalPerDay: 1000 });
    const u1 = await createTestUser(pool, "lim1");
    const u2 = await createTestUser(pool, "lim2");
    const id1 = await newTextSource(app, u1);
    const id2 = await newTextSource(app, u2);
    expect((await asUser(app, u1).post(`/api/sources/${id1}/generate`).send({})).status).toBe(201);
    expect((await asUser(app, u1).post(`/api/sources/${id1}/generate`).send({})).status).toBe(201);
    const blocked = await asUser(app, u1).post(`/api/sources/${id1}/generate`).send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("generation_limit_reached");
    expect(provider.calls).toHaveLength(2);
    expect((await asUser(app, u2).post(`/api/sources/${id2}/generate`).send({})).status).toBe(201);
  });

  it("enforces the global limit using jobs from all users", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM generation_jobs WHERE created_at > now() - interval '24 hours'")).rows[0].n;
    const provider = new StubProvider(() => ({ cards: [] }));
    const app = appWith(provider, { perUserPerDay: 1000, globalPerDay: before + 1 });
    const u = await createTestUser(pool, "glob");
    const id = await newTextSource(app, u);
    expect((await asUser(app, u).post(`/api/sources/${id}/generate`).send({})).status).toBe(201);
    const blocked = await asUser(app, u).post(`/api/sources/${id}/generate`).send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("generation_capacity_reached");
  });

  it("allows only one running generation per user: a concurrent second request gets 409 and the AI is called once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new StubProvider(async () => { await gate; return { cards: [card()] }; });
    const app = appWith(provider);
    const u = await createTestUser(pool, "conc");
    const id = await newTextSource(app, u);
    const first = asUser(app, u).post(`/api/sources/${id}/generate`).send({}).then((r) => r);
    while (provider.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    const second = await asUser(app, u).post(`/api/sources/${id}/generate`).send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("generation_in_progress");
    release();
    expect((await first).status).toBe(201);
    expect(provider.calls).toHaveLength(1);
  });

  it("deleting the source keeps the drafts (with their excerpt) and the job record", async () => {
    const app = appWith(new StubProvider(() => ({ cards: [card()] })));
    const id = await newTextSource(app, userA);
    const gen = (await asUser(app, userA).post(`/api/sources/${id}/generate`).send({})).body;
    expect((await asUser(app, userA).delete(`/api/sources/${id}`)).status).toBe(204);
    const kept = (await asUser(app, userA).get(`/api/cards/${gen.cards[0].id}`)).body;
    expect(kept.sourceRefs[0]).toMatchObject({ sourceId: null, sourceTitle: "Notes" });
    expect(kept.sourceRefs[0].excerpt).toContain("availability zone");
    const job = await pool.query("SELECT source_id, status FROM generation_jobs WHERE id = $1", [gen.job.id]);
    expect(job.rows[0]).toEqual({ source_id: null, status: "succeeded" });
  });
});

describe("generation through the real HTTP adapter (local stub server imitating the provider)", () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { auth?: string; body?: Record<string, unknown> } = {};
  let mode: "ok" | "429" | "garbage" | "length" = "ok";

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastRequest = { auth: req.headers.authorization, body: JSON.parse(raw) };
        const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(JSON.stringify(body));
        };
        if (mode === "429") return send(429, { error: { message: "limit" } }, { "retry-after": "7" });
        if (mode === "garbage") return send(200, { choices: [{ finish_reason: "stop", message: { content: "I cannot help with that" } }] });
        if (mode === "length") return send(200, { choices: [{ finish_reason: "length", message: { content: '{"cards":[{' } }] });
        send(200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ cards: [card()] }) } }] });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const live = () =>
    appWith(createOpenAiCompatibleProvider({ apiKey: "test-key-123", baseUrl, model: "local-model", strictSchema: true, reasoningEffort: "low", timeoutMs: 5000 }));

  it("works end to end over HTTP", async () => {
    mode = "ok";
    const app = live();
    const id = await newTextSource(app, userA);
    const res = await asUser(app, userA).post(`/api/sources/${id}/generate`).send({});
    expect(res.status).toBe(201);
    expect(res.body.cards[0].status).toBe("draft");
    expect(lastRequest.auth).toBe("Bearer test-key-123");
    expect((lastRequest.body!.response_format as { type: string }).type).toBe("json_schema");
    expect(JSON.stringify(res.body)).not.toContain("test-key-123");
  });

  it.each([["429", 429, "ai_rate_limited"], ["garbage", 502, "ai_bad_response"], ["length", 502, "ai_truncated"]] as const)(
    "provider misbehaviour (%s) becomes an honest error and creates nothing",
    async (m, status, code) => {
      mode = m;
      const app = live();
      const id = await newTextSource(app, userA);
      const before = await counts(userA);
      const res = await asUser(app, userA).post(`/api/sources/${id}/generate`).send({});
      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(await counts(userA)).toEqual(before);
      mode = "ok";
    },
  );

  it("never exposes AI configuration or keys through any API response", async () => {
    const app = live();
    const id = await newTextSource(app, userA);
    const all = JSON.stringify([
      (await asUser(app, userA).get("/api/sources")).body,
      (await asUser(app, userA).get(`/api/sources/${id}/generations`)).body,
      (await request(app).get("/api/health")).body,
    ]);
    expect(all).not.toContain("test-key-123");
    expect(all).not.toContain("Bearer");
  });
});

describe("AI drafts can only come from the generation service", () => {
  it("the HTTP card API refuses attempts to create AI-origin or draft cards, and creates nothing", async () => {
    const app = appWith(null);
    const before = (await pool.query("SELECT count(*)::int n FROM cards WHERE user_id = $1", [userA])).rows[0].n;
    const res = await asUser(app, userA).post("/api/cards").send({ cardType: "term_definition", prompt: "Q?", answer: "A", origin: "ai_generated", status: "draft" });
    expect(res.status).toBe(400);
    expect((await pool.query("SELECT count(*)::int n FROM cards WHERE user_id = $1", [userA])).rows[0].n).toBe(before);
  });
  it("the service refuses an AI card without a source reference", async () => {
    await expect(createCardService(pool).create(userA, { cardType: "term_definition", prompt: "Q?", answer: "A" } as never, "ai_generated")).rejects.toMatchObject({ code: "provenance_required" });
  });
});

describe("generation: written-answer styles", () => {
  const big = { perUserPerDay: 1000, globalPerDay: 100000 };
  let wUser: string;
  beforeAll(async () => {
    wUser = await createTestUser(pool, "writtengen");
  });
  const written = (over: Record<string, unknown> = {}) => ({
    card_type: "open_ended",
    prompt: "Explain why zones improve resilience.",
    answer: "Zones have independent power, cooling and networking, so a fault in one does not reach the others.",
    explanation: "",
    criteria: ["mentions independent power, cooling and networking"],
    quote: "Zones have independent power, cooling and networking.",
    ...over,
  });

  it.each(["explain", "connections", "apply"] as const)("%s: drafts open_ended cards with a rubric, the mode and a verified quote", async (style) => {
    const provider = new StubProvider(() => ({ cards: [written()] }));
    const app = appWith(provider, big);
    const sourceId = await newTextSource(app, wUser);
    const res = await asUser(app, wUser).post(`/api/sources/${sourceId}/generate`).send({ style });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const c = res.body.cards[0];
    expect(c).toMatchObject({ cardType: "open_ended", status: "draft", origin: "ai_generated", learningMode: style, rubric: { criteria: ["mentions independent power, cooling and networking"] } });
    expect(TEXT.slice(c.sourceRefs[0].charStart, c.sourceRefs[0].charEnd)).toBe(c.sourceRefs[0].excerpt);
    expect(provider.calls[0]!.schemaName).toBeDefined();
    expect(provider.calls[0]!.user).toContain("written-answer questions");
    expect(provider.calls[0]!.system).toContain("open_ended");
  });

  it("drops written cards without criteria, with a fabricated quote, or of the wrong type for the style; and recall rejects open_ended", async () => {
    const app = appWith(
      new StubProvider(() => ({
        cards: [
          written({ criteria: [] }),
          written({ prompt: "Explain something else entirely.", quote: "This sentence is not in the source at all." }),
          card(),
          written({ prompt: "A good question about isolation?" }),
        ],
      })),
    );
    const sourceId = await newTextSource(app, wUser);
    const res = await asUser(app, wUser).post(`/api/sources/${sourceId}/generate`).send({ style: "explain" });
    expect(res.body.cards).toHaveLength(1);
    expect(res.body.job.discarded).toHaveLength(3);

    const recall = appWith(new StubProvider(() => ({ cards: [written({ prompt: "Open question in recall?" })] })), big);
    const s2 = await newTextSource(recall, wUser);
    const r2 = await asUser(recall, wUser).post(`/api/sources/${s2}/generate`).send({});
    expect(r2.body.cards).toHaveLength(0);
    expect(r2.body.job.discarded[0].reason).toMatch(/Recall/);
  });

  it("rejects an unknown style", async () => {
    const app = appWith(new StubProvider(() => ({ cards: [] })), big);
    const sourceId = await newTextSource(app, wUser);
    expect((await asUser(app, wUser).post(`/api/sources/${sourceId}/generate`).send({ style: "hybrid" })).status).toBe(400);
  });
});
