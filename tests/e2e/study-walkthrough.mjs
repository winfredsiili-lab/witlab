/**
 * Manual end-to-end smoke test: drives the real web app, API and PostgreSQL in a real browser.
 * Not part of `npm test`. Full automated e2e coverage is planned for Batch 7.
 *
 * Needs (see README, "End-to-end walk-through"):
 *   - the API and the web app running, with the API pointed at a database whose name ends in "_e2e"
 *   - E2E_DATABASE_URL: that same database. The script EMPTIES its decks, cards and sources first.
 *   - Chrome or Edge installed, or E2E_CHROME_PATH pointing at a Chromium executable
 * Optional: E2E_BASE_URL (default http://localhost:5173), E2E_SCREENSHOT_DIR (default tests/e2e/screenshots).
 */
import { chromium } from "playwright-core";
import pg from "pg";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const SP = process.env.E2E_SCREENSHOT_DIR ?? fileURLToPath(new URL("./screenshots", import.meta.url));
mkdirSync(SP, { recursive: true });

const dbUrl = process.env.E2E_DATABASE_URL;
if (!dbUrl) {
  console.error("Set E2E_DATABASE_URL to the database the API is using (its name must end in _e2e).");
  process.exit(2);
}
const dbName = new URL(dbUrl).pathname.replace(/^\//, "");
if (!dbName.endsWith("_e2e")) {
  console.error(`Refusing to run: database "${dbName}" does not end in _e2e. This script deletes data.`);
  process.exit(2);
}
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await db.query("TRUNCATE decks, cards, sources, generation_jobs, study_sessions, user_preferences CASCADE");
await db.query("UPDATE users SET display_name = NULL");

const results = [];
const problems = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const browser = await chromium.launch(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH, args: ["--no-sandbox"] } : { channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) console.log("   [http]", r.status(), r.request().method(), r.url()); if (r.url().includes("/api/") && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = (name) => page.screenshot({ path: `${SP}/${name}.png`, fullPage: true });

// 1. Empty library
await page.goto(`${BASE}/library`);
await page.getByText("No decks yet").waitFor();
check("empty library shows an empty state", true);

// 2. Create a deck
await page.getByRole("button", { name: "New deck" }).click();
await page.getByLabel("Deck title").fill("Cloud basics");
await page.getByRole("button", { name: "Create deck" }).click();
await page.waitForURL(/\/decks\//);
await page.getByRole("heading", { name: "Cloud basics" }).waitFor();
check("deck created and opened", true);
check("start button disabled while the deck is empty", await page.getByRole("button", { name: "Start studying" }).isDisabled());

// 3. Create four cards from the deck page
async function newCard(fill) {
  await page.getByRole("button", { name: "Create a new card for this deck" }).click();
  await fill();
  await page.getByRole("button", { name: "Create and add to deck" }).click();
  await page.getByRole("button", { name: "Create a new card for this deck" }).waitFor();
}
await newCard(async () => {
  await page.getByLabel("Card type").selectOption("term_definition");
  await page.getByLabel("Question").fill("Define availability zone");
  await page.getByLabel("Answer", { exact: true }).fill("An isolated location within a region.");
});
await newCard(async () => {
  await page.getByLabel("Card type").selectOption("short_answer");
  await page.getByLabel("Question").fill("What does VM stand for?");
  await page.getByLabel("Correct answer").fill("VM");
  await page.getByLabel("Other accepted answers (optional)").fill("virtual machine");
});
await newCard(async () => {
  await page.getByLabel("Card type").selectOption("multiple_choice");
  await page.getByLabel("Question").fill("Which service stores objects?");
  await page.getByLabel("Choices").fill("Blob storage\nVirtual network\nLoad balancer");
  await page.getByLabel("Correct choice").selectOption({ label: "Blob storage" });
  await page.getByLabel("Explanation (optional)").fill("Blob storage holds unstructured objects.");
});
await newCard(async () => {
  await page.getByLabel("Card type").selectOption("numeric");
  await page.getByLabel("Question").fill("How many days are in a leap year?");
  await page.getByLabel("Correct value").fill("366");
  await page.getByLabel("Tolerance").fill("0");
});
await page.getByText("Define availability zone").first().waitFor();
await page.getByTestId("deck-overview").filter({ hasText: "4 new" }).waitFor();
const overviewText = await page.getByTestId("deck-overview").innerText();
check("deck overview shows 4 new studyable cards", /0 due\s+·\s+4 new\s+·\s+4 studyable/.test(overviewText), overviewText);
await shot("1-deck");

// 4. Study
await page.getByRole("button", { name: "Start studying" }).click();
await page.waitForURL(/\/study\//);
await page.getByTestId("prompt").waitFor();
check("first card is the term/definition card", (await page.getByTestId("prompt").innerText()) === "Define availability zone");
check("new card explains why it is here", await page.getByText("New card: you have not practised it yet.").isVisible());

// 4a. term_definition: the model answer is hidden until revealed, then self-grade
check("model answer is hidden before reveal", (await page.getByTestId("model-answer").count()) === 0);
await page.getByLabel("Your answer (optional: it is just for you)").fill("a separate datacentre");
await page.getByLabel("5").check();
await shot("2-study-term");
await page.getByRole("button", { name: "Show answer" }).click();
await page.getByTestId("model-answer").waitFor();
await page.getByRole("button", { name: "Partly right" }).click();
await page.getByTestId("feedback").waitFor();
check("self-grade 'partly right' is recorded as partly correct", (await page.getByText("Partly correct").first().isVisible()));
check("feedback shows next review", /Scheduled again in 1 day/.test(await page.getByTestId("next-review").innerText()));
await shot("3-feedback-partial");
await page.getByRole("button", { name: "Next card" }).click();

// 4b. short_answer with a variant spelling
await page.getByLabel("Your answer").fill("  Virtual Machine. ");
await page.getByRole("button", { name: "Check answer" }).click();
await page.getByTestId("feedback").waitFor();
check("short answer variant accepted", (await page.getByTestId("feedback").innerText()) === "Correct.");
await page.getByRole("button", { name: "Next card" }).click();

// 4c. multiple choice: wrong answer shows the right one
await page.getByLabel("Virtual network").check();
await page.getByRole("button", { name: "Check answer" }).click();
await page.getByTestId("feedback").waitFor();
check("wrong choice marked incorrect", await page.getByText("Incorrect", { exact: true }).isVisible());
check("correct answer is revealed after a wrong choice", (await page.getByTestId("correct-answer").innerText()) === "Blob storage");
check("explanation is shown", await page.getByText("Blob storage holds unstructured objects.").isVisible());
check("incorrect answer is rescheduled in about 10 minutes", /10 minutes/.test(await page.getByTestId("next-review").innerText()));
await shot("4-feedback-incorrect");
await page.getByRole("button", { name: "Next card" }).click();

// 4d. numeric: unreadable text is rejected inline and does not advance
await page.getByLabel("Your answer (a number)").fill("three hundred");
await page.getByRole("button", { name: "Check answer" }).click();
await page.getByRole("alert").waitFor();
check("unreadable number shows an inline error", /Enter a number/.test(await page.getByRole("alert").innerText()));
check("the card stays on screen after the error", (await page.getByTestId("prompt").innerText()) === "How many days are in a leap year?");
await page.getByLabel("Your answer (a number)").fill("366");
await page.getByRole("button", { name: "Check answer" }).click();
await page.getByTestId("feedback").waitFor();
check("numeric answer accepted", /Correct/.test(await page.getByTestId("feedback").innerText()));
await page.getByRole("button", { name: "See summary" }).click();

// 5. Summary
await page.getByTestId("summary-counts").waitFor();
const summary = await page.getByTestId("summary-counts").innerText();
check("summary counts are right", /4 of 4 answered: 2 correct, 1 partly correct, 1 incorrect/.test(summary), summary);
await shot("5-summary");

// 6. Reload keeps the finished session
await page.reload();
await page.getByTestId("summary-counts").waitFor();
check("a finished session survives a reload", true);

// 7. Home: nothing due yet; then make cards due and review
await page.goto(`${BASE}/`);
await page.getByText(/Nothing is due right now/).waitFor();
check("home says nothing is due right after studying (the wrong card is only due in 10 minutes)", true);
await db.query("UPDATE card_review_state SET due_at = now() - interval '1 hour'");
await page.reload();
const due = await page.getByTestId("due-count").innerText();
check("home shows 4 cards due once their time has come", /^4 cards due/.test(due), due);
await shot("6-home-due");
await page.getByRole("button", { name: "Start review" }).click();
await page.waitForURL(/\/study\//);
await page.getByTestId("prompt").waitFor();
const reason = await page.getByText(/ago;/).first().innerText();
check("review explains why the card is back", /(Answered incorrectly|Partly correct|Last answered correctly) .* ago; /.test(reason), reason);
await shot("7-review");

// 8. End early, then resume from the deck page
await page.getByRole("button", { name: "End session" }).click();
await page.getByText("Session ended").waitFor();
check("ending early shows a summary", /0 of 4 answered/.test(await page.getByTestId("summary-counts").innerText()));

// 9. Mobile layout
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${BASE}/library`);
await page.getByRole("heading", { name: "Library" }).waitFor();
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
check("no horizontal scrolling at phone width", !overflow);
await shot("8-mobile-library");

// Real failures in the browser
// The only expected browser error is the single deliberate 400 (the unreadable number "three hundred").
const expected400 = problems.filter((p) => p.includes("400 (Bad Request)"));
const unexpected = problems.filter((p) => !p.includes("400 (Bad Request)"));
check("exactly one expected 400, and no other console errors, page errors or 5xx", expected400.length === 1 && unexpected.length === 0, problems.join(" | "));

await browser.close();
await db.end();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
