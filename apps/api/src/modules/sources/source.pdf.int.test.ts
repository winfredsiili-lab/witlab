import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceDetailSchema, sourceSectionsSchema } from "@witlab/contracts";
import { asUser, createTestApp, createTestUser, openTestPool } from "../../testing/testDb.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name));

let pool: pg.Pool;
let app: Express;
let userA: string;
let userB: string;

beforeAll(async () => {
  pool = await openTestPool();
  app = createTestApp(pool);
  userA = await createTestUser(pool, "a");
  userB = await createTestUser(pool, "b");
});
afterAll(async () => {
  await pool.end();
});

function upload(user: string, file: Buffer, query = "") {
  return request(app)
    .post(`/api/sources/pdf${query}`)
    .set("x-test-user-id", user)
    .set("Content-Type", "application/pdf")
    .send(file);
}

describe("PDF import", () => {
  it("imports a PDF: ready status, pages, text length, and bookmark sections", async () => {
    const res = await upload(userA, fixture("outline.pdf"), "?filename=handbook.pdf");
    expect(res.status).toBe(201);
    const source = sourceDetailSchema.parse(res.body.source);
    expect(source).toMatchObject({
      sourceType: "pdf", status: "ready", errorMessage: null,
      originalFilename: "handbook.pdf", title: "handbook", pageCount: 6, contentText: null,
    });
    expect(source.fileSize).toBe(fixture("outline.pdf").length);
    expect(source.contentLength).toBeGreaterThan(300);
    expect(res.body.warnings).toEqual([]);

    const sections = sourceSectionsSchema.parse((await asUser(app, userA).get(`/api/sources/${source.id}/sections`)).body).items;
    expect(sections.map((s) => [s.title, s.pageStart, s.pageEnd, s.kind])).toEqual([
      ["Chapter 1: Regions and Availability Zones", 1, 1, "bookmark"],
      ["Chapter 2: Virtual Machines", 2, 3, "bookmark"],
      ["2.1 Storage for Virtual Machines", 3, 3, "bookmark"],
      ["Chapter 3: Networking", 4, 6, "bookmark"],
    ]);
    expect(sections[3]!.textLength).toBeGreaterThan(100);

    const pages = (await asUser(app, userA).get(`/api/sources/${source.id}/pages`)).body.items;
    expect(pages).toHaveLength(6);
    const p5 = await asUser(app, userA).get(`/api/sources/${source.id}/pages/5`);
    expect(p5.body.content).toContain("Peering connects two virtual networks");
    expect((await asUser(app, userA).get(`/api/sources/${source.id}/pages/7`)).status).toBe(404);
    expect((await asUser(app, userA).get(`/api/sources/${source.id}/pages/0`)).status).toBe(400);

    const listed = (await asUser(app, userA).get("/api/sources")).body.items.find((s: { id: string }) => s.id === source.id);
    expect(listed.contentLength).toBe(source.contentLength);
  });

  it("uses an explicit title over the file name", async () => {
    const res = await upload(userA, fixture("plain.pdf"), "?filename=x.pdf&title=My%20notes");
    expect(res.body.source.title).toBe("My notes");
    const sections = (await asUser(app, userA).get(`/api/sources/${res.body.source.id}/sections`)).body.items;
    expect(sections).toEqual([]);
  });

  it.each([
    ["scanned.pdf", /OCR/],
    ["truncated.pdf", /could not be read/],
    ["encrypted.pdf", /password/],
    ["not-a-pdf.pdf", /not a PDF/],
  ])("keeps %s as a failed source with the reason, and no pages", async (name, message) => {
    const res = await upload(userA, fixture(name), `?filename=${name}`);
    expect(res.status).toBe(201);
    const source = sourceDetailSchema.parse(res.body.source);
    expect(source.status).toBe("failed");
    expect(source.errorMessage).toMatch(message);
    expect(source.contentLength).toBeNull();
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM source_pages WHERE source_id = $1", [source.id]);
    expect(rows[0].n).toBe(0);
  });

  it("imports a PDF with an image-only page and warns about the skipped page", async () => {
    const res = await upload(userA, fixture("mixed.pdf"));
    expect(res.body.source.status).toBe("ready");
    expect(res.body.source.pageCount).toBe(3);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatch(/page 2/);
    const pages = (await asUser(app, userA).get(`/api/sources/${res.body.source.id}/pages`)).body.items;
    expect(pages.map((p: { charLength: number }) => p.charLength > 0)).toEqual([true, false, true]);
  });

  it("rejects an empty body, a wrong content type and an oversized upload without creating anything", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM sources WHERE user_id = $1", [userA])).rows[0].n;
    expect((await upload(userA, Buffer.alloc(0))).status).toBe(400);
    const wrongType = await request(app).post("/api/sources/pdf").set("x-test-user-id", userA).set("Content-Type", "text/plain").send("hello");
    expect(wrongType.status).toBe(415);
    expect(wrongType.body.error.code).toBe("unsupported_media_type");
    const big = await upload(userA, Buffer.alloc(16 * 1024 * 1024, 1));
    expect(big.status).toBe(413);
    const after = (await pool.query("SELECT count(*)::int AS n FROM sources WHERE user_id = $1", [userA])).rows[0].n;
    expect(after).toBe(before);
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/api/sources/pdf").set("Content-Type", "application/pdf").send(fixture("plain.pdf"));
    expect(res.status).toBe(401);
  });

  it("hides sections, pages and page text from other users", async () => {
    const src = (await upload(userA, fixture("outline.pdf"))).body.source;
    for (const path of ["sections", "pages", "pages/1"]) {
      expect((await asUser(app, userB).get(`/api/sources/${src.id}/${path}`)).status).toBe(404);
    }
  });

  it("deletes pages and sections with the source", async () => {
    const src = (await upload(userA, fixture("outline.pdf"))).body.source;
    expect((await asUser(app, userA).delete(`/api/sources/${src.id}`)).status).toBe(204);
    const pages = await pool.query("SELECT count(*)::int AS n FROM source_pages WHERE source_id = $1", [src.id]);
    const secs = await pool.query("SELECT count(*)::int AS n FROM source_sections WHERE source_id = $1", [src.id]);
    expect([pages.rows[0].n, secs.rows[0].n]).toEqual([0, 0]);
  });
});

describe("text source sections", () => {
  it("detects markdown headings and exposes char ranges", async () => {
    const text = "# Intro\nHello world.\n# Zones\nIsolated locations.\n";
    const res = await asUser(app, userA).post("/api/sources").send({ title: "md", sourceType: "text", contentText: text });
    const sections = (await asUser(app, userA).get(`/api/sources/${res.body.id}/sections`)).body.items;
    expect(sections.map((s: { title: string; kind: string }) => [s.title, s.kind])).toEqual([["Intro", "heading"], ["Zones", "heading"]]);
    expect(text.slice(sections[1].charStart, sections[1].charEnd)).toBe("# Zones\nIsolated locations.\n");
    expect(sections[1].textLength).toBe(sections[1].charEnd - sections[1].charStart);
  });

  it("offers no sections for short unstructured text", async () => {
    const res = await asUser(app, userA).post("/api/sources").send({ title: "t", sourceType: "text", contentText: "short" });
    expect((await asUser(app, userA).get(`/api/sources/${res.body.id}/sections`)).body.items).toEqual([]);
  });
});
