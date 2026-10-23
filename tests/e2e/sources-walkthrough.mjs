/**
 * Manual end-to-end smoke test for Batch 4: paste text, upload PDFs, choose a scope, generate DRAFT cards,
 * approve/reject them, and see honest failures. Uses a LOCAL STUB of the AI provider (started by this script),
 * so it proves the app's wiring, not the real provider.
 *
 * Needs everything study-walkthrough.mjs needs, plus the API started with:
 *   AI_API_KEY=e2e-key  AI_BASE_URL=http://127.0.0.1:4999/v1   (E2E_AI_PORT changes the port)
 */
import { chromium } from "playwright-core";
import pg from "pg";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const AI_PORT = Number(process.env.E2E_AI_PORT ?? 4999);
const SP = process.env.E2E_SCREENSHOT_DIR ?? fileURLToPath(new URL("./screenshots", import.meta.url));
const FIX = fileURLToPath(new URL("../../apps/api/test-fixtures/", import.meta.url));
mkdirSync(SP, { recursive: true });

const dbUrl = process.env.E2E_DATABASE_URL;
if (!dbUrl) { console.error("Set E2E_DATABASE_URL (database name must end in _e2e)."); process.exit(2); }
if (!new URL(dbUrl).pathname.replace(/^\//, "").endsWith("_e2e")) { console.error("Refusing: database name must end in _e2e."); process.exit(2); }
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await db.query("TRUNCATE decks, cards, sources, generation_jobs, study_sessions, user_preferences CASCADE");
await db.query("UPDATE users SET display_name = NULL");

// ---- local stub of the AI provider ----------------------------------------------------------------------
const card = (prompt, answer, quote) => ({
  card_type: "term_definition", prompt, answer, explanation: "From the passage.", choices: [], correct_choice_index: -1,
  accepted_answers: [], numeric_answer: "", numeric_tolerance: "", quote,
});
const table = [
  ["TRIGGER_429", null],
  ["Peering connects", [card("What does peering do?", "Connects two virtual networks privately.", "Peering connects two virtual networks privately.")]],
  ["availability zone", [
    card("What is an availability zone?", "An isolated location within a region.", "An availability zone is an isolated location within a region."),
    card("What do zones have independently?", "Power, cooling and networking.", "Zones have independent power, cooling and networking."),
    card("Made-up question?", "Nope", "This sentence is not in the source at all."),
  ]],
];
let aiRequests = 0;
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    aiRequests++;
    const user = JSON.parse(raw).messages[1].content;
    const hit = table.find(([marker]) => user.includes(marker));
    res.setHeader("content-type", "application/json");
    if (hit && hit[1] === null) { res.writeHead(429, { "retry-after": "9" }); return res.end(JSON.stringify({ error: { message: "rate limit" } })); }
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ cards: hit ? hit[1] : [] }) } }] }));
  });
});
await new Promise((r) => stub.listen(AI_PORT, "127.0.0.1", r));

const results = [];
const problems = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };

