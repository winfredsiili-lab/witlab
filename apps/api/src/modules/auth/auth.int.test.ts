import request from "supertest";
import type { Express } from "express";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authSessionSchema } from "@witlab/contracts";
import { createAuthTestApp, openTestPool } from "../../testing/testDb.js";
import { createThrottle } from "./throttle.js";
import { ensureUserByEmail } from "../users/user.repository.js";

let pool: pg.Pool;
let app: Express;
const PW = "a long unusual passphrase";
const CARD = (prompt: string) => ({ cardType: "term_definition", prompt, answer: "yes" });
const email = () => `auth-${randomUUID()}@test.local`;

beforeAll(async () => {
  pool = await openTestPool();
  app = createAuthTestApp(pool, { allowClaimLegacyAccounts: true });
});
afterAll(async () => {
  await pool.end();
});

async function register(a: Express = app, e = email(), password = PW) {
  const agent = request.agent(a);
  const res = await agent.post("/api/auth/register").send({ email: e, password, displayName: "Ada" });
  return { agent, res, email: e };
}
const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[] | undefined)?.find((c) => c.startsWith("witlab_session="));

describe("register", () => {
  it("creates the account, signs in, and sets a safe cookie", async () => {
    const { agent, res } = await register();
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ displayName: "Ada" });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
    const c = cookieOf(res)!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/Expires=/);
    const s = await agent.get("/api/auth/session");
    expect(s.status).toBe(200);
    authSessionSchema.parse(s.body);
  });
  it("stores only a hash of the token and a hash of the password", async () => {
    const { res, email: e } = await register();
    const token = decodeURIComponent(cookieOf(res)!.split(";")[0]!.split("=")[1]!);
    const rows = await pool.query("SELECT token_hash FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1", [e]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].token_hash).not.toBe(token);
    const u = await pool.query("SELECT password_hash FROM users WHERE email = $1", [e]);
    expect(u.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(u.rows[0].password_hash).not.toContain(PW);
  });
  it("lowercases and trims the email, and refuses a duplicate in any case", async () => {
    const e = email();
    expect((await register(app, `  ${e.toUpperCase()}  `)).res.status).toBe(201);
    const dup = await register(app, e);
    expect(dup.res.status).toBe(409);
    expect(dup.res.body.error.code).toBe("email_in_use");
  });
  it("rejects weak passwords, bad emails and unknown fields", async () => {
    expect((await register(app, email(), "short")).res.status).toBe(400);
    expect((await register(app, email(), "password123")).res.status).toBe(400);
    expect((await request(app).post("/api/auth/register").send({ email: "nope", password: PW })).status).toBe(400);
    expect((await request(app).post("/api/auth/register").send({ email: email(), password: PW, isAdmin: true })).status).toBe(400);
  });
  it("can be closed", async () => {
    const closed = createAuthTestApp(pool, { allowRegistration: false });
    const r = await register(closed);
    expect(r.res.status).toBe(403);
    expect(r.res.body.error.code).toBe("registration_closed");
  });
});

describe("claiming an account made before sign-in existed", () => {
  it("lets one set a password on a legacy account (development only) and keeps its data", async () => {
    const e = email();
    const id = await ensureUserByEmail(pool, e, "Legacy");
    await pool.query("INSERT INTO sources (user_id, title, kind) VALUES ($1, 'Old source', 'text')", [id]).catch(() => undefined);
    const r = await register(app, e);
    expect(r.res.status).toBe(201);
    expect(r.res.body.user.id).toBe(id);
    // A second registration cannot take it over again.
    expect((await register(app, e)).res.status).toBe(409);
  });
  it("is refused when claiming is not allowed (production behaviour)", async () => {
    const e = email();
    await ensureUserByEmail(pool, e, "Legacy");
    const strict = createAuthTestApp(pool, { allowClaimLegacyAccounts: false });
    expect((await register(strict, e)).res.status).toBe(409);
  });
  it("a legacy account with no password cannot sign in", async () => {
    const e = email();
    await ensureUserByEmail(pool, e, "Legacy");
    const res = await request(app).post("/api/auth/login").send({ email: e, password: PW });
    expect(res.status).toBe(401);
  });
});

