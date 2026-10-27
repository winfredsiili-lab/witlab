import pg from "pg";
import type { DependencyStatus } from "@witlab/contracts";

export function createPool(databaseUrl: string): pg.Pool {
  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get("sslmode");
  const needsSsl =
    sslMode === "require" ||
    sslMode === "verify-ca" ||
    sslMode === "verify-full" ||
    url.hostname.endsWith("render.com") ||
    url.hostname.includes("render.com");
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 3000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
}

/** A function that reports whether the database is reachable. Injected into the app so tests can control it. */
export type DatabaseCheck = () => Promise<DependencyStatus>;

/** Really runs `SELECT 1` against PostgreSQL. Failure is reported, never hidden. */
export function createDatabaseCheck(pool: pg.Pool): DatabaseCheck {
  return async () => {
    const started = Date.now();
    try {
      await pool.query("SELECT 1");
      return { status: "ok", latencyMs: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Database connection failed";
      return { status: "error", message };
    }
  };
}
