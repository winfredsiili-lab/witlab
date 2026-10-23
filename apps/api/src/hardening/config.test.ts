import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEnv } from "../config/env.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const envKeys = [...read("apps/api/src/config/env.ts").matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);

describe("configuration is documented and safe", () => {
  it("finds the settings in the env schema", () => {
    expect(envKeys.length).toBeGreaterThan(15);
    expect(envKeys).toContain("EVALUATION_DAILY_LIMIT");
  });

  it(".env.example mentions every setting the server reads", () => {
    const example = read(".env.example");
    const missing = envKeys.filter((k) => !new RegExp(`^#?\\s*${k}=`, "m").test(example));
    expect(missing).toEqual([]);
  });

  it(".env.example contains no real-looking secrets", () => {
    const example = read(".env.example");
    expect(example).not.toMatch(/gsk_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,}/);
    expect(example).not.toMatch(/^AI_API_KEY=\S+/m);
  });

  it("the server refuses to start with unsafe or missing settings", () => {
    const ok = { DATABASE_URL: "postgresql://u:p@localhost:5432/x" };
    expect(() => parseEnv({ ...ok } as never)).not.toThrow();
    expect(() => parseEnv({} as never)).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ ...ok, AUTH_MODE: "dev-stub", NODE_ENV: "production" } as never)).toThrow(/dev-stub/);
    expect(() => parseEnv({ ...ok, EVALUATION_DAILY_LIMIT: "0" } as never)).toThrow();
    expect(() => parseEnv({ ...ok, AI_TIMEOUT_MS: "10" } as never)).toThrow();
    expect(() => parseEnv({ ...ok, CORS_ORIGIN: "not a url" } as never)).toThrow();
  });

  it("AI settings are optional: the app runs without a key", () => {
    expect(parseEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/x" } as never).AI_API_KEY).toBeUndefined();
  });

  it("the README mentions how to run every npm script the project defines for checks", () => {
    const readme = read("README.md");
    for (const cmd of ["npm run migrate", "npm test", "npm run check:db", "npm run e2e:written"]) expect(readme, cmd).toContain(cmd);
  });
});
