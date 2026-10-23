/**
 * Manual end-to-end smoke test: approved cards that are in no deck can be found, read, filed into a deck and studied.
 * (Found by a real user: approving without choosing a deck left cards that could not be studied and could not be read.)
 * No AI needed.
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
await db.query("TRUNCATE decks, cards, sources, generation_jobs, study_sessions, user_preferences CASCADE");

const results = [];
const problems = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const browser = await chromium.launch(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH, args: ["--no-sandbox"] } : { channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = (name) => page.screenshot({ path: `${SP}/${name}.png`, fullPage: true });
const api = async (method, path, body) => (await page.request.fetch(`${BASE}/api${path}`, { method, data: body, headers: { "content-type": "application/json" } })).json();

try {
  await api("POST", "/cards", { cardType: "term_definition", prompt: "What is an availability zone?", answer: "An isolated location within a region.", explanation: "Zones have independent power." });
  await api("POST", "/cards", { cardType: "short_answer", prompt: "What does VM stand for?", answer: "virtual machine" });
  await page.goto(`${BASE}/library`);
  await page.getByTestId("orphan-notice").waitFor();
  check("Library warns that approved cards in no deck cannot be studied", /2 approved cards are not in any deck/.test(await page.getByTestId("orphan-notice").innerText()));

  const row = page.getByTestId("library-card").filter({ hasText: "What is an availability zone?" });
  check("card shows it cannot be studied", (await row.getByText("not in a deck: cannot be studied").count()) === 1);
  await row.locator("summary").click();
  check("opening a card shows its answer and explanation", (await row.getByText("An isolated location within a region.").count()) === 1 && (await row.getByText("Zones have independent power.").count()) === 1);
  check("it says the card is in no decks and there is no deck to add it to yet", (await row.getByText("In decks: none").count()) === 1 && (await row.getByText("Create a deck above").count()) === 1);
  await shot("lib-1-orphan");

  await page.getByRole("button", { name: "New deck" }).click();
  await page.getByLabel("Deck title").fill("My first deck");
  await page.getByRole("button", { name: "Create deck" }).click();
  await page.waitForURL(/\/decks\//);
  await page.goto(`${BASE}/library`);
  const row2 = page.getByTestId("library-card").filter({ hasText: "What is an availability zone?" });
  await row2.locator("summary").click();
  await row2.getByLabel(/Add to deck/).selectOption({ label: "My first deck" });
  await row2.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText(/1 approved card is not in any deck/).waitFor();
  check("adding to a deck updates the warning (1 left)", true);
  check("card now lists its deck", (await row2.getByText("In decks: My first deck").count()) === 1 || (await row2.getByRole("link", { name: "My first deck" }).count()) === 1);

  const row3 = page.getByTestId("library-card").filter({ hasText: "What does VM stand for?" });
  await row3.locator("summary").click();
  await row3.getByLabel(/Add to deck/).selectOption({ label: "My first deck" });
  await row3.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="orphan-notice"]'));
  check("warning disappears once every approved card is in a deck", true);

  await page.getByRole("link", { name: "My first deck" }).first().click();
  await page.getByTestId("deck-overview").filter({ hasText: "2 new" }).waitFor();
  check("the deck now has 2 studyable cards", true);
  await page.getByRole("button", { name: "Start studying" }).click();
  await page.waitForURL(/\/study\//);
  await page.getByTestId("prompt").waitFor();
  check("studying starts", true);
  await shot("lib-2-studying");

  await page.goto(`${BASE}/library`);
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByText("No cards here").waitFor();
  check("filters work (no drafts)", true);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByRole("button", { name: /^All/ }).click();
  check("no horizontal scroll at phone width", await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
} catch (err) {
  check("script completed", false, String(err).split("\n")[0]);
  await shot("lib-error").catch(() => undefined);
} finally {
  check("no console errors, page errors or 5xx", problems.length === 0, problems.join(" | "));
  await browser.close();
  await db.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
