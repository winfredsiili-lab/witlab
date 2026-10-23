import request from "supertest";
import { describe, expect, it } from "vitest";
import { apiErrorSchema, healthResponseSchema } from "@witlab/contracts";
import { createApp, type AppDependencies } from "./app.js";
import { createPool } from "./db/pool.js";

const origin = "http://localhost:5173";

/**
 * These are DB-free unit tests. The pool is created lazily and never queried, because every test either
 * stubs checkDatabase or is rejected by authentication before reaching any service.
 */
function buildApp(overrides: Partial<AppDependencies> = {}) {
  return createApp({
    corsOrigin: origin,
    checkDatabase: async () => ({ status: "ok", latencyMs: 1 }),
    authenticate: async () => null,
    pool: createPool("postgresql://unused:unused@127.0.0.1:1/unused"),
    ...overrides,
  });
}

describe("GET /api/health", () => {
  it("returns 200 and ok when the database check succeeds", async () => {
    const app = buildApp({ checkDatabase: async () => ({ status: "ok", latencyMs: 3 }) });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.database).toEqual({ status: "ok", latencyMs: 3 });
  });

  it("returns 503 and degraded, with the reason, when the database is down", async () => {
    const app = buildApp({ checkDatabase: async () => ({ status: "error", message: "connection refused" }) });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    const body = healthResponseSchema.parse(res.body);
    expect(body.status).toBe("degraded");
    expect(body.database).toEqual({ status: "error", message: "connection refused" });
  });

  it("returns a 500 error body (without leaking details) if the check itself throws", async () => {
    const app = buildApp({
      checkDatabase: async () => {
        throw new Error("secret internal detail");
      },
    });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(500);
    const body = apiErrorSchema.parse(res.body);
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(res.body)).not.toContain("secret internal detail");
  });

  it("does not require authentication", async () => {
    const res = await request(buildApp()).get("/api/health");
    expect(res.status).toBe(200);
  });
});

describe("unknown routes", () => {
  it("returns a structured 404", async () => {
    const res = await request(buildApp()).get("/api/nope");
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(res.body).error.code).toBe("not_found");
  });
});

describe("authentication", () => {
  it.each(["/api/sources", "/api/decks", "/api/cards"])("%s rejects unauthenticated requests with 401", async (path) => {
    const res = await request(buildApp()).get(path);
    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(res.body).error.code).toBe("unauthorized");
  });

  it("rejects unauthenticated writes before reading the body", async () => {
    const res = await request(buildApp()).post("/api/sources").send({ title: "x" });
    expect(res.status).toBe(401);
  });
});

describe("request handling", () => {
  const authed = () => buildApp({ authenticate: async () => "00000000-0000-4000-8000-000000000001" });

  it("returns 400 invalid_json for malformed JSON", async () => {
    const res = await request(authed())
      .post("/api/sources")
      .set("Content-Type", "application/json")
      .send('{"title": ');
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(res.body).error.code).toBe("invalid_json");
  });

  it("returns 400 validation_error for a non-UUID id, before touching the database", async () => {
    const res = await request(authed()).get("/api/sources/not-a-uuid");
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(res.body).error.code).toBe("validation_error");
  });

  it("returns field-level issues for an invalid body", async () => {
    const res = await request(authed()).post("/api/sources").send({ title: "", sourceType: "pdf" });
    expect(res.status).toBe(400);
    const body = apiErrorSchema.parse(res.body);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.issues?.map((i) => i.path)).toEqual(expect.arrayContaining(["title", "sourceType", "contentText"]));
  });
});

describe("CORS", () => {
  it("advertises only the configured origin", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/health").set("Origin", origin);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    // Browsers block any page whose origin does not match this header.
    const other = await request(app).get("/api/health").set("Origin", "http://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBe(origin);
    expect(other.headers["access-control-allow-origin"]).not.toBe("http://evil.example");
  });
});
