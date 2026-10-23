import type { Queryable } from "../../db/types.js";

export type AttemptCheck = "ok" | "user_limit" | "global_limit";

/** Serialises limit checks so concurrent answers cannot overshoot the daily caps. */
export async function lockEvaluations(db: Queryable): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('witlab:evaluation'))");
}

/** Call inside a transaction that holds the evaluation lock. Every attempt counts, failed ones included. */
export async function checkLimits(db: Queryable, userId: string, limits: { perUserPerDay: number; globalPerDay: number }): Promise<AttemptCheck> {
  const r = await db.query<{ mine: number; total: number }>(
    `SELECT count(*) FILTER (WHERE user_id = $1)::int AS mine, count(*)::int AS total
       FROM ai_evaluations WHERE created_at > now() - interval '24 hours'`,
    [userId],
  );
  const row = r.rows[0]!;
  if (row.mine >= limits.perUserPerDay) return "user_limit";
  if (row.total >= limits.globalPerDay) return "global_limit";
  return "ok";
}

export async function reserveAttempt(db: Queryable, userId: string, input: { cardId: string; sessionId: string; model: string }): Promise<string> {
  const r = await db.query<{ id: string }>(
    "INSERT INTO ai_evaluations (user_id, card_id, session_id, status, model) VALUES ($1, $2, $3, 'pending', $4) RETURNING id",
    [userId, input.cardId, input.sessionId, input.model],
  );
  return r.rows[0]!.id;
}

export async function finishAttempt(
  db: Queryable,
  id: string,
  outcome: { status: "succeeded"; verdict: "correct" | "partial" | "incorrect" | "ambiguous" } | { status: "failed"; errorCode: string },
): Promise<void> {
  await db.query("UPDATE ai_evaluations SET status = $2, verdict = $3, error_code = $4 WHERE id = $1", [
    id,
    outcome.status,
    outcome.status === "succeeded" ? outcome.verdict : null,
    outcome.status === "failed" ? outcome.errorCode : null,
  ]);
}
