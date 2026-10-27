import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = existsSync(path.join(here, "migrations"))
  ? path.join(here, "migrations")
  : path.join(here, "..", "..", "src", "db", "migrations");

// Arbitrary constant; stops two processes migrating the same database at once.
const MIGRATION_LOCK_ID = 727274;

/**
 * Applies every not-yet-applied `NNNN_name.sql` file in order, each in its own transaction,
 * and records it in `schema_migrations`. Returns the names applied in this run (empty when up to date).
 */
export async function runMigrations(pool: pg.Pool, dir: string = migrationsDir): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
    );

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${file} failed and was rolled back: ${reason}`);
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
