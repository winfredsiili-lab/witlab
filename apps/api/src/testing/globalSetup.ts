import { config as loadDotenv } from "dotenv";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { assertTestDatabase } from "./testDb.js";

/** Migrates the test database once before any test file runs. Does nothing if TEST_DATABASE_URL is unset. */
export default async function setup(): Promise<void> {
  loadDotenv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  assertTestDatabase(url);
  const pool = createPool(url);
  try {
    await runMigrations(pool);
    // The daily AI limits count rows from the last 24 hours across ALL users, so earlier runs would make later runs fail.
    // This is a dedicated test database (checked above), so start every run with empty ledgers.
    await pool.query("TRUNCATE generation_jobs, ai_evaluations");
  } finally {
    await pool.end();
  }
}
