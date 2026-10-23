import type pg from "pg";
import type {
  CreateSourceInput,
  ListQuery,
  PdfPageInfo,
  SourceDetail,
  SourceList,
  SourceSection,
  UpdateSourceInput,
} from "@witlab/contracts";
import { withTransaction } from "../../db/types.js";
import { HttpError, notFoundError } from "../../middleware/errorHandler.js";
import { extractPdf, PdfExtractionError } from "./pdf/extractPdf.js";
import * as sources from "./source.repository.js";
import { detectTextSections } from "./textSections.js";

export interface PdfImportResult {
  source: SourceDetail;
  /** Notes for the learner, for example pages without readable text. */
  warnings: string[];
}

function titleFromFilename(filename: string | null): string {
  const base = (filename ?? "").replace(/\.pdf$/i, "").trim();
  return (base || "Untitled PDF").slice(0, 200);
}

export function createSourceService(pool: pg.Pool) {
  async function getOwned(userId: string, id: string): Promise<SourceDetail> {
    const source = await sources.findSource(pool, userId, id);
    if (!source) throw notFoundError("Source");
    return source;
  }

  return {
    async create(userId: string, input: CreateSourceInput): Promise<SourceDetail> {
      return withTransaction(pool, async (tx) => {
        const source = await sources.insertTextSource(tx, userId, {
          title: input.title,
          contentText: input.contentText,
        });
        await sources.insertSections(tx, userId, source.id, detectTextSections(input.contentText));
        return source;
      });
    },

    /**
     * Extracts the PDF and stores its text, pages and sections. A file that cannot be read is stored as a
     * `failed` source with a plain-language reason, never as a half-imported `ready` one.
     */
    async importPdf(
      userId: string,
      file: Buffer,
      opts: { title?: string; filename?: string },
    ): Promise<PdfImportResult> {
      if (file.length === 0) {
        throw new HttpError(400, "validation_error", "The uploaded file is empty.", [
          { path: "body", message: "send the PDF file as the request body" },
        ]);
      }
      const filename = opts.filename ?? null;
      const title = opts.title ?? titleFromFilename(filename);

      let extraction;
      try {
        extraction = await extractPdf(new Uint8Array(file));
      } catch (err) {
        if (!(err instanceof PdfExtractionError)) throw err;
        const id = await sources.insertFailedPdfSource(pool, userId, {
          title,
          filename,
          fileSize: file.length,
          errorMessage: err.message,
        });
        return { source: (await sources.findSource(pool, userId, id))!, warnings: [] };
      }

      const id = await withTransaction(pool, (tx) =>
        sources.insertPdfSource(tx, userId, {
          title,
          filename,
          fileSize: file.length,
          pageCount: extraction.pageCount,
          pages: extraction.pages,
          sections: extraction.sections.map((s) => ({
            kind: "bookmark" as const,
            title: s.title,
            level: s.level,
            pageStart: s.pageStart,
            pageEnd: s.pageEnd,
          })),
        }),
      );
      return { source: (await sources.findSource(pool, userId, id))!, warnings: extraction.warnings };
    },

    list(userId: string, query: ListQuery): Promise<SourceList> {
      return sources.listSources(pool, userId, query);
    },

    get: getOwned,

    async sections(userId: string, id: string): Promise<SourceSection[]> {
      await getOwned(userId, id);
      return sources.listSections(pool, userId, id);
    },

    async pages(userId: string, id: string): Promise<PdfPageInfo[]> {
      await getOwned(userId, id);
      return sources.listPages(pool, userId, id);
    },

    async pageText(userId: string, id: string, pageNumber: number): Promise<{ pageNumber: number; content: string }> {
      await getOwned(userId, id);
      const content = await sources.findPageText(pool, userId, id, pageNumber);
      if (content === null) throw notFoundError("Page");
      return { pageNumber, content };
    },

    async update(userId: string, id: string, input: UpdateSourceInput): Promise<SourceDetail> {
      const source = await sources.updateSourceTitle(pool, userId, id, input.title);
      if (!source) throw notFoundError("Source");
      return source;
    },

    /** Cards made from this source survive; their provenance keeps the excerpt and a title snapshot. */
    async delete(userId: string, id: string): Promise<void> {
      const deleted = await sources.deleteSource(pool, userId, id);
      if (!deleted) throw notFoundError("Source");
    },
  };
}

export type SourceService = ReturnType<typeof createSourceService>;
