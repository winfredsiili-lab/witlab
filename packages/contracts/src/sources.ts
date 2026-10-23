import { z } from "zod";
import { idSchema, pageSchema, timestampSchema } from "./common.js";

export const sourceTypeSchema = z.enum(["text", "pdf"]);
export const sourceStatusSchema = z.enum(["pending", "processing", "ready", "failed"]);

/**
 * Pasted text is created with this JSON body. A PDF is uploaded as raw bytes to `POST /api/sources/pdf`
 * (see `pdfUploadQuerySchema`), so `sourceType: "pdf"` is not accepted here.
 */
export const createSourceSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceType: z.literal("text"),
  contentText: z
    .string()
    .max(250_000)
    .refine((s) => s.trim().length > 0, "contentText must not be blank."),
}).strict();

/** Query string of `POST /api/sources/pdf` (the body is the raw PDF). The title defaults to the file name. */
export const pdfUploadQuerySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  filename: z.string().trim().min(1).max(255).optional(),
});

export const updateSourceSchema = z.object({
  title: z.string().trim().min(1).max(200),
}).strict();

export const sourceSummarySchema = z.object({
  id: idSchema,
  title: z.string(),
  sourceType: sourceTypeSchema,
  status: sourceStatusSchema,
  errorMessage: z.string().nullable(),
  originalFilename: z.string().nullable(),
  /** PDF only. */
  pageCount: z.number().int().nullable(),
  /** PDF only: size of the uploaded file in bytes (the file itself is not kept, only its text). */
  fileSize: z.number().int().nullable(),
  /** Length of the stored text in characters. The text itself is only returned by the detail endpoint. */
  contentLength: z.number().int().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const sourceDetailSchema = sourceSummarySchema.extend({
  contentText: z.string().nullable(),
});

export const sourceListSchema = pageSchema(sourceSummarySchema);

export const sectionKindSchema = z.enum(["bookmark", "heading", "auto_part"]);

/** A part of a source that can be chosen as the scope for card generation. Either pages (PDF) or characters (text). */
export const sourceSectionSchema = z.object({
  id: idSchema,
  position: z.number().int(),
  kind: sectionKindSchema,
  title: z.string(),
  level: z.number().int().min(1),
  pageStart: z.number().int().nullable(),
  pageEnd: z.number().int().nullable(),
  charStart: z.number().int().nullable(),
  charEnd: z.number().int().nullable(),
  /** Characters of text in the section, so a client can tell whether it fits the generation limit. */
  textLength: z.number().int(),
});

export const sourceSectionsSchema = z.object({ items: z.array(sourceSectionSchema) });

export const pdfPageInfoSchema = z.object({ pageNumber: z.number().int(), charLength: z.number().int() });
export const pdfPagesSchema = z.object({ items: z.array(pdfPageInfoSchema) });
export const pdfPageTextSchema = z.object({ pageNumber: z.number().int(), content: z.string() });

/** Anything noteworthy found while importing, for example pages without text. Empty for plain text. */
export const importWarningsSchema = z.array(z.string());

export type CreateSourceInput = z.infer<typeof createSourceSchema>;
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;
export type SourceSummary = z.infer<typeof sourceSummarySchema>;
export type SourceDetail = z.infer<typeof sourceDetailSchema>;
export type SourceList = z.infer<typeof sourceListSchema>;
export type SourceSection = z.infer<typeof sourceSectionSchema>;
export type PdfPageInfo = z.infer<typeof pdfPageInfoSchema>;
export type PdfUploadQuery = z.infer<typeof pdfUploadQuerySchema>;
