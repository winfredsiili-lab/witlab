import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Real PDF text extraction (no OCR). Pure function of the file bytes: no database, no network.
 * Failures are reported with a specific code and a message that is safe to show the learner.
 */

export const PDF_MAX_BYTES = 15 * 1024 * 1024;
export const PDF_MAX_PAGES = 300;
const MAX_SECTIONS = 500;
const MIN_TOTAL_TEXT_CHARS = 20;

export type PdfFailureCode =
  | "not_a_pdf"
  | "encrypted"
  | "corrupt"
  | "no_text"
  | "too_large"
  | "too_many_pages";

export class PdfExtractionError extends Error {
  constructor(
    public readonly code: PdfFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "PdfExtractionError";
  }
}

export interface ExtractedPage {
  pageNumber: number; // 1-based
  text: string;
}

export interface ExtractedSection {
  title: string;
  level: number; // 1 = top level
  pageStart: number;
  pageEnd: number;
}

export interface PdfExtraction {
  pageCount: number;
  pages: ExtractedPage[];
  /** Taken from the PDF's own bookmarks. Empty when the file has none (never guessed). */
  sections: ExtractedSection[];
  /** Things the learner should know, for example pages with no readable text. */
  warnings: string[];
}

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineNode[];
}

function cleanPageText(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}

export async function extractPdf(bytes: Uint8Array): Promise<PdfExtraction> {
  if (bytes.byteLength > PDF_MAX_BYTES) {
    throw new PdfExtractionError(
      "too_large",
      `This PDF is larger than ${PDF_MAX_BYTES / (1024 * 1024)} MB. Split it or export the pages you need.`,
    );
  }
  const header = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!header.includes("%PDF-")) {
    throw new PdfExtractionError("not_a_pdf", "This file is not a PDF.");
  }

  // pdfjs may transfer/detach the buffer it is given, so hand it a copy.
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });

  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "PasswordException") {
      throw new PdfExtractionError(
        "encrypted",
        "This PDF is password protected. Remove the password and upload it again.",
      );
    }
    throw new PdfExtractionError(
      "corrupt",
      "This PDF could not be read. It may be damaged or incomplete.",
    );
  }

  try {
    const pageCount = doc.numPages;
    if (pageCount > PDF_MAX_PAGES) {
      throw new PdfExtractionError(
        "too_many_pages",
        `This PDF has ${pageCount} pages; the limit is ${PDF_MAX_PAGES}. Split it and upload the part you need.`,
      );
    }

    const pages: ExtractedPage[] = [];
    const warnings: string[] = [];
    try {
      for (let n = 1; n <= pageCount; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        let raw = "";
        for (const item of content.items) {
          if ("str" in item) {
            raw += item.str;
            raw += item.hasEOL ? "\n" : "";
          }
        }
        pages.push({ pageNumber: n, text: cleanPageText(raw) });
        page.cleanup();
      }
    } catch {
      throw new PdfExtractionError(
        "corrupt",
        "This PDF could not be read completely. It may be damaged or incomplete.",
      );
    }

    const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
    if (totalChars < MIN_TOTAL_TEXT_CHARS) {
      throw new PdfExtractionError(
        "no_text",
        "No readable text was found. This looks like a scanned or image-only PDF, and text recognition (OCR) is not supported yet. Upload a PDF with selectable text, or paste the text instead.",
      );
    }
    const emptyPages = pages.filter((p) => p.text === "").map((p) => p.pageNumber);
    if (emptyPages.length > 0) {
      warnings.push(
        `No readable text on page${emptyPages.length > 1 ? "s" : ""} ${summariseNumbers(emptyPages)} (images only, or blank). ${emptyPages.length > 1 ? "They are" : "It is"} skipped.`,
      );
    }

    const sections = await readSections(doc, pageCount, warnings);
    return { pageCount, pages, sections, warnings };
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

function summariseNumbers(nums: number[]): string {
  const shown = nums.slice(0, 10).join(", ");
  return nums.length > 10 ? `${shown} and ${nums.length - 10} more` : shown;
}

type Doc = Awaited<ReturnType<typeof getDocument>["promise"]>;

async function readSections(doc: Doc, pageCount: number, warnings: string[]): Promise<ExtractedSection[]> {
  let outline: OutlineNode[] | null;
  try {
    outline = (await doc.getOutline()) as OutlineNode[] | null;
  } catch {
    warnings.push("The PDF's bookmarks could not be read, so no sections are offered.");
    return [];
  }
  if (!outline || outline.length === 0) return [];

  const flat: { title: string; level: number; pageStart: number }[] = [];
  let unresolved = 0;

  const resolvePage = async (dest: OutlineNode["dest"]): Promise<number | null> => {
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const target = explicit[0];
      if (typeof target === "number") return target >= 0 && target < pageCount ? target + 1 : null;
      const index = await doc.getPageIndex(target as Parameters<Doc["getPageIndex"]>[0]);
      return index >= 0 && index < pageCount ? index + 1 : null;
    } catch {
      return null;
    }
  };

  const walk = async (nodes: OutlineNode[], level: number): Promise<void> => {
    for (const node of nodes) {
      if (flat.length >= MAX_SECTIONS) return;
      const title = (node.title ?? "").replace(/\s+/g, " ").trim();
      const pageStart = node.dest ? await resolvePage(node.dest) : null;
      if (title && pageStart !== null) {
        flat.push({ title, level, pageStart });
      } else {
        unresolved++;
      }
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk(outline, 1);

  if (unresolved > 0) {
    warnings.push(`${unresolved} bookmark${unresolved > 1 ? "s" : ""} could not be matched to a page and ${unresolved > 1 ? "were" : "was"} left out.`);
  }

  return flat.map((entry, i) => {
    const next = flat.slice(i + 1).find((later) => later.level <= entry.level);
    const nextStart = next ? next.pageStart : pageCount + 1;
    const pageEnd = Math.min(pageCount, Math.max(entry.pageStart, nextStart - 1));
    return { title: entry.title, level: entry.level, pageStart: entry.pageStart, pageEnd };
  });
}
