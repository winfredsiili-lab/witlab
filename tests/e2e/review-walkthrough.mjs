/**
 * Manual end-to-end smoke test for Batch 5: the whole loop in a real browser.
 * paste text -> generate drafts (LOCAL STUB AI) -> review screen: edit, approve into a deck -> study -> schedule.
 * Needs the same setup as sources-walkthrough.mjs (API started with AI_API_KEY and AI_BASE_URL pointing at the stub port).
 */
import { chromium } from "playwright-core";
import pg from "pg";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const AI_PORT = Number(process.env.E2E_AI_PORT ?? 4999);
const SP = process.env.E2E_SCREENSHOT_DIR ?? fileURLToPath(new URL("./screenshots", import.meta.url));
mkdirSync(SP, { recursive: true });
const dbUrl = process.env.E2E_DATABASE_URL;
if (!dbUrl) { console.error("Set E2E_DATABASE_URL (name must end in _e2e)."); process.exit(2); }
if (!new URL(dbUrl).pathname.replace(/^\//, "").endsWith("_e2e")) { console.error("Refusing: database name must end in _e2e."); process.exit(2); }
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await db.query("TRUNCATE decks, cards, sources, generation_jobs, study_sessions, user_preferences CASCADE");
await db.query("UPDATE users SET display_name = NULL");

const card = (prompt, answer, quote) => ({ card_type: "term_definition", prompt, answer, explanation: "", choices: [], correct_choice_index: -1, accepted_answers: [], numeric_answer: "", numeric_tolerance: "", quote });
const stubCards = [
  card("What is an availability zone?", "An isolated location within a region.", "An availability zone is an isolated location within a region."),
  card("What do zones have independently?", "Power, cooling and networking.", "Zones have independent power, cooling and networking."),
  card("What is a virtual machine?", "An emulation of a physical computer.", "A virtual machine is an emulation of a physical computer."),
];
const stub = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ cards: stubCards }) } }] }));
  });
});
await new Promise((r) => stub.listen(AI_PORT, "127.0.0.1", r));

const results = [];
const problems = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const browser = await chromium.launch(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH, args: ["--no-sandbox"] } : { channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = (name) => page.screenshot({ path: `${SP}/${name}.png`, fullPage: true });
const one = async (sql) => (await db.query(sql)).rows[0];

try {
  // A deck, then a source with generated drafts
  await page.goto(`${BASE}/library`);
  await page.getByRole("button", { name: "New deck" }).click();
  await page.getByLabel("Deck title").fill("Cloud basics");
  await page.getByRole("button", { name: "Create deck" }).click();
  await page.waitForURL(/\/decks\//);

  await page.goto(`${BASE}/sources/new`);
  await page.getByLabel("Title", { exact: true }).fill("Cloud notes");
  await page.getByLabel("Text", { exact: true }).fill("An availability zone is an isolated location within a region. Zones have independent power, cooling and networking. A virtual machine is an emulation of a physical computer.");
  await page.getByLabel("Write cards from this source with AI").uncheck({ timeout: 1500 }).catch(() => {});
  await page.getByRole("button", { name: "Add source" }).click();
  await page.waitForURL(/\/sources\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Generate cards" }).click();
  await page.getByText("3 drafts created from 3 suggestions.").waitFor();
  check("three drafts generated", true);

  // Nothing studyable yet
  check("drafts are not in any deck or study queue", (await one("SELECT count(*)::int n FROM deck_cards")).n === 0 && (await one("SELECT count(*)::int n FROM cards WHERE status='approved'")).n === 0);

  // Review screen
  await page.getByRole("link", { name: "review screen" }).click();
  await page.getByRole("heading", { name: "Review drafts" }).waitFor();
  await page.getByTestId("review-draft").nth(2).waitFor();
  check("review screen lists the three drafts with their quotes", (await page.getByTestId("review-draft").count()) === 3 && (await page.getByText(/“Zones have independent power/).count()) === 1);
  check("approve buttons are disabled until something is selected", await page.getByRole("button", { name: /Approve selected \(0\)/ }).isDisabled());
  await shot("rev-1-queue");

  // Edit one draft
  const zones = page.getByTestId("review-draft").filter({ hasText: "What do zones have independently?" });
  await zones.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Question").fill("Which three things do availability zones have independently?");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Save changes" }).waitFor({ state: "detached" }); // the editor closes only after the server saved
  await page.getByText("Which three things do availability zones have independently?").waitFor();
  const edited = await one("SELECT prompt, status, revision FROM cards WHERE prompt LIKE 'Which three%'");
  check("edit is saved and the card is still a draft (revision 1)", edited && edited.status === "draft" && edited.revision === 1, JSON.stringify(edited));

  // Reject one, approve the other two into the deck
  const vm = page.getByTestId("review-draft").filter({ hasText: "What is a virtual machine?" });
  await vm.getByLabel(/Select: What is a virtual machine/).check();
  await page.getByRole("button", { name: /Reject selected \(1\)/ }).click();
  await page.getByText("Rejected 1 card.").waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="review-draft"]').length === 2);
  check("one draft rejected and gone from the queue", true);

  await page.getByLabel("Put approved cards in").selectOption({ label: "Cloud basics" });
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: /Approve selected \(2\)/ }).click();
  await page.getByText(/Approved 2 cards and added to “Cloud basics”/).waitFor();
  const state = (await db.query("SELECT status, count(*)::int n FROM cards GROUP BY status ORDER BY status")).rows;
  check("two approved, one rejected", JSON.stringify(state) === JSON.stringify([{ status: "approved", n: 2 }, { status: "rejected", n: 1 }]), JSON.stringify(state));
  await page.getByText("Nothing to review").waitFor();
  check("the queue is now empty", true);
  await shot("rev-2-done");

  // Study them
  await page.getByRole("link", { name: "Open the deck" }).click();
  await page.getByTestId("deck-overview").filter({ hasText: "2 new" }).waitFor();
  check("deck shows 2 new studyable cards", true);
  await page.getByRole("button", { name: "Start studying" }).click();
  await page.waitForURL(/\/study\//);
  await page.getByTestId("prompt").waitFor();
  const first = await page.getByTestId("prompt").innerText();
  check("study starts with an approved card (never the rejected one)", !/virtual machine/i.test(first), first);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Show answer" }).click();
    await page.getByRole("button", { name: "I got it right" }).click();
    await page.getByTestId("feedback").waitFor();
    check(`card ${i + 1} scheduled for tomorrow`, /1 day/.test(await page.getByTestId("next-review").innerText()));
    await page.getByRole("button", { name: i === 0 ? "Next card" : "See summary" }).click();
  }
  await page.getByRole("button", { name: "Study more" }).waitFor();
  const reviewed = await one("SELECT count(*)::int n FROM card_review_state");
  check("review state exists only for the two approved cards", reviewed.n === 2);
  const provenance = await one("SELECT count(*)::int n FROM card_sources cs JOIN cards c ON c.id = cs.card_id WHERE c.status='approved'");
  check("approved cards kept their source provenance", provenance.n === 2);
  await shot("rev-3-study-end");

  // Phone width for the review screen
  await page.goto(`${BASE}/review`);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByRole("heading", { name: "Review drafts" }).waitFor();
  check("review screen has no horizontal scroll at 375px", !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
} catch (err) {
  check(`script error: ${err.message.split("\n")[0]}`, false);
  await shot("rev-error").catch(() => {});
}
check("no console errors or 5xx responses", problems.length === 0, problems.join(" ; "));
await browser.close();
stub.close();
await db.end();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
