/**
 * Manual end-to-end smoke test of the one-step "Make a deck" flow, automatic decks, and read-through.
 * Needs AI stub env (AI_API_KEY=e2e-key AI_BASE_URL=http://127.0.0.1:4999/v1) and AUTH_MODE=dev-stub. The AI is a local stub.
 */
import { chromium } from "playwright-core";
import pg from "pg";
import { createServer } from "node:http";
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
await db.query("TRUNCATE decks, cards, sources, generation_jobs, ai_evaluations, study_sessions, user_preferences CASCADE");

const card = (prompt, answer, quote) => ({ card_type: "term_definition", prompt, answer, explanation: "From the passage.", choices: [], correct_choice_index: -1, accepted_answers: [], numeric_answer: "", numeric_tolerance: "", quote });
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const user = JSON.parse(raw).messages[1].content;
    res.setHeader("content-type", "application/json");
    const cards = user.includes("NOTHING_HERE") ? [] : [
      card("What is an availability zone?", "An isolated location within a region.", "An availability zone is an isolated location within a region."),
      card("What do zones have independently?", "Power, cooling and networking.", "Zones have independent power, cooling and networking."),
    ];
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ cards }) } }] }));
  });
});
await new Promise((r) => stub.listen(Number(process.env.E2E_AI_PORT ?? 4999), "127.0.0.1", r));

const results = [];
const problems = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const browser = await chromium.launch(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH, args: ["--no-sandbox"] } : { channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = (n) => page.screenshot({ path: `${SP}/${n}.png`, fullPage: true });
const TEXT = "An availability zone is an isolated location within a region. Zones have independent power, cooling and networking.";

async function makeDeck(title, text, skip, deckName = "") {
  await page.goto(`${BASE}/sources/new`);
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Text", { exact: true }).fill(text);
  if (deckName) await page.getByLabel(/Deck name/).fill(deckName);
  if (skip) await page.getByLabel(/Skip review/).check();
}

try {
  await makeDeck("Cloud basics", TEXT, false);
  await shot("make-1-form");
  check("the form offers AI card writing and skip-review (off by default, with a warning)", (await page.getByLabel(/Skip review/).isChecked()) === false && /AI can get things wrong/.test(await page.locator("body").innerText()));
  await page.getByLabel(/Skip review/).check();
  await page.getByRole("button", { name: "Make my deck" }).click();
  await page.waitForURL(/\/decks\//);
  await page.getByRole("heading", { name: "Cloud basics" }).waitFor();
  check("skip review: you land on a ready deck named after the source", (await page.getByRole("heading", { name: "Cloud basics" }).count()) === 1);
  const rows = await db.query("SELECT c.status, c.origin FROM cards c JOIN deck_cards dc ON dc.card_id = c.id");
  check("both cards are approved, in the deck, and still marked AI-made", rows.rowCount === 2 && rows.rows.every((r) => r.status === "approved" && r.origin === "ai_generated"));
  check("Study starts in one click with the mode tucked away", (await page.getByRole("button", { name: "Start studying" }).isEnabled()) && (await page.getByText(/Study mode:/).count()) === 1);

  // Default path: review first, automatic deck on approve.
  await makeDeck("Zones deep dive", TEXT, false);
  await page.getByRole("button", { name: "Make cards to review" }).click();
  await page.waitForURL(/\/review\?sourceId=/);
  await page.getByTestId("review-draft").first().waitFor();
  check("without skip, the drafts wait in To review", (await page.getByTestId("review-draft").count()) === 2);
  check("the review tab shows a count and the deck choice defaults to automatic", (await page.getByRole("link", { name: /To review \(2\)/ }).count()) === 1 && (await page.getByLabel("Put approved cards in").inputValue()) === "auto");
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: /Approve/ }).first().click();
  await page.getByText(/added to “Zones deep dive”/).waitFor();
  const deck = await db.query("SELECT count(*)::int AS n FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE d.title = 'Zones deep dive'");
  check("approving needs no deck picking: a deck named after the source is created and filled", deck.rows[0].n === 2);

  await page.goto(`${BASE}/library`);
  check("Library shows no 'cannot be studied' warning", (await page.getByTestId("orphan-notice").count()) === 0);

  // Failure leaves the source but no deck.
  await makeDeck("Empty source", "NOTHING_HERE " + TEXT, true);
  await page.getByRole("button", { name: "Make my deck" }).click();
  await page.getByRole("alert").waitFor();
  const empty = await db.query("SELECT (SELECT count(*) FROM decks WHERE title='Empty source')::int AS decks, (SELECT count(*) FROM sources WHERE title='Empty source')::int AS sources");
  check("if no cards come back: clear message, source kept, no empty deck", /did not find anything/.test(await page.getByRole("alert").innerText()) && empty.rows[0].decks === 0 && empty.rows[0].sources === 1);

  // A long source is read in several parts.
  const LONG = (TEXT + " ").repeat(130);
  await makeDeck("Long source", LONG, true);
  await page.getByRole("button", { name: "Make my deck" }).click();
  await page.waitForURL(/\/decks\//, { timeout: 60000 });
  const parts = await db.query("SELECT count(*)::int AS n FROM generation_jobs j JOIN sources s ON s.id = j.source_id WHERE s.title = 'Long source'");
  check("a long source is read in several parts and still becomes a deck", parts.rows[0].n >= 2, `${parts.rows[0].n} requests`);

  // Read-through.
  await page.goto(`${BASE}/browse`);
  await page.getByTestId("browse-card").first().waitFor();
  check("read-through lists approved cards with answers hidden", (await page.getByTestId("browse-card").count()) >= 4 && (await page.getByText("An isolated location within a region.").count()) === 0);
  const total = await page.getByTestId("browse-card").count();
  await page.getByLabel("Search").fill("independent");
  const some = await page.getByTestId("browse-card").count();
  check("search narrows the list", some >= 1 && some < total);
  await page.getByLabel("Search").fill("");
  await page.getByRole("button", { name: /Read through \d+ cards/ }).click();
  await page.getByRole("button", { name: "Show answer" }).first().click();
  check("card-by-card mode reveals the answer on request and moves on", (await page.getByTestId("read-card").getByText(/Answer:/).count()) === 1);
  await page.getByRole("button", { name: "Next" }).click();
  check("next card starts hidden again", (await page.getByTestId("read-card").getByText(/Answer:/).count()) === 0 && /Card 2 of \d+/.test(await page.getByTestId("read-card").innerText()));
  const ev = await db.query("SELECT (SELECT count(*) FROM study_responses)::int AS r, (SELECT count(*) FROM study_sessions)::int AS s");
  check("reading records nothing: no study responses or sessions", ev.rows[0].r === 0 && ev.rows[0].s === 0);
  await shot("make-2-browse");
} catch (err) {
  check("script completed without throwing", false, String(err).split("\n")[0]);
  await shot("make-error").catch(() => {});
}

check("no page errors or server errors", problems.length === 0, problems.join(" | "));
stub.close();
await browser.close();
await db.end();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
