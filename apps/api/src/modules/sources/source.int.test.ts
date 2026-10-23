import type { Express } from "express";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceDetailSchema, sourceListSchema } from "@witlab/contracts";
import { asUser, createTestApp, createTestUser, openTestPool } from "../../testing/testDb.js";
import { createApp } from "../../app.js";
import { createDatabaseCheck } from "../../db/pool.js";

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

const validSource = { title: "Networking notes", sourceType: "text", contentText: "Availability zones are isolated locations." };

describe("sources: create, read, update, delete", () => {
  it("creates a text source and returns it with its content", async () => {
    const res = await asUser(app, userA).post("/api/sources").send(validSource);
    expect(res.status).toBe(201);
    const source = sourceDetailSchema.parse(res.body);
    expect(source.title).toBe("Networking notes");
    expect(source.sourceType).toBe("text");
    expect(source.status).toBe("ready");
    expect(source.contentText).toBe(validSource.contentText);
    expect(source.contentLength).toBe(validSource.contentText.length);

    const fetched = await asUser(app, userA).get(`/api/sources/${source.id}`);
    expect(fetched.status).toBe(200);
    expect(sourceDetailSchema.parse(fetched.body).contentText).toBe(validSource.contentText);
  });

  it("list returns summaries without the (large) content text", async () => {
    const owner = await createTestUser(pool, "lister");
    await asUser(app, owner).post("/api/sources").send({ ...validSource, title: "One" });
    await asUser(app, owner).post("/api/sources").send({ ...validSource, title: "Two" });

    const res = await asUser(app, owner).get("/api/sources");
    expect(res.status).toBe(200);
    const page = sourceListSchema.parse(res.body);
    expect(page.total).toBe(2);
    expect(page.items.map((s) => s.title).sort()).toEqual(["One", "Two"]);
    expect(page.items[0]).not.toHaveProperty("contentText");
  });

  it("paginates", async () => {
    const owner = await createTestUser(pool, "pager");
    for (const title of ["1", "2", "3"]) await asUser(app, owner).post("/api/sources").send({ ...validSource, title });
    const res = await asUser(app, owner).get("/api/sources?limit=2&offset=2");
    const page = sourceListSchema.parse(res.body);
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
  });

  it("renames a source and trims the title", async () => {
    const created = (await asUser(app, userA).post("/api/sources").send(validSource)).body;
    const res = await asUser(app, userA).patch(`/api/sources/${created.id}`).send({ title: "  Renamed  " });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Renamed");
  });

  it("deletes a source", async () => {
    const created = (await asUser(app, userA).post("/api/sources").send(validSource)).body;
    expect((await asUser(app, userA).delete(`/api/sources/${created.id}`)).status).toBe(204);
    expect((await asUser(app, userA).get(`/api/sources/${created.id}`)).status).toBe(404);
  });

  it("returns 404 for a source that does not exist", async () => {
    const res = await asUser(app, userA).get("/api/sources/11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("sources: validation", () => {
  it.each([
    ["blank title", { ...validSource, title: "   " }],
    ["missing content", { title: "x", sourceType: "text" }],
    ["blank content", { ...validSource, contentText: "   " }],
    ["pdf type (not supported until Batch 4)", { ...validSource, sourceType: "pdf" }],
    ["title over 200 characters", { ...validSource, title: "x".repeat(201) }],
    ["content over the limit", { ...validSource, contentText: "x".repeat(250_001) }],
  ])("rejects %s", async (_label, body) => {
    const res = await asUser(app, userA).post("/api/sources").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects an update with a blank title", async () => {
    const created = (await asUser(app, userA).post("/api/sources").send(validSource)).body;
    const res = await asUser(app, userA).patch(`/api/sources/${created.id}`).send({ title: "" });
    expect(res.status).toBe(400);
  });
});

describe("sources: ownership isolation", () => {
  it("another user cannot read, rename, delete or list a source they do not own", async () => {
    const created = (await asUser(app, userA).post("/api/sources").send(validSource)).body;

    const read = await asUser(app, userB).get(`/api/sources/${created.id}`);
    expect(read.status).toBe(404);

    const rename = await asUser(app, userB).patch(`/api/sources/${created.id}`).send({ title: "Hijacked" });
    expect(rename.status).toBe(404);

    const del = await asUser(app, userB).delete(`/api/sources/${created.id}`);
    expect(del.status).toBe(404);

    const list = await asUser(app, userB).get("/api/sources");
    expect(list.body.items.map((s: { id: string }) => s.id)).not.toContain(created.id);

    // Untouched for the real owner.
    const owner = await asUser(app, userA).get(`/api/sources/${created.id}`);
    expect(owner.status).toBe(200);
    expect(owner.body.title).toBe("Networking notes");
  });

  it("refuses a user id supplied in the request body; the owner always comes from authentication", async () => {
    expect((await asUser(app, userB).post("/api/sources").send({ ...validSource, userId: userA, user_id: userA })).status).toBe(400);
    const res = await asUser(app, userB).post("/api/sources").send(validSource);
    expect(res.status).toBe(201);
    const asOwnerA = await asUser(app, userA).get(`/api/sources/${res.body.id}`);
    expect(asOwnerA.status).toBe(404);
  });
});

describe("sources: persistence", () => {
  it("data survives a brand new connection pool and app (simulated restart)", async () => {
    const created = (await asUser(app, userA).post("/api/sources").send({ ...validSource, title: "Survives restart" })).body;

    const freshPool = await openTestPool();
    try {
      const freshApp = createApp({
        corsOrigin: "http://localhost:5173",
        checkDatabase: createDatabaseCheck(freshPool),
        authenticate: async (req) => req.header("x-test-user-id") ?? null,
        pool: freshPool,
      });
      const res = await asUser(freshApp, userA).get(`/api/sources/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Survives restart");
    } finally {
      await freshPool.end();
    }
  });
});
