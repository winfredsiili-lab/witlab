import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import type pg from "pg";
import { createApp, type AppDependencies } from "../app.js";
import { createDatabaseCheck, createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { cookieAuthenticate } from "../modules/auth/auth.routes.js";
import { ensureUserByEmail } from "../modules/users/user.repository.js";

/** Integration tests truncate nothing, but they still must never run against a development database. */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run tests against database "${name}". The test database name must end with "_test".`);
  }
}

export function getTestDatabaseUrl(): string {
  loadDotenv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need a real PostgreSQL database whose name ends in _test. " +
        "See README.md (Testing). Use `npm run test:unit` to run only the tests that need no database.",
    );
  }
  assertTestDatabase(url);
  return url;
}

/** Opens a pool on the test database and makes sure the schema is current. */
export async function openTestPool(): Promise<pg.Pool> {
  const pool = createPool(getTestDatabaseUrl());
  await runMigrations(pool);
  return pool;
}

/** Every test creates its own users, so tests are isolated from each other and can run in parallel. */
export async function createTestUser(pool: pg.Pool, label = "user"): Promise<string> {
  return ensureUserByEmail(pool, `${label}-${randomUUID()}@test.local`, label);
}

/**
 * App wired to the real database. The acting user comes from the x-test-user-id header.
 * Pass `now` to control the clock (for scheduling tests).
 */
export function createTestApp(
  pool: pg.Pool,
  now?: () => Date,
  extra: Pick<AppDependencies, "aiProvider" | "generationLimits" | "evaluationLimits"> = {},
): Express {
  return createApp({
    corsOrigin: "http://localhost:5173",
    checkDatabase: createDatabaseCheck(pool),
    authenticate: async (req) => req.header("x-test-user-id") ?? null,
    pool,
    now,
    ...extra,
  });
}

/** App using the REAL cookie sign-in (for auth tests). */
export function createAuthTestApp(pool: pg.Pool, auth: AppDependencies["auth"] = {}, now?: () => Date): Express {
  return createApp({
    corsOrigin: "http://localhost:5173",
    checkDatabase: createDatabaseCheck(pool),
    authenticate: cookieAuthenticate(pool),
    pool,
    now,
    auth,
  });
}

type Method = "get" | "post" | "put" | "patch" | "delete";

/** supertest client that acts as one user. */
export function asUser(app: Express, userId: string) {
  const client = request(app);
  const call = (method: Method) => (url: string) => client[method](url).set("x-test-user-id", userId);
  return {
    get: call("get"),
    post: call("post"),
    put: call("put"),
    patch: call("patch"),
    delete: call("delete"),
  };
}
