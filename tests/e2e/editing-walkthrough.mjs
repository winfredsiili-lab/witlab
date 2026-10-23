/**
 * Manual end-to-end smoke test: approved cards of every type can be edited from the Library. No AI needed.
 * Start the API with AUTH_MODE=dev-stub against a *_e2e database.
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
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = (n) => page.screenshot({ path: `${SP}/${n}.png`, fullPage: true });
const api = async (method, path, body) => (await page.request.fetch(`${BASE}/api${path}`, { method, data: body, headers: { "content-type": "application/json" } })).json();

const make = (body) => api("POST", "/cards", body);
const open = async (prompt) => {
  await page.goto(`${BASE}/library`);
  const row = page.getByTestId("library-card").filter({ hasText: prompt });
  await row.locator("summary").click();
  await row.getByRole("button", { name: "Edit" }).click();
  return row.getByTestId("card-editor");
};
const get = async (id) => api("GET", `/cards/${id}`);

try {
  const mc = await make({ cardType: "multiple_choice", prompt: "Which is a region?", answer: "us-east", answerSpec: { choices: ["us-east", "zone-a"], correctIndex: 0 } });
  const num = await make({ cardType: "numeric", prompt: "How many zones minimum?", answer: "2", answerSpec: { value: 2, tolerance: 0 } });
  const sa = await make({ cardType: "short_answer", prompt: "What does VM stand for?", answer: "virtual machine" });
  const td = await make({ cardType: "term_definition", prompt: "What is a zone?", answer: "An isolated location." });
  const oe = await make({ cardType: "open_ended", learningMode: "explain", prompt: "Why use zones?", answer: "Isolation limits failures.", rubric: { criteria: ["mentions isolation"] } });

  let ed = await open("Which is a region?");
  check("approved cards show the new-version warning", (await ed.getByText(/makes a new version of this card/).count()) === 1);
  await shot("edit-1-mc");
  await ed.getByLabel("Choices").fill("us-east\nzone-a\neu-west");
  await ed.getByLabel("Correct choice").selectOption({ label: "eu-west" });
  await ed.getByRole("button", { name: "Save changes" }).click();
  await ed.waitFor({ state: "detached" });
  let c = await get(mc.id);
  check("multiple choice: choices and correct answer change together", c.answer === "eu-west" && c.answerSpec.correctIndex === 2 && c.answerSpec.choices.length === 3, JSON.stringify(c.answerSpec));
  check("and the card becomes version 2 but stays approved", c.revision === 2 && c.status === "approved");

  ed = await open("Which is a region?");
  await ed.getByLabel("Choices").fill("only one");
  await ed.getByRole("button", { name: "Save changes" }).click();
  check("fewer than two choices is refused with a message and nothing is saved", /at least two choices/.test(await ed.getByRole("alert").innerText()) && (await get(mc.id)).revision === 2);
  await ed.getByRole("button", { name: "Cancel" }).click();
  await ed.waitFor({ state: "detached" });

  ed = await open("How many zones minimum?");
  await ed.getByLabel("Correct value").fill("3");
  await ed.getByLabel("Tolerance").fill("0.5");
  await ed.getByRole("button", { name: "Save changes" }).click();
  await ed.waitFor({ state: "detached" });
  c = await get(num.id);
  check("number: value and tolerance change", c.answerSpec.value === 3 && c.answerSpec.tolerance === 0.5 && c.answer === "3" && c.revision === 2);

  ed = await open("What does VM stand for?");
  await ed.getByLabel("Other accepted answers (optional)").fill("a vm\nvirtual computer");
  await ed.getByRole("button", { name: "Save changes" }).click();
  await ed.waitFor({ state: "detached" });
  c = await get(sa.id);
  check("short answer: extra accepted answers are saved", JSON.stringify(c.answerSpec.acceptedAnswers).includes("virtual computer") && c.revision === 2, JSON.stringify(c.answerSpec));
  ed = await open("What does VM stand for?");
  check("and shown again when reopened (without duplicating the main answer)", (await ed.getByLabel("Other accepted answers (optional)").inputValue()) === "a vm\nvirtual computer");
  await ed.getByRole("button", { name: "Cancel" }).click();

  ed = await open("Why use zones?");
  await ed.getByLabel("Study mode").selectOption("apply");
  await ed.getByLabel("Criteria").fill("mentions isolation\nmentions blast radius");
  await ed.getByRole("button", { name: "Save changes" }).click();
  await ed.waitFor({ state: "detached" });
  c = await get(oe.id);
  check("written answer: study mode and criteria change", c.learningMode === "apply" && c.rubric.criteria.length === 2 && c.revision === 2);

  ed = await open("What is a zone?");
  await ed.getByLabel("Explanation (optional)").fill("Zones fail independently.");
  await ed.getByRole("button", { name: "Save changes" }).click();
  await ed.waitFor({ state: "detached" });
  c = await get(td.id);
  check("an explanation-only edit does not create a new version", c.explanation === "Zones fail independently." && c.revision === 1);

  ed = await open("What is a zone?");
  await ed.getByLabel("Question").fill("Changed but cancelled");
  await ed.getByRole("button", { name: "Cancel" }).click();
  check("cancel discards the changes", (await get(td.id)).prompt === "What is a zone?");

  await page.goto(`${BASE}/library`);
  await page.getByTestId("library-card").filter({ hasText: "Which is a region?" }).locator("summary").click();
  const row = page.getByTestId("library-card").filter({ hasText: "Which is a region?" });
  check("the Library shows the edited card", (await row.getByText("✔ eu-west").count()) === 1);
  await shot("edit-2-library");
} catch (err) {
  check("script completed without throwing", false, String(err).split("\n")[0]);
  await shot("edit-error").catch(() => {});
}

check("no page errors or server errors", problems.length === 0, problems.join(" | "));
await browser.close();
await db.end();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
