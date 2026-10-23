import { loadEnv } from "../config/env.js";
import { runMigrations } from "./migrate.js";
import { createPool } from "./pool.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);

try {
  const applied = await runMigrations(pool);
  if (applied.length === 0) {
    console.log("Database is up to date. No migrations applied.");
  } else {
    for (const name of applied) console.log(`Applied ${name}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
