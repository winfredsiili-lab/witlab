import type { Express } from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestApp, createTestUser, openTestPool } from "../testing/testDb.js";
import type { AiProvider } from "../modules/ai/provider.js";

let pool: pg.Pool;
let app: Express;
let A: string;
let B: string;
const ZERO = "00000000-0000-4000-8000-000000000000";
const provider: AiProvider = { model: "stub", generateStructured: async () => ({ cards: [] }) };

let sourceId: string;
let cardId: string;
let deckId: string;
let sessionId: string;

beforeAll(async () => {
  pool = await openTestPool();
  app = createTestApp(pool, undefined, { aiProvider: provider });
  A = await createTestUser(pool, "sec-a");
  B = await createTestUser(pool, "sec-b");
  sourceId = (await asUser(app, A).post("/api/sources").send({ title: "S", sourceType: "text", contentText: "An availability zone is an isolated location within a region." })).body.id;
  cardId = (await asUser(app, A).post("/api/cards").send({ cardType: "short_answer", prompt: "What is a zone?", answer: "isolated" })).body.id;
  deckId = (await asUser(app, A).post("/api/decks").send({ title: "D" })).body.id;
  await asUser(app, A).post(`/api/decks/${deckId}/cards`).send({ cardId });
  sessionId = (await asUser(app, A).post("/api/study/sessions").send({ deckId })).body.id;
});
afterAll(async () => {
  await pool.end();
});

type Call = [method: "get" | "post" | "put" | "patch" | "delete", path: () => string, body?: () => unknown];
const routes: Call[] = [
  ["get", () => `/api/sources/${sourceId}`],
  ["delete", () => `/api/sources/${sourceId}`],
  ["get", () => `/api/sources/${sourceId}/sections`],
  ["get", () => `/api/sources/${sourceId}/pages`],
  ["get", () => `/api/sources/${sourceId}/pages/1`],
  ["post", () => `/api/sources/${sourceId}/generate`, () => ({})],
  ["get", () => `/api/sources/${sourceId}/generations`],
  ["get", () => `/api/cards/${cardId}`],
  ["patch", () => `/api/cards/${cardId}`, () => ({ prompt: "Hijacked question?" })],
  ["delete", () => `/api/cards/${cardId}`],
  ["post", () => `/api/cards/${cardId}/approve`, () => ({})],
  ["post", () => `/api/cards/${cardId}/reject`, () => ({})],
  ["get", () => `/api/decks/${deckId}`],
  ["patch", () => `/api/decks/${deckId}`, () => ({ title: "Hijacked" })],
  ["delete", () => `/api/decks/${deckId}`],
  ["post", () => `/api/decks/${deckId}/cards`, () => ({ cardId })],
  ["put", () => `/api/decks/${deckId}/cards/order`, () => ({ cardIds: [cardId] })],
  ["delete", () => `/api/decks/${deckId}/cards/${cardId}`],
  ["get", () => `/api/study/overview?deckId=${deckId}`],
  ["post", () => `/api/study/sessions`, () => ({ deckId })],
  ["get", () => `/api/study/sessions/${sessionId}`],
  ["post", () => `/api/study/sessions/${sessionId}/responses`, () => ({ cardId, answer: "isolated" })],
  ["post", () => `/api/study/sessions/${sessionId}/end`, () => ({})],
  ["get", () => `/api/progress?deckId=${deckId}`],
];

// Account routes act on the signed-in user only (there is no id in the path), so they join the 401 sweep but not the cross-user test.
const accountRoutes: typeof routes = [
  ["get", () => `/api/auth/session`],
  ["get", () => `/api/me/export`],
  ["post", () => `/api/auth/password`, () => ({ currentPassword: "x", newPassword: "y" })],
  ["post", () => `/api/auth/logout-all`, () => ({})],
  ["post", () => `/api/auth/delete-account`, () => ({ password: "x" })],
];

