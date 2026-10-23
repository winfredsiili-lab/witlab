import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt from Node's own crypto (no extra dependency). Stored as
 * `scrypt$N$r$p$salt$hash` so the cost can be raised later and old hashes still verify.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const options: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 };
  return new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, KEYLEN, options, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const [nn, rr, pp] = [Number(n), Number(r), Number(p)];
  // Refuse nonsense or abusive cost parameters from a damaged row instead of throwing or burning memory.
  if (![nn, rr, pp].every(Number.isInteger) || nn < 2 || nn > 2 ** 20 || (nn & (nn - 1)) !== 0 || rr < 1 || rr > 32 || pp < 1 || pp > 16) return false;
  try {
    const expected = Buffer.from(hash, "base64");
    const actual = await derive(password, Buffer.from(salt, "base64"), nn, rr, pp);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A hash to verify against when the account does not exist, so "no such user" takes as long as "wrong password". */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("not-a-real-password-for-timing-only");
  return dummy;
}

const COMMON = new Set(
  ["password", "password1", "password12", "password123", "1234567890", "12345678910", "qwertyuiop", "qwerty12345", "iloveyou123", "letmein1234", "welcome1234", "admin12345", "witlab12345", "0123456789", "abcdefghij"],
);

/** Returns a message when the password is unacceptable, otherwise null. Length is checked by the schema. */
export function passwordProblem(password: string, email: string): string | null {
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "That password is too common. Choose something less guessable.";
  if (lower === email.toLowerCase() || lower === email.split("@")[0]!.toLowerCase()) return "The password must not be your email address.";
  if (/^(.)\1+$/.test(password)) return "The password must not be one repeated character.";
  return null;
}
