import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/witlab" };

describe("parseEnv", () => {
  it("applies defaults and accepts a valid configuration", () => {
    const env = parseEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.CORS_ORIGIN).toBe("http://localhost:5173");
    expect(env.AUTH_MODE).toBe("password");
    expect(env.ALLOW_REGISTRATION).toBe(true);
    expect(env.SESSION_DAYS).toBe(30);
    expect(env.DEV_USER_EMAIL).toBe("dev@witlab.local");
  });

  it("coerces PORT from a string", () => {
    expect(parseEnv({ ...base, PORT: "5000" }).PORT).toBe(5000);
  });

  it("fails clearly when DATABASE_URL is missing", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects an invalid CORS origin", () => {
    expect(() => parseEnv({ ...base, CORS_ORIGIN: "not a url" })).toThrow(/CORS_ORIGIN/);
  });

  it("refuses dev-stub authentication in production", () => {
    expect(() => parseEnv({ ...base, AUTH_MODE: "dev-stub", NODE_ENV: "production" })).toThrow(/dev-stub authentication is not allowed/);
  });

  it("allows password sign-in in production", () => {
    expect(parseEnv({ ...base, NODE_ENV: "production" }).AUTH_MODE).toBe("password");
  });

  it("validates registration and session settings", () => {
    expect(parseEnv({ ...base, ALLOW_REGISTRATION: "false" }).ALLOW_REGISTRATION).toBe(false);
    expect(() => parseEnv({ ...base, ALLOW_REGISTRATION: "maybe" })).toThrow();
    expect(() => parseEnv({ ...base, SESSION_DAYS: "0" })).toThrow();
  });

  it("allows dev-stub authentication in development and test", () => {
    expect(() => parseEnv({ ...base, AUTH_MODE: "dev-stub", NODE_ENV: "development" })).not.toThrow();
    expect(() => parseEnv({ ...base, AUTH_MODE: "dev-stub", NODE_ENV: "test" })).not.toThrow();
  });

  it("rejects an unknown AUTH_MODE", () => {
    expect(() => parseEnv({ ...base, AUTH_MODE: "none" })).toThrow(/AUTH_MODE/);
  });
});
