import type { GenerationJob, GenerationScope } from "@witlab/contracts";
import type { Queryable } from "../../db/types.js";
import type { Discard } from "./candidates.js";

interface JobRow {
  id: string;
  source_id: string | null;
  status: GenerationJob["status"];
  scope: GenerationScope;
  scope_chars: number;
  model: string;
  requested_cards: number;
  candidates_returned: number;
  drafts_created: number;
  discarded: Discard[];
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  finished_at: Date | null;
}

const JOB_COLUMNS = `id, source_id, status, scope, scope_chars, model, requested_cards, candidates_returned,
  drafts_created, discarded, error_code, error_message, created_at, finished_at`;

function toJob(r: JobRow): GenerationJob {
  return {
    id: r.id,
    sourceId: r.source_id,
    status: r.status,
    scope: r.scope,
    scopeChars: r.scope_chars,
    model: r.model,
    requestedCards: r.requested_cards,
    candidatesReturned: r.candidates_returned,
    draftsCreated: r.drafts_created,
    discarded: r.discarded,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  };
}

export const RUNNING_WINDOW_SECONDS = 120;

export type LimitCheck = "ok" | "in_progress" | "user_limit" | "global_limit";

/** Call inside a transaction that already holds the generation advisory lock. */
export async function checkLimits(
  db: Queryable,
  userId: string,
  limits: { perUserPerDay: number; globalPerDay: number },
): Promise<LimitCheck> {
  const r = await db.query<{ running: number; mine: number; total: number }>(
    `SELECT
       count(*) FILTER (WHERE user_id = $1 AND status = 'running'
                         AND created_at > now() - make_interval(secs => $2))::int AS running,
       count(*) FILTER (WHERE user_id = $1)::int AS mine,
       count(*)::int AS total
     FROM generation_jobs WHERE created_at > now() - interval '24 hours'`,
    [userId, RUNNING_WINDOW_SECONDS],
  );
  const row = r.rows[0]!;
  if (row.running > 0) return "in_progress";
  if (row.mine >= limits.perUserPerDay) return "user_limit";
  if (row.total >= limits.globalPerDay) return "global_limit";
  return "ok";
}

export async function lockGeneration(db: Queryable): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('witlab:generation'))");
}

export async function insertJob(
  db: Queryable,
  userId: string,
  input: { sourceId: string; scope: GenerationScope; scopeChars: number; model: string; requestedCards: number },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO generation_jobs (user_id, source_id, status, scope, scope_chars, model, requested_cards)
     VALUES ($1, $2, 'running', $3::jsonb, $4, $5, $6) RETURNING id`,
    [userId, input.sourceId, JSON.stringify(input.scope), input.scopeChars, input.model, input.requestedCards],
  );
  return r.rows[0]!.id;
}

export async function finishJobSucceeded(
  db: Queryable,
  jobId: string,
  result: { candidatesReturned: number; draftsCreated: number; discarded: Discard[] },
): Promise<void> {
  await db.query(
    `UPDATE generation_jobs SET status = 'succeeded', candidates_returned = $2, drafts_created = $3,
            discarded = $4::jsonb, finished_at = now() WHERE id = $1`,
    [jobId, result.candidatesReturned, result.draftsCreated, JSON.stringify(result.discarded)],
  );
}

export async function finishJobFailed(
  db: Queryable,
  jobId: string,
  error: { code: string; message: string; candidatesReturned?: number },
): Promise<void> {
  await db.query(
    `UPDATE generation_jobs SET status = 'failed', error_code = $2, error_message = $3,
            candidates_returned = $4, finished_at = now() WHERE id = $1`,
    [jobId, error.code, error.message.slice(0, 1000), error.candidatesReturned ?? 0],
  );
}

export async function findJob(db: Queryable, userId: string, id: string): Promise<GenerationJob | null> {
  const r = await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM generation_jobs WHERE id = $1 AND user_id = $2`, [id, userId]);
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

export async function listJobsForSource(db: Queryable, userId: string, sourceId: string, limit = 20): Promise<GenerationJob[]> {
  const r = await db.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM generation_jobs WHERE user_id = $1 AND source_id = $2
      ORDER BY created_at DESC, id LIMIT $3`,
    [userId, sourceId, limit],
  );
  return r.rows.map(toJob);
}

/** Prompts of this source's existing cards that still count (not rejected), for duplicate detection. */
export async function existingPromptsForSource(db: Queryable, userId: string, sourceId: string): Promise<string[]> {
  const r = await db.query<{ prompt: string }>(
    `SELECT DISTINCT c.prompt FROM cards c
       JOIN card_sources cs ON cs.card_id = c.id AND cs.user_id = c.user_id
      WHERE c.user_id = $1 AND cs.source_id = $2 AND c.status <> 'rejected'`,
    [userId, sourceId],
  );
  return r.rows.map((x) => x.prompt);
}