describe("login and logout", () => {
  it("signs in with the right password and starts a separate session", async () => {
    const { email: e } = await register();
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/login").send({ email: e.toUpperCase(), password: PW });
    expect(res.status).toBe(200);
    expect((await agent.get("/api/auth/session")).status).toBe(200);
  });
  it("gives the same generic error for a wrong password and an unknown email", async () => {
    const { email: e } = await register();
    const wrong = await request(app).post("/api/auth/login").send({ email: e, password: "wrong password here" });
    const unknown = await request(app).post("/api/auth/login").send({ email: email(), password: "wrong password here" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(cookieOf(wrong)).toBeUndefined();
  });
  it("throttles repeated failures, then still blocks even the right password until the window passes", async () => {
    const throttled = createAuthTestApp(pool, { loginThrottle: createThrottle({ max: 3, windowMs: 60_000 }) });
    const { email: e } = await register(throttled);
    for (let i = 0; i < 3; i++) expect((await request(throttled).post("/api/auth/login").send({ email: e, password: "wrong password here" })).status).toBe(401);
    const blocked = await request(throttled).post("/api/auth/login").send({ email: e, password: PW });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("too_many_attempts");
  });
  it("logout ends the session on the server, not just in the browser", async () => {
    const { agent, res } = await register();
    const stolen = cookieOf(res)!.split(";")[0]!;
    expect((await agent.post("/api/auth/logout").send({})).status).toBe(204);
    expect((await agent.get("/api/auth/session")).status).toBe(401);
    expect((await request(app).get("/api/auth/session").set("Cookie", stolen)).status).toBe(401);
  });
  it("logout without a session is harmless", async () => {
    expect((await request(app).post("/api/auth/logout").send({})).status).toBe(204);
  });
});

describe("sessions", () => {
  it("rejects missing, garbage, and forged cookies", async () => {
    expect((await request(app).get("/api/auth/session")).status).toBe(401);
    expect((await request(app).get("/api/auth/session").set("Cookie", "witlab_session=garbage")).status).toBe(401);
    expect((await request(app).get("/api/auth/session").set("Cookie", `witlab_session=${"A".repeat(43)}`)).status).toBe(401);
  });
  it("expired sessions stop working and can be purged", async () => {
    const { agent, email: e } = await register();
    await pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [e]);
    expect((await agent.get("/api/auth/session")).status).toBe(401);
    const purged = await pool.query("DELETE FROM auth_sessions WHERE expires_at < now() RETURNING 1");
    expect(purged.rowCount).toBeGreaterThan(0);
  });
  it("sessions last SESSION_DAYS", async () => {
    const short = createAuthTestApp(pool, { sessionDays: 2 });
    const { email: e } = await register(short);
    const r = await pool.query("SELECT extract(epoch FROM expires_at - created_at) / 86400 AS days FROM auth_sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)", [e]);
    expect(Math.round(Number(r.rows[0].days))).toBe(2);
  });
  it("protected API routes work with the cookie and 401 without it", async () => {
    const { agent } = await register();
    expect((await agent.get("/api/me")).status).toBe(200);
    expect((await request(app).get("/api/me")).status).toBe(401);
    expect((await request(app).get("/api/cards")).status).toBe(401);
  });
  it("two accounts never see each other's data through cookies", async () => {
    const a = await register();
    const b = await register();
    const card = await a.agent.post("/api/cards").send(CARD("Only A can see this?"));
    expect([200, 201]).toContain(card.status);
    const list = await b.agent.get("/api/cards");
    expect(JSON.stringify(list.body)).not.toContain("Only A can see this");
  });
});

describe("cross-site protection", () => {
  it("refuses a state-changing request whose Origin is another site", async () => {
    const { agent } = await register();
    const res = await agent.post("/api/auth/logout-all").set("Origin", "https://evil.example").send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("bad_origin");
    expect((await agent.get("/api/auth/session")).status).toBe(200);
  });
  it("allows the app's own origin and requests with no Origin", async () => {
    const { agent } = await register();
    expect((await agent.post("/api/cards").set("Origin", "http://localhost:5173").send(CARD("Own origin?"))).status).toBeLessThan(300);
    expect((await agent.get("/api/me").set("Origin", "https://evil.example")).status).toBe(200); // reads are not state changes; CORS stops the page reading them
  });
});

describe("change password", () => {
  it("requires the current password, then signs out other devices but not this one", async () => {
    const { agent, email: e } = await register();
    const other = request.agent(app);
    await other.post("/api/auth/login").send({ email: e, password: PW });
    expect((await agent.post("/api/auth/password").send({ currentPassword: "not my password", newPassword: "another long passphrase" })).status).toBe(403);
    expect((await other.get("/api/auth/session")).status).toBe(200);

    expect((await agent.post("/api/auth/password").send({ currentPassword: PW, newPassword: "another long passphrase" })).status).toBe(204);
    expect((await other.get("/api/auth/session")).status).toBe(401);
    expect((await agent.get("/api/auth/session")).status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ email: e, password: PW })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: e, password: "another long passphrase" })).status).toBe(200);
  });
  it("applies the password policy to the new password", async () => {
    const { agent } = await register();
    const res = await agent.post("/api/auth/password").send({ currentPassword: PW, newPassword: "password123" });
    expect(res.status).toBe(400);
  });
  it("log out everywhere ends every session", async () => {
    const { agent, email: e } = await register();
    const other = request.agent(app);
    await other.post("/api/auth/login").send({ email: e, password: PW });
    expect((await agent.post("/api/auth/logout-all").send({})).status).toBe(204);
    expect((await other.get("/api/auth/session")).status).toBe(401);
    expect((await agent.get("/api/auth/session")).status).toBe(401);
  });
});

describe("delete account", () => {
  it("needs the right password and then leaves nothing behind in any table", async () => {
    const { agent, res, email: e } = await register();
    const id = res.body.user.id as string;
    await agent.post("/api/cards").send(CARD("Delete me?"));
    await agent.post("/api/decks").send({ title: "Mine" });

    const wrong = await agent.post("/api/auth/delete-account").send({ password: "not my password" });
    expect(wrong.status).toBe(403);
    expect((await agent.get("/api/auth/session")).status).toBe(200);

    expect((await agent.post("/api/auth/delete-account").send({ password: PW })).status).toBe(204);
    expect((await agent.get("/api/auth/session")).status).toBe(401);

    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id'",
    );
    expect(tables.rows.length).toBeGreaterThan(5);
    for (const { table_name } of tables.rows) {
      const left = await pool.query(`SELECT count(*)::int AS n FROM "${table_name}" WHERE user_id = $1`, [id]);
      expect(left.rows[0].n, table_name).toBe(0);
    }
    expect((await pool.query("SELECT 1 FROM users WHERE id = $1", [id])).rowCount).toBe(0);
    expect((await request(app).post("/api/auth/login").send({ email: e, password: PW })).status).toBe(401);
  });
  it("does not touch other accounts", async () => {
    const a = await register();
    const b = await register();
    await b.agent.post("/api/cards").send(CARD("B keeps this?"));
    await a.agent.post("/api/auth/delete-account").send({ password: PW });
    const list = await b.agent.get("/api/cards");
    expect(JSON.stringify(list.body)).toContain("B keeps this");
  });
});
