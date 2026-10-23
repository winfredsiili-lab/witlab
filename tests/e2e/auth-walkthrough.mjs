/**
 * Manual end-to-end smoke test of real sign-in. Start the API with AUTH_MODE=password (the default) against a *_e2e database.
 * Covers: redirect to sign-in, register, validation, persistence across reload, sign out, return-to page, wrong password,
 * password change signing out another browser, and account deletion.
 */
import { chromium } from "playwright-core";
import pg from "pg";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const SP = process.env.E2E_SCREENSHOT_DIR ?? fileURLToPath(new URL("./screenshots", import.meta.url));
mkdirSync(SP, { recursive: true });
const dbUrl = process.env.E2E_DATABASE_URL;
if (!dbUrl) { console.error("Set E2E_DATABASE_URL (name must end in _e2e)."); process.exit(2); }
if (!new URL(dbUrl).pathname.replace(/^\//, "").endsWith("_e2e")) { console.error("Refusing: database name must end in _e2e."); process.exit(2); }
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await db.query("TRUNCATE users CASCADE");

const results = [];
const problems = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const browser = await chromium.launch(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH, args: ["--no-sandbox"] } : { channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = (n) => page.screenshot({ path: `${SP}/${n}.png`, fullPage: true });

const EMAIL = "ada@e2e.test";
const PW = "orbit candle meadow tile";
const PW2 = "harbor violet lantern stone";

try {
  await page.goto(`${BASE}/library`);
  await page.waitForURL(/\/login/);
  check("an unauthenticated visitor is sent to the sign-in page", (await page.getByRole("heading", { name: "Sign in" }).count()) === 1);
  await shot("auth-1-login");

  await page.getByRole("button", { name: "Sign in" }).click();
  check("empty form is stopped by the browser (still on sign in)", /\/login/.test(page.url()));
  await page.getByLabel("Email").fill("nobody@e2e.test");
  await page.getByLabel("Password").fill("whatever password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").waitFor();
  check("unknown account gets the generic message", /Email or password is incorrect/.test(await page.getByRole("alert").innerText()));

  await page.getByRole("link", { name: "Create an account" }).click();
  await page.waitForURL(/\/register/);
  await page.getByLabel("Name (optional)").fill("Ada");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByLabel("Repeat password").fill("something different here");
  await page.getByRole("button", { name: "Create account" }).click();
  check("mismatched passwords are caught before anything is sent", /do not match/.test(await page.getByRole("alert").innerText()));
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByLabel("Repeat password").fill("password123");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => /too common/.test(document.querySelector('[role="alert"]')?.textContent ?? ""));
  check("a common password is refused with a reason", true);
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByLabel("Repeat password").fill(PW);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(`${BASE}/library`);
  check("registering signs you in and returns you to the page you wanted", /\/library$/.test(page.url()));
  check("the sidebar shows who is signed in", (await page.locator(".wl-user").innerText()).includes("Ada"));
  await shot("auth-2-signed-in");

  check("the session cookie is not readable by page scripts", !(await page.evaluate(() => document.cookie)).includes("witlab_session"));
  const cookie = (await ctx.cookies()).find((c) => c.name === "witlab_session");
  check("cookie is HttpOnly and SameSite=Lax", !!cookie?.httpOnly && cookie.sameSite === "Lax");

  await page.reload();
  await page.getByRole("heading", { name: /Library/ }).first().waitFor();
  check("staying signed in across a reload", /\/library$/.test(page.url()));

  await page.locator(".wl-user").getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  await page.goto(`${BASE}/progress`);
  await page.waitForURL(/\/login/);
  check("after signing out, app pages are closed again", true);
  const apiStatus = await page.evaluate(async () => (await fetch("/api/cards")).status);
  check("and the API refuses without a session", apiStatus === 401);

  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill("not the right password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").waitFor();
  check("wrong password gets the same generic message", /Email or password is incorrect/.test(await page.getByRole("alert").innerText()));
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${BASE}/progress`);
  check("signing in returns you to the page you tried to open", /\/progress$/.test(page.url()));

  // A second browser (separate cookies) signs in, then the first changes the password.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto(`${BASE}/login`);
  await page2.getByLabel("Email").fill(EMAIL);
  await page2.getByLabel("Password").fill(PW);
  await page2.getByRole("button", { name: "Sign in" }).click();
  await page2.waitForURL(`${BASE}/`);

  await page.goto(`${BASE}/settings`);
  const pwForm = page.getByRole("form", { name: "Change password" });
  await pwForm.getByLabel("Current password").fill("wrong current password");
  await pwForm.getByLabel("New password", { exact: true }).fill(PW2);
  await pwForm.getByLabel("Repeat new password").fill(PW2);
  await pwForm.getByRole("button", { name: "Change password" }).click();
  await pwForm.getByRole("alert").waitFor();
  check("changing password needs the right current password", /not correct/.test(await pwForm.getByRole("alert").innerText()));
  await pwForm.getByLabel("Current password").fill(PW);
  await pwForm.getByRole("button", { name: "Change password" }).click();
  await page.getByText(/Password changed/).waitFor();
  check("password changes", true);
  await shot("auth-3-settings");

  await page2.goto(`${BASE}/library`);
  await page2.waitForURL(/\/login/);
  check("the other browser was signed out by the password change", true);
  check("this browser stayed signed in", (await page.evaluate(async () => (await fetch("/api/auth/session")).status)) === 200);
  await ctx2.close();

  // Add data, then delete the account.
  await page.evaluate(async () => { await fetch("/api/cards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardType: "term_definition", prompt: "Delete me?", answer: "yes" }) }); });
  await page.getByRole("button", { name: "Delete my account…" }).click();
  const del = page.getByRole("form", { name: "Confirm account deletion" });
  await del.getByLabel("Enter your password to confirm").fill("wrong");
  await del.getByRole("button", { name: "Permanently delete everything" }).click();
  await del.getByRole("alert").waitFor();
  check("deleting with the wrong password deletes nothing", /Nothing was deleted/.test(await del.getByRole("alert").innerText()) && (await db.query("SELECT 1 FROM users WHERE email=$1", [EMAIL])).rowCount === 1);
  await del.getByLabel("Enter your password to confirm").fill(PW2);
  await del.getByRole("button", { name: "Permanently delete everything" }).click();
  await page.waitForURL(/\/login/);
  const left = await db.query("SELECT (SELECT count(*) FROM users WHERE email=$1)::int AS users, (SELECT count(*) FROM cards)::int AS cards, (SELECT count(*) FROM auth_sessions)::int AS sessions", [EMAIL]);
  check("account deleted: user, cards and sessions are gone", left.rows[0].users === 0 && left.rows[0].cards === 0 && left.rows[0].sessions === 0, JSON.stringify(left.rows[0]));
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PW2);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").waitFor();
  check("the deleted account can no longer sign in", /Email or password is incorrect/.test(await page.getByRole("alert").innerText()));
} catch (err) {
  check("script completed without throwing", false, String(err).split("\n")[0]);
  await shot("auth-error").catch(() => {});
}

check("no page errors or server errors", problems.length === 0, problems.join(" | "));
await browser.close();
await db.end();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
