import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "./password.js";
import { createThrottle } from "./throttle.js";

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });
  it("salts: the same password hashes differently and never contains the password", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct horse");
    expect(a.startsWith("scrypt$")).toBe(true);
  });
  it("rejects malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1$2$3$4$5")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1073741824$8$1$AAAA$AAAA")).toBe(false);
  });
});

describe("password policy", () => {
  it("accepts a long passphrase", () => expect(passwordProblem("a long unusual passphrase", "a@b.co")).toBeNull());
  it("rejects one repeated character", () => expect(passwordProblem("aaaaaaaaaaaa", "a@b.co")).not.toBeNull());
  it("rejects common passwords", () => expect(passwordProblem("password123", "a@b.co")).not.toBeNull());
  it("rejects a password that is the email", () => expect(passwordProblem("someone@example.com", "someone@example.com")).not.toBeNull());
});

describe("login throttle", () => {
  it("locks after max failures, unlocks after the window, and resets on success", () => {
    let t = 0;
    const th = createThrottle({ max: 3, windowMs: 60_000, now: () => t });
    th.fail("k");
    th.fail("k");
    expect(th.retryAfter("k")).toBe(0);
    th.fail("k");
    expect(th.retryAfter("k")).toBeGreaterThan(0);
    expect(th.retryAfter("other")).toBe(0);
    t = 61_000;
    expect(th.retryAfter("k")).toBe(0);
    th.fail("k");
    th.succeed("k");
    th.fail("k");
    th.fail("k");
    expect(th.retryAfter("k")).toBe(0);
  });
});
