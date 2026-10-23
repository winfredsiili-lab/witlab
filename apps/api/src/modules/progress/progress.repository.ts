import type { LearningProgress, StateCounts } from "@witlab/contracts";
import type { Queryable } from "../../db/types.js";

/** Evidence thresholds. Kept here, in one place, and described to the learner in the UI. */
export const ESTABLISHED_MIN_REPETITIONS = 3;
export const ESTABLISHED_MIN_INTERVAL_DAYS = 14;

const STATE_SQL = `CASE
  WHEN rs.card_id IS NULL THEN 'never'
  WHEN rs.last_verdict <> 'correct' THEN 'struggling'
  WHEN rs.repetitions >= ${ESTABLISHED_MIN_REPETITIONS} AND rs.interval_days >= ${ESTABLISHED_MIN_INTERVAL_DAYS} THEN 'established'
  ELSE 'learning' END`;

const empty = (): StateCounts => ({ never: 0, struggling: 0, learning: 0, established: 0 });

/**
 * The cards progress is about: approved, and either in the requested deck
 * (or in any deck when none is requested) or already practised.
 */
const UNIVERSE = `
  SELECT c.id AS card_id, c.prompt
    FROM cards c
   WHERE c.user_id = $1 AND c.status = 'approved'
     AND ( EXISTS (SELECT 1 FROM deck_cards dc WHERE dc.card_id = c.id AND dc.user_id = c.user_id AND ($2::uuid IS NULL OR dc.deck_id = $2::uuid))
           OR ($2::uuid IS NULL AND EXISTS (SELECT 1 FROM card_review_state s WHERE s.card_id = c.id AND s.user_id = c.user_id)) )`;

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getProgress(db: Queryable, userId: string, deckId: string | null, now: Date): Promise<LearningProgress> {
  const stateRows = await db.query<{ state: keyof StateCounts; n: number }>(
    `WITH u AS (${UNIVERSE})
     SELECT ${STATE_SQL} AS state, count(*)::int AS n
       FROM u LEFT JOIN card_review_state rs ON rs.card_id = u.card_id AND rs.user_id = $1
      GROUP BY 1`,
    [userId, deckId],
  );
  const states = empty();
  for (const r of stateRows.rows) states[r.state] = r.n;
  const totalCards = states.never + states.struggling + states.learning + states.established;

  const since14 = new Date(now.getTime() - 14 * 86_400_000);
  const since30 = new Date(now.getTime() - 30 * 86_400_000);

  const activityRows = await db.query<{ day: string; answered: number; correct: number }>(
    `WITH u AS (${UNIVERSE})
     SELECT to_char((r.responded_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
            count(*)::int AS answered,
            count(*) FILTER (WHERE r.verdict = 'correct')::int AS correct
       FROM study_responses r JOIN u ON u.card_id = r.card_id
      WHERE r.user_id = $1 AND r.verdict IN ('correct','partial','incorrect') AND r.responded_at >= $3 AND r.responded_at <= $4
      GROUP BY 1`,
    [userId, deckId, since14, now],
  );
  const byDay = new Map(activityRows.rows.map((r) => [r.day, r]));
  const activity: LearningProgress["activity"] = [];
  for (let i = 13; i >= 0; i--) {
    const date = dayString(new Date(now.getTime() - i * 86_400_000));
    const hit = byDay.get(date);
    activity.push({ date, answered: hit?.answered ?? 0, correct: hit?.correct ?? 0 });
  }

  const evidence = await db.query<{
    answered: number; correct: number; partial: number; incorrect: number; self: number; auto: number; ai: number; cards: number;
  }>(
    `WITH u AS (${UNIVERSE})
     SELECT count(*)::int AS answered,
            count(*) FILTER (WHERE r.verdict = 'correct')::int AS correct,
            count(*) FILTER (WHERE r.verdict = 'partial')::int AS partial,
            count(*) FILTER (WHERE r.verdict = 'incorrect')::int AS incorrect,
            count(*) FILTER (WHERE r.eval_method = 'self_assessed')::int AS self,
            count(*) FILTER (WHERE r.eval_method = 'deterministic')::int AS auto,
            count(*) FILTER (WHERE r.eval_method = 'ai')::int AS ai,
            count(DISTINCT r.card_id)::int AS cards
       FROM study_responses r JOIN u ON u.card_id = r.card_id
      WHERE r.user_id = $1 AND r.verdict IN ('correct','partial','incorrect') AND r.responded_at >= $3 AND r.responded_at <= $4`,
    [userId, deckId, since30, now],
  );
  const ev = evidence.rows[0]!;

  const attention = await db.query<{ card_id: string; prompt: string; last_verdict: "partial" | "incorrect"; lapses: number; due_at: Date }>(
    `WITH u AS (${UNIVERSE})
     SELECT u.card_id, u.prompt, rs.last_verdict, rs.lapses, rs.due_at
       FROM u JOIN card_review_state rs ON rs.card_id = u.card_id AND rs.user_id = $1
      WHERE rs.last_verdict <> 'correct'
      ORDER BY rs.last_reviewed_at DESC, u.card_id
      LIMIT 10`,
    [userId, deckId],
  );

  let decks: LearningProgress["decks"] = [];
  if (deckId === null) {
    const rows = await db.query<{ deck_id: string; title: string; state: keyof StateCounts; n: number }>(
      `SELECT d.id AS deck_id, d.title, ${STATE_SQL} AS state, count(*)::int AS n
         FROM decks d
         JOIN deck_cards dc ON dc.deck_id = d.id AND dc.user_id = d.user_id
         JOIN cards c ON c.id = dc.card_id AND c.user_id = dc.user_id AND c.status = 'approved'
         LEFT JOIN card_review_state rs ON rs.card_id = c.id AND rs.user_id = d.user_id
        WHERE d.user_id = $1
        GROUP BY d.id, d.title, 3
        ORDER BY d.title, d.id`,
      [userId],
    );
    const map = new Map<string, LearningProgress["decks"][number]>();
    for (const r of rows.rows) {
      const entry = map.get(r.deck_id) ?? { deckId: r.deck_id, title: r.title, totalCards: 0, states: empty() };
      entry.states[r.state] = r.n;
      entry.totalCards += r.n;
      map.set(r.deck_id, entry);
    }
    decks = [...map.values()];
  }

  return {
    deckId,
    totalCards,
    states,
    activity,
    last30Days: {
      answered: ev.answered, correct: ev.correct, partial: ev.partial, incorrect: ev.incorrect,
      selfAssessed: ev.self, automatic: ev.auto, aiEvaluated: ev.ai, cardsPracticed: ev.cards,
    },
    needsAttention: attention.rows.map((r) => ({
      cardId: r.card_id, prompt: r.prompt, lastVerdict: r.last_verdict, lapses: r.lapses, dueAt: r.due_at.toISOString(),
    })),
    decks,
  };
}
