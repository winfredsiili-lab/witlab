import { loadEnv } from "../config/env.js";
import { createPool } from "../db/pool.js";
import { runIntegrityChecks } from "./integrity.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);
try {
  const results = await runIntegrityChecks(pool);
  for (const r of results) {
    const mark = r.violations === 0 ? "ok     " : r.severity === "error" ? "FAILED " : "WARNING";
    console.log(`${mark} ${r.name}${r.violations ? `: ${r.violations} row(s), e.g. ${r.sample.join(", ")}  (${r.rule})` : ""}`);
  }
  const errors = results.filter((r) => r.severity === "error" && r.violations > 0).length;
  const warnings = results.filter((r) => r.severity === "warning" && r.violations > 0).length;
  console.log(`\n${results.length} checks: ${errors} failed, ${warnings} warning(s).`);
  if (errors > 0) process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