describe("every route requires authentication", () => {
  it.each([...routes, ...accountRoutes].map((r) => [`${r[0].toUpperCase()} ${r[1]().replace(/[0-9a-f-]{36}/g, ":id")}`, r] as const))("%s", async (_n, r) => {
    const res = await request(app)[r[0]](r[1]()).send(r[2]?.() as object | undefined);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("the route table above covers every route the app registers (so new routes cannot skip the sweep)", () => {
    const registered = new Set<string>();
    const walk = (stack: any[]) => {
      for (const layer of stack) {
        if (layer.route) for (const m of Object.keys(layer.route.methods)) registered.add(`${m.toUpperCase()} ${layer.route.path}`);
        else if (layer.name === "router" && layer.handle?.stack) walk(layer.handle.stack);
      }
    };
    walk((app as any)._router.stack);
    // Compare by route-local path (the part after the mount point), with ids normalised.
    const norm = (s: string) => s.replace(/:[a-zA-Z]+/g, ":id").replace(/\/+$/, "") || "/";
    const covered = new Set(
      [...routes, ...accountRoutes].map((r) => `${r[0].toUpperCase()} ${norm(r[1]().replace(/\?.*$/, "").replace(/^\/api\/[a-z]+/, "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").replace(/\/pages\/1$/, "/pages/:id"))}`),
    );
    const exempt = /^POST \/(register|login|logout)$|^GET \/(health)?$|^(GET|POST|PATCH) \/$|^POST \/(bulk|pdf)$|^GET \/(overview|sessions)$|^POST \/sessions$/;
    const missing = [...registered].map((r) => r.replace(/ (.*)/, (_m, p) => ` ${norm(p)}`)).filter((r) => !covered.has(r) && !exempt.test(r));
    expect(missing).toEqual([]);
  });
});

describe("one user can never read or change another user's data", () => {
  it.each(routes.map((r) => [`${r[0].toUpperCase()} ${r[1]().replace(/[0-9a-f-]{36}/g, ":id")}`, r] as const))("%s as another user is 404", async (_n, r) => {
    const res = await asUser(app, B)[r[0]](r[1]()).send(r[2]?.() as object | undefined);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("bulk review and deck-add with someone else's card ids change nothing", async () => {
    const bulk = await asUser(app, B).post("/api/cards/bulk").send({ action: "reject", cardIds: [cardId] });
    expect([200, 404]).toContain(bulk.status);
    if (bulk.status === 200) expect(JSON.stringify(bulk.body)).not.toContain(cardId.slice(0, 0) + "approved");
    const bDeck = (await asUser(app, B).post("/api/decks").send({ title: "B deck" })).body.id;
    const add = await asUser(app, B).post(`/api/decks/${bDeck}/cards`).send({ cardId });
    expect(add.status).toBe(404);
  });

  it("lists contain only your own records", async () => {
    for (const path of ["/api/sources", "/api/cards", "/api/decks", "/api/study/sessions", "/api/progress"]) {
      const body = JSON.stringify((await asUser(app, B).get(path)).body);
      expect(body, path).not.toContain(sourceId);
      expect(body, path).not.toContain(cardId);
      expect(body, path).not.toContain(deckId);
      expect(body, path).not.toContain(sessionId);
    }
  });

  it("after all of that, user A's data is exactly as it was", async () => {
    expect((await asUser(app, A).get(`/api/cards/${cardId}`)).body).toMatchObject({ status: "approved", prompt: "What is a zone?" });
    expect((await asUser(app, A).get(`/api/decks/${deckId}`)).body.cards).toHaveLength(1);
    expect((await asUser(app, A).get(`/api/sources/${sourceId}`)).status).toBe(200);
    expect((await asUser(app, A).get(`/api/study/sessions/${sessionId}`)).body.status).toBe("active");
  });
});

describe("input handling", () => {
  it("malformed ids are 400, not 500, on every id route", async () => {
    for (const path of ["/api/sources/not-a-uuid", "/api/cards/1", "/api/decks/' OR 1=1 --", "/api/study/sessions/%00", `/api/sources/${ZERO}/pages/abc`]) {
      const res = await asUser(app, A).get(path);
      expect([400, 404], path).toContain(res.status);
    }
    expect((await asUser(app, A).get("/api/cards/not-a-uuid")).status).toBe(400);
  });

  it("SQL-looking text is stored as plain text and does not change query behaviour", async () => {
    const evil = "Robert'); DROP TABLE cards;--";
    const made = await asUser(app, A).post("/api/cards").send({ cardType: "short_answer", prompt: evil, answer: "x'; --" });
    expect(made.status).toBe(201);
    expect((await asUser(app, A).get(`/api/cards/${made.body.id}`)).body.prompt).toBe(evil);
    const q = await asUser(app, A).get(`/api/cards?status=${encodeURIComponent("approved'; DROP TABLE cards;--")}`);
    expect(q.status).toBe(400);
    expect((await pool.query("SELECT count(*)::int n FROM cards")).rows[0].n).toBeGreaterThan(0);
  });

  it("HTML and script text is returned as JSON data, never interpreted", async () => {
    const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const made = await asUser(app, A).post("/api/decks").send({ title: xss });
    const got = await asUser(app, A).get(`/api/decks/${made.body.id}`);
    expect(got.headers["content-type"]).toMatch(/application\/json/);
    expect(got.body.title).toBe(xss);
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("malformed JSON is 400 and an oversized body is 413", async () => {
    const bad = await request(app).post("/api/decks").set("x-test-user-id", A).set("Content-Type", "application/json").send("{not json");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_json");
    const big = await asUser(app, A).post("/api/decks").send({ title: "x".repeat(3 * 1024 * 1024) });
    expect(big.status).toBe(413);
  });

  it("unknown fields and over-long values are rejected; a body cannot choose the owner", async () => {
    expect((await asUser(app, A).post("/api/decks").send({ title: "ok", userId: B })).status).toBe(400);
    expect((await asUser(app, A).post("/api/decks").send({ title: "x".repeat(10_000) })).status).toBe(400);
    expect((await asUser(app, A).post("/api/cards").send({ cardType: "short_answer", prompt: "p?", answer: "a", status: "approved", userId: B })).status).toBe(400);
    expect((await asUser(app, A).post("/api/cards").send({ cardType: "short_answer", prompt: "x".repeat(5000), answer: "a" })).status).toBe(400);
    expect((await asUser(app, A).patch("/api/me").send({ sessionSize: 9999 })).status).toBe(400);
  });

  it("wrong JSON types do not crash the server", async () => {
    for (const body of [null, [], "str", 5, { title: { $ne: null } }, { title: ["a"] }]) {
      const res = await request(app).post("/api/decks").set("x-test-user-id", A).set("Content-Type", "application/json").send(JSON.stringify(body));
      expect(res.status, JSON.stringify(body)).toBeLessThan(500);
    }
  });

  it("PDF upload: garbage, empty and wrong-type bodies are client errors, never 500", async () => {
    const send = (type: string, body: Buffer) => request(app).post("/api/sources/pdf?filename=x.pdf").set("x-test-user-id", A).set("Content-Type", type).send(body);
    for (const [type, body] of [["application/pdf", Buffer.from("this is not a pdf")], ["application/pdf", Buffer.alloc(0)], ["text/plain", Buffer.from("%PDF-1.4")], ["application/pdf", Buffer.from("%PDF-1.4\n%%EOF")]] as const) {
      const res = await send(type, body);
      expect(res.status, type).toBeLessThan(500);
      // A file that cannot be read is either refused or kept as a visible "failed" source with a reason; never silently accepted.
      if (res.status === 201) expect(res.body.source).toMatchObject({ status: "failed", pageCount: null });
      else expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("responses", () => {
  it("errors carry a code and message but never stack traces, SQL or file paths", async () => {
    const samples = [
      await asUser(app, A).get("/api/cards/not-a-uuid"),
      await asUser(app, A).get(`/api/cards/${ZERO}`),
      await request(app).get("/api/cards"),
      await asUser(app, A).post("/api/cards").send({}),
      await asUser(app, A).get("/api/nonexistent"),
    ];
    for (const r of samples) {
      const text = JSON.stringify(r.body);
      expect(text).not.toMatch(/at .*\.(ts|js):\d+|SELECT |INSERT |node_modules|\/home\//);
      expect(r.body.error.code).toBeTruthy();
    }
  });

  it("sets protective headers and does not advertise the framework", async () => {
    const res = await asUser(app, A).get("/api/decks");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("only the configured web origin is allowed by CORS", async () => {
    const ok = await request(app).get("/api/health").set("Origin", "http://localhost:5173");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const other = await request(app).get("/api/health").set("Origin", "https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("/api/me never exposes the AI key or provider details beyond configured/usage", async () => {
    const body = JSON.stringify((await asUser(app, A).get("/api/me")).body);
    expect(body).not.toMatch(/key|secret|token|password/i);
  });
});
