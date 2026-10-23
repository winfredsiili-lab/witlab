import type { PdfPageInfo, SourceDetail, SourceSection, SourceSummary } from "@witlab/contracts";
import type { Queryable } from "../../db/types.js";

const SUMMARY_COLUMNS = `id, title, source_type, status, error_message, original_filename, page_count, file_size,
  COALESCE(char_length(content_text),
           (SELECT sum(char_length(p.content))::int FROM source_pages p WHERE p.source_id = sources.id)) AS content_length,
  created_at, updated_at`;

interface SourceRow {
  id: string;
  title: string;
  source_type: "text" | "pdf";
  status: "pending" | "processing" | "ready" | "failed";
  error_message: string | null;
  original_filename: string | null;
  page_count: number | null;
  file_size: number | null;
  content_length: number | null;
  content_text?: string | null;
  created_at: Date;
  updated_at: Date;
}

function toSummary(row: SourceRow): SourceSummary {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    status: row.status,
    errorMessage: row.error_message,
    originalFilename: row.original_filename,
    pageCount: row.page_count,
    fileSize: row.file_size,
    contentLength: row.content_length,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toDetail(row: SourceRow): SourceDetail {
  return { ...toSummary(row), contentText: row.content_text ?? null };
}

export async function insertTextSource(
  db: Queryable,
  userId: string,
  input: { title: string; contentText: string },
): Promise<SourceDetail> {
  const result = await db.query<SourceRow>(
    `INSERT INTO sources (user_id, title, source_type, status, content_text)
     VALUES ($1, $2, 'text', 'ready', $3)
     RETURNING ${SUMMARY_COLUMNS}, content_text`,
    [userId, input.title, input.contentText],
  );
  return toDetail(result.rows[0]!);
}

export interface SectionInput {
  kind: "bookmark" | "heading" | "auto_part";
  title: string;
  level: number;
  pageStart?: number;
  pageEnd?: number;
  charStart?: number;
  charEnd?: number;
}

export async function insertSections(db: Queryable, userId: string, sourceId: string, sections: SectionInput[]): Promise<void> {
  for (const [position, s] of sections.entries()) {
    await db.query(
      `INSERT INTO source_sections (source_id, user_id, position, kind, title, level, page_start, page_end, char_start, char_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [sourceId, userId, position, s.kind, s.title, s.level, s.pageStart ?? null, s.pageEnd ?? null, s.charStart ?? null, s.charEnd ?? null],
    );
  }
}

export async function insertPdfSource(
  db: Queryable,
  userId: string,
  input: {
    title: string;
    filename: string | null;
    fileSize: number;
    pageCount: number;
    pages: { pageNumber: number; text: string }[];
    sections: SectionInput[];
  },
): Promise<string> {
  const created = await db.query<{ id: string }>(
    `INSERT INTO sources (user_id, title, source_type, status, original_filename, page_count, file_size)
     VALUES ($1, $2, 'pdf', 'ready', $3, $4, $5) RETURNING id`,
    [userId, input.title, input.filename, input.pageCount, input.fileSize],
  );
  const id = created.rows[0]!.id;
  await db.query(
    `INSERT INTO source_pages (source_id, user_id, page_number, content)
     SELECT $1, $2, n, c FROM unnest($3::int[], $4::text[]) AS t(n, c)`,
    [id, userId, input.pages.map((p) => p.pageNumber), input.pages.map((p) => p.text)],
  );
  await insertSections(db, userId, id, input.sections);
  return id;
}

/** A PDF that could not be read is kept as a failed source so the learner can see what happened and delete it. */
export async function insertFailedPdfSource(
  db: Queryable,
  userId: string,
  input: { title: string; filename: string | null; fileSize: number; errorMessage: string },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO sources (user_id, title, source_type, status, error_message, original_filename, file_size)
     VALUES ($1, $2, 'pdf', 'failed', $3, $4, $5) RETURNING id`,
    [userId, input.title, input.errorMessage, input.filename, input.fileSize],
  );
  return result.rows[0]!.id;
}

export async function listSections(db: Queryable, userId: string, sourceId: string): Promise<SourceSection[]> {
  const result = await db.query<{
    id: string; position: number; kind: SourceSection["kind"]; title: string; level: number;
    page_start: number | null; page_end: number | null; char_start: number | null; char_end: number | null;
    text_length: number | null;
  }>(
    `SELECT s.id, s.position, s.kind, s.title, s.level, s.page_start, s.page_end, s.char_start, s.char_end,
            CASE WHEN s.char_start IS NOT NULL THEN s.char_end - s.char_start
                 ELSE (SELECT COALESCE(sum(char_length(p.content)), 0)::int FROM source_pages p
                        WHERE p.source_id = s.source_id AND p.page_number BETWEEN s.page_start AND s.page_end) END AS text_length
       FROM source_sections s
      WHERE s.source_id = $1 AND s.user_id = $2
      ORDER BY s.position`,
    [sourceId, userId],
  );
  return result.rows.map((r) => ({
    id: r.id, position: r.position, kind: r.kind, title: r.title, level: r.level,
    pageStart: r.page_start, pageEnd: r.page_end, charStart: r.char_start, charEnd: r.char_end,
    textLength: r.text_length ?? 0,
  }));
}

export async function listPages(db: Queryable, userId: string, sourceId: string): Promise<PdfPageInfo[]> {
  const result = await db.query<{ page_number: number; char_length: number }>(
    `SELECT page_number, char_length(content) AS char_length FROM source_pages
      WHERE source_id = $1 AND user_id = $2 ORDER BY page_number`,
    [sourceId, userId],
  );
  return result.rows.map((r) => ({ pageNumber: r.page_number, charLength: r.char_length }));
}

export async function findPageText(db: Queryable, userId: string, sourceId: string, pageNumber: number): Promise<string | null> {
  const result = await db.query<{ content: string }>(
    "SELECT content FROM source_pages WHERE source_id = $1 AND user_id = $2 AND page_number = $3",
    [sourceId, userId, pageNumber],
  );
  return result.rows[0]?.content ?? null;
}

/** Page texts in an inclusive range, in order. */
export async function findPageRange(
  db: Queryable, userId: string, sourceId: string, from: number, to: number,
): Promise<{ pageNumber: number; content: string }[]> {
  const result = await db.query<{ page_number: number; content: string }>(
    `SELECT page_number, content FROM source_pages
      WHERE source_id = $1 AND user_id = $2 AND page_number BETWEEN $3 AND $4 ORDER BY page_number`,
    [sourceId, userId, from, to],
  );
  return result.rows.map((r) => ({ pageNumber: r.page_number, content: r.content }));
}

export async function findSection(db: Queryable, userId: string, sourceId: string, sectionId: string): Promise<SourceSection | null> {
  return (await listSections(db, userId, sourceId)).find((s) => s.id === sectionId) ?? null;
}

export async function listSources(
  db: Queryable,
  userId: string,
  page: { limit: number; offset: number },
): Promise<{ items: SourceSummary[]; total: number }> {
  const [rows, count] = await Promise.all([
    db.query<SourceRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM sources
       WHERE user_id = $1
       ORDER BY created_at DESC, id
       LIMIT $2 OFFSET $3`,
      [userId, page.limit, page.offset],
    ),
    db.query<{ total: number }>("SELECT count(*)::int AS total FROM sources WHERE user_id = $1", [userId]),
  ]);
  return { items: rows.rows.map(toSummary), total: count.rows[0]!.total };
}

export async function findSource(db: Queryable, userId: string, id: string): Promise<SourceDetail | null> {
  const result = await db.query<SourceRow>(
    `SELECT ${SUMMARY_COLUMNS}, content_text FROM sources WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ? toDetail(result.rows[0]) : null;
}

export async function updateSourceTitle(
  db: Queryable,
  userId: string,
  id: string,
  title: string,
): Promise<SourceDetail | null> {
  const result = await db.query<SourceRow>(
    `UPDATE sources SET title = $3, updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING ${SUMMARY_COLUMNS}, content_text`,
    [id, userId, title],
  );
  return result.rows[0] ? toDetail(result.rows[0]) : null;
}

export async function deleteSource(db: Queryable, userId: string, id: string): Promise<boolean> {
  const result = await db.query("DELETE FROM sources WHERE id = $1 AND user_id = $2", [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

/** Returns id and title for each requested source the user owns. Used to validate provenance links. */
export async function findOwnedSourceTitles(
  db: Queryable,
  userId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await db.query<{ id: string; title: string }>(
    "SELECT id, title FROM sources WHERE user_id = $1 AND id = ANY($2::uuid[])",
    [userId, ids],
  );
  return new Map(result.rows.map((r) => [r.id, r.title]));
}
