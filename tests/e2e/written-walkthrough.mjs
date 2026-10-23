/**
 * Manual end-to-end smoke test for Batch 6b: AI-judged written answers in a real browser.
 * generate written-answer drafts (LOCAL STUB AI) -> approve into a deck -> study in Explain mode:
 * a failed AI call keeps the learner's text and records nothing -> an ambiguous reply asks for clarification and records nothing
 * -> a partial verdict is recorded as AI evidence -> a correct verdict completes the session.
 * Same setup as the other walkthroughs: the API must be started with AI_API_KEY and AI_BASE_URL pointing at the stub port.
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
await db.query("TRUNCATE decks, cards, sources, generation_jobs, study_sessions, user_preferences, ai_evaluations CASCADE");
await db.query("UPDATE users SET display_name = NULL");

const written = (prompt, answer, criteria, quote) => ({ card_type: "open_ended", prompt, answer, explanation: "", criteria, quote });
const stubCards = [
  written("Explain why availability zones improve resilience.", "Zones have independent power, cooling and networking, so a fault in one does not reach the others.", ["mentions independent power, cooling and networking"], "Zones have independent power, cooling and networking."),
  written("Explain what an availability zone is.", "An isolated location within a region.", ["says it is isolated", "says it is inside a region"], "An availability zone is an isolated location within a region."),
];
let evalMode = "correct";
const reply = (verdict, over = {}) => ({ verdict, strengths: verdict === "incorrect" ? "" : "You named isolation.", gaps: verdict === "correct" ? "" : "You did not say what zones do not protect against.", stronger_answer: verdict === "correct" ? "" : "Add that zones do not cover regional outages.", misconception: "", clarifying_question: "", ...over });
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const name = parsed.response_format?.json_schema?.name;
    res.setHeader("content-type", "application/json");
    if (name === "answer_evaluation") {
      if (evalMode === "fail") { res.statusCode = 503; res.end(JSON.stringify({ error: { message: "overloaded" } })); return; }
      const content = evalMode === "ambiguous" ? reply("ambiguous", { strengths: "", gaps: "", stronger_answer: "", clarifying_question: "Which part of resilience do you mean?" }) : reply(evalMode);
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ cards: stubCards }) } }] }));
  });
});
await new Promise((r) => stub.listen(AI_PORT, "127.0.0.1", r));

const results = [];
const problems = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const browser = await chromium.launch(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH, args: ["--no-sandbox"] } : { channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on("console", (m) => m.type() === "error" && !/503|502/.test(m.text()) && problems.push(`console: ${m.text()}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500 && r.status() !== 502 && r.status() !== 503) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = (name) => page.screenshot({ path: `${SP}/${name}.png`, fullPage: true });
const one = async (sql) => (await db.query(sql)).rows[0];

try {
  await page.goto(`${BASE}/library`);
  await page.getByRole("button", { name: "New deck" }).click();
  await page.getByLabel("Deck title").fill("Written practice");
  await page.getByRole("button", { name: "Create deck" }).click();
  await page.waitForURL(/\/decks\//);

  await page.goto(`${BASE}/sources/new`);
  await page.getByLabel("Title", { exact: true }).fill("Cloud notes");
  await page.getByLabel("Text", { exact: true }).fill("An availability zone is an isolated location within a region. Zones have independent power, cooling and networking. A virtual machine is an emulation of a physical computer.");
  await page.getByLabel("Write cards from this source with AI").uncheck({ timeout: 1500 }).catch(() => {});
  await page.getByRole("button", { name: "Add source" }).click();
  await page.waitForURL(/\/sources\/[0-9a-f-]{36}$/);
  await page.getByLabel("Kind of cards").selectOption("explain");
  await page.getByRole("button", { name: "Generate cards" }).click();
  await page.getByText("2 drafts created from 2 suggestions.").waitFor();
  const drafts = (await db.query("SELECT card_type, learning_mode, status, rubric FROM cards")).rows;
  check("two written-answer drafts in Explain mode with criteria", drafts.length === 2 && drafts.every((d) => d.card_type === "open_ended" && d.learning_mode === "explain" && d.status === "draft" && d.rubric.criteria.length >= 1));

  await page.getByRole("link", { name: "review screen" }).click();
  await page.getByTestId("review-draft").nth(1).waitFor();
  check("review screen shows the criteria and mode", (await page.getByText(/Criteria: mentions independent power/).count()) === 1 && (await page.getByText(/explain mode/).count()) >= 1);
  await shot("wr-1-review");
  await page.getByLabel("Put approved cards in").selectOption({ label: "Written practice" });
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: /Approve selected \(2\)/ }).click();
  await page.getByText(/Approved 2 cards and added to “Written practice”/).waitFor();

  await page.getByRole("link", { name: "Open the deck" }).click();
  await page.getByTestId("deck-overview").filter({ hasText: "0 studyable in Recall" }).waitFor();
  check("Recall does not offer written-answer cards", await page.getByRole("button", { name: "Start studying" }).isDisabled());
  await page.locator("details").filter({ hasText: "Study mode:" }).evaluate((d) => { d.open = true; });
  await page.locator('input[name="study-mode"][value="explain"]').check();
  await page.getByTestId("deck-overview").filter({ hasText: "2 studyable in Explain" }).waitFor();
  check("Explain mode shows the 2 written cards", true);
  check("Hybrid is selectable when AI is configured", !(await page.locator('input[name="study-mode"][value="hybrid"]').isDisabled()));
  await shot("wr-2-deck");
  await page.getByRole("button", { name: "Start studying" }).click();
  await page.waitForURL(/\/study\//);
  await page.getByTestId("prompt").waitFor();
  check("study page names the mode", (await page.getByText(/Explain mode/).count()) >= 1);
  check("the model answer is not on the page before answering", (await page.getByText(/independent power, cooling and networking, so a fault/).count()) === 0 && (await page.getByText("An isolated location within a region.").count()) === 0);

  // 1) The AI is unavailable: text is kept, nothing recorded, retry offered
  evalMode = "fail";
  const answer = "Zones are isolated, so one failing does not take the others down.";
  await page.getByLabel("Your answer").fill(answer);
  await page.getByRole("button", { name: "Submit for feedback" }).click();
  await page.getByText(/not recorded/).first().waitFor();
  check("a failed AI call shows an error that says nothing was recorded", true);
  check("the learner's text is still in the box", (await page.getByLabel("Your answer").inputValue()) === answer);
  check("nothing was recorded for the failed attempt", (await one("SELECT count(*)::int n FROM study_responses")).n === 0 && (await one("SELECT count(*)::int n FROM card_review_state")).n === 0);
  check("the failed attempt is logged", (await one("SELECT count(*)::int n FROM ai_evaluations WHERE status='failed'")).n === 1);
  await shot("wr-3-failure");

  // 2) Ambiguous: asks for more, still nothing recorded
  evalMode = "ambiguous";
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByTestId("clarification").waitFor();
  check("an ambiguous answer shows the AI's question", (await page.getByTestId("clarification").innerText()).includes("Which part of resilience do you mean?"));
  check("an ambiguous answer records nothing", (await one("SELECT count(*)::int n FROM study_responses")).n === 0);
  check("the text is still editable and kept", (await page.getByLabel("Your answer").inputValue()) === answer);

  // 3) Partial
  evalMode = "partial";
  await page.getByLabel("Your answer").fill(answer + " That limits the damage of a fault.");
  await page.getByRole("button", { name: "Submit for feedback" }).click();
  await page.getByTestId("feedback").waitFor();
  const fb = await page.getByTestId("feedback").innerText();
  check("partial verdict with structured feedback", (await page.getByText("Partly correct").count()) >= 1 && /What you got right/.test(fb) && /A stronger answer/.test(fb));
  check("feedback says it was judged by AI and shows the model answer", (await page.getByText(/judged by AI/).count()) === 1 && (await page.getByTestId("correct-answer").innerText()).length > 10);
  const rec = await one("SELECT verdict, eval_method, submitted_answer FROM study_responses");
  check("recorded as partial / ai evidence with the learner's final text", rec && rec.verdict === "partial" && rec.eval_method === "ai" && rec.submitted_answer.endsWith("damage of a fault."));
  check("scheduled", /1 day/.test(await page.getByTestId("next-review").innerText()));
  await shot("wr-4-feedback");
  await page.getByRole("button", { name: "Next card" }).click();

  // 4) Correct
  evalMode = "correct";
  await page.getByLabel("Your answer").fill("An isolated location in a region.");
  await page.getByRole("button", { name: "Submit for feedback" }).click();
  await page.getByTestId("feedback").waitFor();
  check("correct verdict", (await page.getByText("Correct", { exact: true }).count()) >= 1);
  await page.getByRole("button", { name: "See summary" }).click();
  await page.getByRole("button", { name: "Study more" }).waitFor();
  const counts = await page.getByTestId("summary-counts").innerText();
  check("summary counts one correct and one partly correct", /1 correct, 1 partly correct, 0 incorrect/.test(counts), counts);
  const ev = (await db.query("SELECT status, verdict FROM ai_evaluations ORDER BY created_at")).rows.map((r) => `${r.status}:${r.verdict ?? "-"}`);
  check("evaluation ledger shows failed, ambiguous, partial, correct", JSON.stringify(ev) === JSON.stringify(["failed:-", "succeeded:ambiguous", "succeeded:partial", "succeeded:correct"]), JSON.stringify(ev));

  // Settings and progress
  await page.goto(`${BASE}/settings`);
  await page.getByTestId("ai-eval-usage").waitFor();
  check("settings shows evaluation usage including the failed attempt", /4 of \d+ AI-judged/.test(await page.getByTestId("ai-eval-usage").innerText()), await page.getByTestId("ai-eval-usage").innerText());
  await page.goto(`${BASE}/progress`);
  await page.getByText(/judged by AI/).first().waitFor();
  check("progress counts the AI-judged answers as evidence", true);

  // Hybrid: a fixed sequence, shown to the learner
  const api = async (method, path, body) => (await page.request.fetch(`${BASE}/api${path}`, { method, data: body, headers: { "content-type": "application/json" } })).json();
  const hdeck = await api("POST", "/decks", { title: "Hybrid deck" });
  const mk = async (c) => { const made = await api("POST", "/cards", c); await api("POST", `/decks/${hdeck.id}/cards`, { cardId: made.id }); };
  await mk({ cardType: "open_ended", prompt: "Apply: which design survives a zone outage?", answer: "Spread across zones.", learningMode: "apply", rubric: { criteria: ["spreads across zones"] } });
  await mk({ cardType: "short_answer", prompt: "What does VM stand for?", answer: "virtual machine" });
  await mk({ cardType: "open_ended", prompt: "Explain why zones help.", answer: "Isolation.", rubric: { criteria: ["isolation"] } });
  await page.goto(`${BASE}/decks/${hdeck.id}`);
  await page.locator("details").filter({ hasText: "Study mode:" }).evaluate((d) => { d.open = true; });
  await page.locator('input[name="study-mode"][value="hybrid"]').check();
  await page.getByTestId("deck-overview").filter({ hasText: "3 studyable in Hybrid" }).waitFor();
  await page.getByRole("button", { name: "Start studying" }).click();
  await page.waitForURL(/\/study\//);
  await page.getByTestId("hybrid-phases").waitFor();
  const seq = await page.getByTestId("hybrid-phases").innerText();
  check("hybrid shows its fixed sequence with Recall first", /Recall \(0\/1\)[\s\S]*Explain \(0\/1\)[\s\S]*Apply \(0\/1\)/.test(seq) && !/Connections/.test(seq), seq.replace(/\s+/g, " "));
  check("first card is the recall card", (await page.getByTestId("prompt").innerText()).includes("VM stand for"));
  await shot("wr-5-hybrid");
  await page.getByLabel("Your answer").fill("virtual machine");
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByTestId("feedback").waitFor();
  await page.getByRole("button", { name: "Next card" }).click();
  check("then the explain card, then apply (order never changes)", (await page.getByTestId("prompt").innerText()).startsWith("Explain"));
  evalMode = "correct";
  await page.getByLabel("Your answer").fill("Zones are isolated.");
  await page.getByRole("button", { name: "Submit for feedback" }).click();
  await page.getByTestId("feedback").waitFor();
  await page.getByRole("button", { name: "Next card" }).click();
  check("last phase is apply", (await page.getByTestId("prompt").innerText()).startsWith("Apply"));

  // Phone width
  await page.goto(`${BASE}/decks`).catch(() => undefined);
  await page.goto(`${BASE}/`);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${BASE}/library`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("no horizontal scroll at phone width", !overflow);
} catch (err) {
  check("script completed", false, String(err).split("\n")[0]);
  await shot("wr-error").catch(() => undefined);
} finally {
  check("no console errors, page errors or unexpected 5xx", problems.length === 0, problems.join(" | "));
  await browser.close();
  stub.close();
  await db.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
