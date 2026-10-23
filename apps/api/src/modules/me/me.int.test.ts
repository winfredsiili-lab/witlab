import type { Express } from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meSchema } from "@witlab/contracts";
import { asUser, createTestApp, createTestUser, openTestPool } from "../../testing/testDb.js";

let pool: pg.Pool;
let app: Express;
beforeAll(async () => {
  pool = await openTestPool();
  app = createTestApp(pool);
});
afterAll(async () => {
  await pool.end();
});

describe("me: profile and preferences", () => {
  it("has sensible defaults", async () => {
    const u = await createTestUser(pool, "me");
    const res = await asUser(app, u).get("/api/me");
    expect(res.status).toBe(200);
    const me = meSchema.parse(res.body);
    expect(me.id).toBe(u);
    expect(me.preferences).toEqual({ sessionSize: 20, askConfidence: true });
    expect(me.aiUsage).toEqual({ configured: false, usedToday: 0, dailyLimit: 20, evaluationsUsedToday: 0, evaluationDailyLimit: 60 });
  });

  it("updates the name and preferences independently and keeps the rest", async () => {
    const u = await createTestUser(pool, "me");
    await asUser(app, u).patch("/api/me").send({ displayName: "  Ada  " });
    await asUser(app, u).patch("/api/me").send({ sessionSize: 8 });
    const me = (await asUser(app, u).patch("/api/me").send({ askConfidence: false })).body;
    expect(me.displayName).toBe("Ada");
    expect(me.preferences).toEqual({ sessionSize: 8, askConfidence: false });
    expect((await asUser(app, u).patch("/api/me").send({ displayName: null })).body.displayName).toBeNull();
    expect((await asUser(app, u).get("/api/me")).body.preferences).toEqual({ sessionSize: 8, askConfidence: false });
  });

  it.each([[{ sessionSize: 4 }], [{ sessionSize: 51 }], [{ sessionSize: 7.5 }], [{ displayName: "" }], [{ email: "x@y.z" }], [{}], [{ askConfidence: "yes" }]])(
    "rejects invalid update %j",
    async (body) => {
      const u = await createTestUser(pool, "me");
      expect((await asUser(app, u).patch("/api/me").send(body)).status).toBe(400);
      expect((await asUser(app, u).get("/api/me")).body.preferences).toEqual({ sessionSize: 20, askConfidence: true });
    },
  );

  it("never changes another user's settings", async () => {
    const a = await createTestUser(pool, "a");
    const b = await createTestUser(pool, "b");
    await asUser(app, a).patch("/api/me").send({ sessionSize: 5, displayName: "A" });
    const other = (await asUser(app, b).get("/api/me")).body;
    expect(other.preferences.sessionSize).toBe(20);
    expect(other.displayName).not.toBe("A");
  });

  it("the session-size preference sets the default session length; an explicit limit overrides it", async () => {
    const u = await createTestUser(pool, "size");
    const deck = (await asUser(app, u).post("/api/decks").send({ title: "D" })).body.id;
    for (let i = 0; i < 8; i++) {
      const c = (await asUser(app, u).post("/api/cards").send({ cardType: "term_definition", prompt: `Q${i}?`, answer: "a" })).body;
      await asUser(app, u).post(`/api/decks/${deck}/cards`).send({ cardId: c.id });
    }
    expect((await asUser(app, u).post("/api/study/sessions").send({ deckId: deck })).body.progress.total).toBe(8);
    await asUser(app, u).patch("/api/me").send({ sessionSize: 5 });
    const s = await asUser(app, u).post("/api/study/sessions").send({ deckId: deck });
    expect(s.body.progress.total).toBe(5);
    await asUser(app, u).post(`/api/study/sessions/${s.body.id}/end`);
    expect((await asUser(app, u).post("/api/study/sessions").send({ deckId: deck, limit: 6 })).body.progress.total).toBe(6);
  });

  it("reports today's AI generations used", async () => {
    const u = await createTestUser(pool, "usage");
    const src = (await asUser(app, u).post("/api/sources").send({ title: "S", sourceType: "text", contentText: "x".repeat(60) })).body.id;
    for (let i = 0; i < 3; i++) {
      await pool.query(
        "INSERT INTO generation_jobs (user_id, source_id, status, scope, scope_chars, model, requested_cards) VALUES ($1,$2,'failed','{\"type\":\"all\"}',60,'m',3)",
        [u, src],
      );
    }
    await pool.query("INSERT INTO generation_jobs (user_id, source_id, status, scope, scope_chars, model, requested_cards, created_at) VALUES ($1,$2,'failed','{\"type\":\"all\"}',60,'m',3, now() - interval '2 days')", [u, src]);
    expect((await asUser(app, u).get("/api/me")).body.aiUsage.usedToday).toBe(3);
  });

  it("requires authentication", async () => {
    expect((await (await import("supertest")).default(app).get("/api/me")).status).toBe(401);
  });
});

describe("me: export", () => {
  it("returns only the caller's own data, and never credentials", async () => {
    const a = await createTestUser(pool, "exp-a");
    const b = await createTestUser(pool, "exp-b");
    await asUser(app, a).post("/api/cards").send({ cardType: "term_definition", prompt: "Export me?", answer: "yes" });
    await asUser(app, b).post("/api/cards").send({ cardType: "term_definition", prompt: "Not yours?", answer: "no" });
    const res = await asUser(app, a).get("/api/me/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="witlab-export-/);
    const text = JSON.stringify(res.body);
    expect(text).toContain("Export me?");
    expect(text).not.toContain("Not yours?");
    expect(text).not.toMatch(/password|token_hash/i);
    expect(res.body.format).toBe("witlab-export-v1");
    expect((await request(app).get("/api/me/export")).status).toBe(401);
  });
});
