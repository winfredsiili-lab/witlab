import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPdf, PdfExtractionError } from "./extractPdf.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../test-fixtures");
const load = (name: string) => new Uint8Array(readFileSync(join(dir, name)));

async function failureOf(name: string) {
  try {
    await extractPdf(load(name));
  } catch (e) {
    return e;
  }
  return null;
}

describe("extractPdf", () => {
  it("extracts text per page, with the right page numbers", async () => {
    const result = await extractPdf(load("outline.pdf"));
    expect(result.pageCount).toBe(6);
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.pages[0]!.text).toContain("A region is a geographic area");
    expect(result.pages[1]!.text).toContain("virtual machine (VM)");
    expect(result.pages[4]!.text).toContain("Peering connects two virtual networks");
    expect(result.pages[0]!.text).not.toContain("virtual machine");
  });

  it("reads sections and page ranges from the PDF's own bookmarks", async () => {
    const { sections } = await extractPdf(load("outline.pdf"));
    expect(sections).toEqual([
      { title: "Chapter 1: Regions and Availability Zones", level: 1, pageStart: 1, pageEnd: 1 },
      { title: "Chapter 2: Virtual Machines", level: 1, pageStart: 2, pageEnd: 3 },
      { title: "2.1 Storage for Virtual Machines", level: 2, pageStart: 3, pageEnd: 3 },
      { title: "Chapter 3: Networking", level: 1, pageStart: 4, pageEnd: 6 },
    ]);
  });

  it("returns no sections (and invents none) when the PDF has no bookmarks", async () => {
    const result = await extractPdf(load("plain.pdf"));
    expect(result.pageCount).toBe(3);
    expect(result.sections).toEqual([]);
    expect(result.pages[2]!.text).toContain("Containers share the host operating system kernel (page 3)");
  });

  it("rejects a scanned / image-only PDF with an honest no_text error", async () => {
    const err = await failureOf("scanned.pdf");
    expect(err).toBeInstanceOf(PdfExtractionError);
    expect((err as PdfExtractionError).code).toBe("no_text");
    expect((err as PdfExtractionError).message).toMatch(/OCR/);
  });

  it("rejects a file that is not a PDF", async () => {
    expect(((await failureOf("not-a-pdf.pdf")) as PdfExtractionError).code).toBe("not_a_pdf");
  });

  it("rejects a truncated PDF as corrupt", async () => {
    expect(((await failureOf("truncated.pdf")) as PdfExtractionError).code).toBe("corrupt");
  });

  it("rejects a password-protected PDF as encrypted", async () => {
    expect(((await failureOf("encrypted.pdf")) as PdfExtractionError).code).toBe("encrypted");
  });

  it("rejects an oversized upload before parsing", async () => {
    const big = new Uint8Array(16 * 1024 * 1024);
    expect(((await extractPdf(big).catch((e) => e)) as PdfExtractionError).code).toBe("too_large");
  });

  it("does not modify the caller's bytes", async () => {
    const bytes = load("plain.pdf");
    const before = Buffer.from(bytes).toString("base64");
    await extractPdf(bytes);
    expect(Buffer.from(bytes).toString("base64")).toBe(before);
  });
});
