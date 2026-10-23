/**
 * Manual end-to-end smoke test for Batch 6: dashboard, settings, study-mode picker, resume, progress evidence,
 * and responsive layout, in a real browser. Same setup as study-walkthrough.mjs (no AI needed).
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
await db.query("UPDATE users SET display_name = NULL");

const results = [];
const problems = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const browser = await chromium.launch(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH, args: ["--no-sandbox"] } : { channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = (name) => page.screenshot({ path: `${SP}/${name}.png`, fullPage: true });
const api = async (method, path, body) => {
  const res = await page.request.fetch(`${BASE}/api${path}`, { method, data: body, headers: { "content-type": "application/json" } });
  return res.json();
};
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

try {
  // 1. A brand-new learner gets a clear starting path
  await page.goto(`${BASE}/`);
  await page.getByRole("heading", { name: "Start here" }).waitFor();
  check("new learner sees the Start here path", (await page.locator("ol.steps li").count()) === 4);
  check("no empty review/progress panels for a new learner", (await page.getByTestId("due-count").count()) === 0 && (await page.getByRole("heading", { name: "Progress", exact: true }).count()) === 0);
  await shot("lrn-1-new");
  await page.goto(`${BASE}/progress`);
  await page.getByText("No cards to show progress for").waitFor();
  check("progress is honest when there is nothing to show", true);

  // 2. Settings persist and are used
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Cards per session").fill("5");
  await page.getByLabel(/Ask how confident/).uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Saved.").waitFor();
  await page.reload();
  await page.getByLabel("Name").waitFor();
  await page.waitForFunction(() => document.querySelector('input[type="number"]')?.value === "5");
  check("settings are saved and survive a reload", (await page.getByLabel("Name").inputValue()) === "Ada" && !(await page.getByLabel(/Ask how confident/).isChecked()));
  check("AI allowance is shown honestly (usage or not set up)", (await page.getByTestId("ai-usage").count()) + (await page.getByText(/Not set up on this server/).count()) === 1);

  // 3. A deck of seven cards, mode picker, session size and confidence preference
  const deck = await api("POST", "/decks", { title: "Cloud basics" });
  for (let i = 1; i <= 7; i++) {
    const card = await api("POST", "/cards", { cardType: "short_answer", prompt: `Q${i}?`, answer: "right", answerSpec: { acceptedAnswers: ["right"] } });
    await api("POST", `/decks/${deck.id}/cards`, { cardId: card.id });
  }
  await page.goto(`${BASE}/decks/${deck.id}`);
  await page.getByTestId("deck-overview").filter({ hasText: "7 new" }).waitFor();
  await page.locator("details").filter({ hasText: "Study mode:" }).evaluate((d) => { d.open = true; });
  const radios = page.getByRole("radio", { name: /Recall|Connections|Explain|Apply|Hybrid/ });
  const aiOn = (await api("GET", "/me")).aiUsage.configured;
  const expectedOff = aiOn ? 0 : 4; // the written modes and Hybrid need an AI key
  check("five modes listed; Recall is checked", (await radios.count()) === 5 && (await page.getByRole("radio", { name: /^Recall/ }).isChecked()));
  check(`unavailable modes are disabled (${expectedOff}) and say why`, (await page.locator('input[name="study-mode"]:disabled').count()) === expectedOff && (aiOn || (await page.getByText(/Needs an AI key on the server/).count()) >= 4));
  await shot("lrn-2-deck-modes");
  await page.getByRole("button", { name: "Start studying" }).click();
  await page.waitForURL(/\/study\//);
  await page.getByTestId("prompt").waitFor();
  check("session holds 5 cards (the preference), not 7", /1 of 5|Card 1 of 5/i.test(await page.locator("body").innerText()) || (await page.getByText(/of 5/).count()) > 0);
  check("confidence rating is hidden when turned off", (await page.getByText(/How confident are you/).count()) === 0);

  // 4. Answer three (two right, one wrong), then leave and come back: resume
  for (const [i, ans] of [[1, "right"], [2, "right"], [3, "wrong"]]) {
    await page.getByLabel("Your answer").fill(ans);
    await page.getByRole("button", { name: "Check answer" }).click();
    await page.getByTestId("feedback").waitFor();
    await page.getByRole("button", { name: "Next card" }).click();
    void i;
  }
  await page.goto(`${BASE}/`);
  await page.getByTestId("resume-card").waitFor();
  check("Home offers to resume the unfinished session with its real count", /3 of 5 answered/.test(await page.getByTestId("resume-card").innerText()));
  check("Home greets the learner by name", await page.getByRole("heading", { name: "Welcome back, Ada" }).isVisible());
  await shot("lrn-3-home-resume");
  await page.getByRole("link", { name: "Resume session" }).click();
  await page.getByTestId("prompt").waitFor();
  for (const ans of ["right", "wrong"]) {
    await page.getByLabel("Your answer").fill(ans);
    await page.getByRole("button", { name: "Check answer" }).click();
    await page.getByTestId("feedback").waitFor();
    await page.getByRole("button", { name: /Next card|See summary/ }).click();
  }
  await page.getByRole("button", { name: "Study more" }).waitFor();

  // 5. Progress shows exactly what happened: 5 answered (3 right, 2 wrong), 7 cards
  await page.goto(`${BASE}/progress`);
  await page.getByTestId("progress-total").waitFor();
  const n = async (k) => Number((await page.getByTestId(`state-${k}`).locator(".state-tile__n").innerText()).trim());
  const states = { never: await n("never"), struggling: await n("struggling"), learning: await n("learning"), established: await n("established") };
  check("states add up: 2 not practised, 2 need work, 3 learning, 0 holding up", JSON.stringify(states) === JSON.stringify({ never: 2, struggling: 2, learning: 3, established: 0 }), JSON.stringify(states));
  const ev = await page.getByTestId("evidence").innerText();
  check("evidence text matches: 5 answers, 3 right, 2 wrong, all automatic", /5 answers on 5 cards: 3 right, 0 partly right, 2 wrong/.test(ev) && /0 of these were graded by you \(term\/definition cards\), 5 checked automatically/.test(ev), ev.replace(/\n/g, " | "));
  check("small sample is called out", /small sample/i.test(ev));
  await page.getByText("Needs attention").waitFor();
  check("cards needing attention are listed", (await page.locator("ul.list li").count()) === 2);
  check("no percentage or invented score on the page", !/\d\s*%/.test(await page.locator("main").innerText()));
  await shot("lrn-4-progress");

  // 6. Phone width
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ["/", "/progress", "/settings", "/review", "/library"]) {
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState("networkidle");
    check(`no horizontal scroll at 375px on ${path}`, await noOverflow());
  }
  await shot("lrn-5-phone-settings");
} catch (err) {
  check(`script error: ${err.message.split("\n")[0]}`, false);
  await shot("lrn-error").catch(() => {});
}
check("no console errors or 5xx responses", problems.length === 0, problems.join(" ; "));
await browser.close();
await db.end();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