const browser = await chromium.launch(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH, args: ["--no-sandbox"] } : { channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
let expectedErrorResponses = 0;
page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 429") && problems.push(`console: ${m.text()}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
const shot = (name) => page.screenshot({ path: `${SP}/${name}.png`, fullPage: true });

async function addText(title, text) {
  await page.goto(`${BASE}/sources/new`);
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Text", { exact: true }).fill(text);
  await page.getByLabel("Write cards from this source with AI").uncheck({ timeout: 1500 }).catch(() => {});
  await page.getByRole("button", { name: "Add source" }).click();
  await page.waitForURL(/\/sources\/[0-9a-f-]{36}$/);
  await page.getByRole("heading", { name: title }).waitFor();
}

try {
  // 1. Pasted text with headings -> sections -> generate -> review
  await page.goto(`${BASE}/library`);
  await page.getByText("No sources yet").waitFor();
  check("library starts with no sources", true);
  await addText("Cloud notes", "# Zones\nAn availability zone is an isolated location within a region. Zones have independent power, cooling and networking.\n# Machines\nA virtual machine is an emulation of a physical computer.\n");
  check("text source is ready", await page.getByText("ready", { exact: true }).first().isVisible());
  await page.getByLabel("What to read").selectOption("section");
  const options = await page.getByLabel("Section").locator("option").allTextContents();
  check("headings offered as sections", options.some((o) => o.includes("Zones")) && options.some((o) => o.includes("Machines")), options.join(" | "));
  await page.getByLabel("What to read").selectOption("all");
  await page.getByRole("button", { name: "Generate cards" }).click();
  await page.getByText("2 drafts created from 3 suggestions.").waitFor();
  check("two drafts created; the ungrounded suggestion was dropped", true);
  await page.getByText("1 suggestion dropped").click();
  check("the dropped suggestion and its reason are visible", await page.getByText(/does not appear in the selected source text/).isVisible());
  const drafts = page.getByTestId("draft");
  await drafts.nth(1).waitFor();
  check("two drafts are listed with their source quote", (await drafts.count()) === 2 && (await drafts.getByText(/“An availability zone is an isolated location within a region\.”/).count()) === 1 && (await drafts.getByText(/“Zones have independent power/).count()) === 1);
  await shot("src-1-drafts");

  // Drafts do nothing until approved: not in the card list as approved, not addable to a deck
  const approvedBefore = (await db.query("SELECT count(*)::int n FROM cards WHERE status='approved'")).rows[0].n;
  check("nothing is approved yet", approvedBefore === 0);
  await drafts.first().getByRole("button", { name: "Approve" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="draft"]').length === 1);
  await drafts.first().getByRole("button", { name: "Reject" }).click();
  await page.getByText("No drafts").waitFor();
  const st = (await db.query("SELECT status, count(*)::int n FROM cards GROUP BY status ORDER BY status")).rows;
  check("one approved, one rejected", JSON.stringify(st) === JSON.stringify([{ status: "approved", n: 1 }, { status: "rejected", n: 1 }]), JSON.stringify(st));

  // 2. PDF with bookmarks
  await page.goto(`${BASE}/sources/new`);
  await page.getByLabel("Upload a PDF").check();
  await page.getByLabel("PDF file").setInputFiles(`${FIX}outline.pdf`);
  await page.getByLabel("Write cards from this source with AI").uncheck({ timeout: 1500 }).catch(() => {});
  await page.getByRole("button", { name: "Add source" }).click();
  await page.waitForURL(/\/sources\/[0-9a-f-]{36}$/);
  await page.getByRole("heading", { name: "outline" }).waitFor();
  check("PDF imported: 6 pages shown", await page.getByText(/PDF, 6 pages/).first().isVisible());
  await page.getByLabel("What to read").selectOption("section");
  const secs = await page.getByLabel("Section").locator("option").allTextContents();
  check("PDF bookmarks offered as sections with page ranges", secs.some((o) => o.includes("Chapter 3") && o.includes("p. 4–6")), secs.join(" | "));
  await page.getByLabel("Section").selectOption({ label: secs.find((o) => o.includes("Chapter 3")) });
  await page.getByRole("button", { name: "Generate cards" }).click();
  await page.getByText("1 draft created from 1 suggestion.").waitFor();
  await page.getByTestId("draft").getByText(/\(page 5\)/).waitFor();
  check("PDF draft shows its page", true);
  await shot("src-2-pdf");

  // 3. Scanned PDF: honest failure
  await page.goto(`${BASE}/sources/new`);
  await page.getByLabel("Upload a PDF").check();
  await page.getByLabel("PDF file").setInputFiles(`${FIX}scanned.pdf`);
  await page.getByLabel("Write cards from this source with AI").uncheck({ timeout: 1500 }).catch(() => {});
  await page.getByRole("button", { name: "Add source" }).click();
  await page.waitForURL(/\/sources\/[0-9a-f-]{36}$/);
  await page.getByText(/scanned or image-only PDF/).waitFor();
  check("scanned PDF is kept as failed with a clear reason and cannot generate", (await page.getByRole("button", { name: "Generate cards" }).count()) === 0);
  await shot("src-3-failed");

  // 4. AI error: nothing created, honest message
  await addText("Rate limited", "TRIGGER_429 " + "This passage is long enough to be read by the generator. ".repeat(3));
  const draftsBefore = (await db.query("SELECT count(*)::int n FROM cards")).rows[0].n;
  await page.getByRole("button", { name: "Generate cards" }).click();
  await page.getByText(/rate limit reached/).first().waitFor();
  check("provider rate limit is reported to the learner", true);
  const draftsAfter = (await db.query("SELECT count(*)::int n FROM cards")).rows[0].n;
  check("a failed generation creates no cards", draftsBefore === draftsAfter);
  const failedJobs = (await db.query("SELECT count(*)::int n FROM generation_jobs WHERE status='failed' AND error_code='ai_rate_limited'")).rows[0].n;
  check("the failed attempt is recorded", failedJobs === 1);

  // 5. Library lists sources; phone width
  await page.goto(`${BASE}/library`);
  await page.getByRole("link", { name: "Cloud notes" }).waitFor();
  check("library lists all four sources", (await page.locator("a[href^='/sources/']").count()) >= 4);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByRole("link", { name: "Cloud notes" }).click();
  await page.getByRole("heading", { name: "Cloud notes" }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check("source page has no horizontal scroll at 375px", !overflow);
  await shot("src-4-phone");

  // 6. Delete keeps cards
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete source" }).click();
  await page.waitForURL(/\/library$/);
  const kept = (await db.query("SELECT count(*)::int n FROM cards WHERE status='approved'")).rows[0].n;
  check("deleting a source keeps its approved card", kept === 1);
  check("AI provider was called exactly 3 times (2 ok, 1 rate-limited)", aiRequests === 3, String(aiRequests));
} catch (err) {
  check(`script error: ${err.message.split("\n")[0]}`, false);
  await shot("src-error").catch(() => {});
}

check("no unexpected console errors or 5xx responses", problems.length === 0, problems.join(" ; "));
await browser.close();
stub.close();
await db.end();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
