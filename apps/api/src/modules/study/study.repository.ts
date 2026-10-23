import { HYBRID_PHASES, type PhaseMode } from "@witlab/contracts";
import type {
  CardType,
  Overview,
  Progress,
  ResultItem,
  SessionDetail,
  SessionSummary,
  StudyItem,
  StudyMode,
  Verdict,
} from "@witlab/contracts";
import type { Queryable } from "../../db/types.js";
import { evaluationKind } from "../evaluation/evaluator.js";
import type { ReviewState, ScheduledVerdict } from "../scheduling/scheduler.js";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Review state
// ---------------------------------------------------------------------------

interface ReviewStateRow {
  due_at: Date;
  interval_days: number;
  ease: number;
  repetitions: number;
  lapses: number;
  last_reviewed_at: Date;
  last_verdict: ScheduledVerdict;
}

const STATE_COLUMNS = "due_at, interval_days, ease::float8 AS ease, repetitions, lapses, last_reviewed_at, last_verdict";

function toState(row: ReviewStateRow): ReviewState {
  return {
    dueAt: row.due_at,
    intervalDays: row.interval_days,
    ease: row.ease,
    repetitions: row.repetitions,
    lapses: row.lapses,
    lastReviewedAt: row.last_reviewed_at,
    lastVerdict: row.last_verdict,
  };
}

/** Reads and locks a card's review state so two concurrent answers cannot interleave. */
export async function lockReviewState(db: Queryable, userId: string, cardId: string): Promise<ReviewState | null> {
  const result = await db.query<ReviewStateRow>(
    `SELECT ${STATE_COLUMNS} FROM card_review_state WHERE user_id = $1 AND card_id = $2 FOR UPDATE`,
    [userId, cardId],
  );
  return result.rows[0] ? toState(result.rows[0]) : null;
}

export async function upsertReviewState(db: Queryable, userId: string, cardId: string, state: ReviewState): Promise<void> {
  await db.query(
    `INSERT INTO card_review_state
       (user_id, card_id, due_at, interval_days, ease, repetitions, lapses, last_reviewed_at, last_verdict)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, card_id) DO UPDATE SET
       due_at = EXCLUDED.due_at,
       interval_days = EXCLUDED.interval_days,
       ease = EXCLUDED.ease,
       repetitions = EXCLUDED.repetitions,
       lapses = EXCLUDED.lapses,
       last_reviewed_at = EXCLUDED.last_reviewed_at,
       last_verdict = EXCLUDED.last_verdict,
       updated_at = now()`,
    [
      userId,
      cardId,
      state.dueAt,
      state.intervalDays,
      state.ease,
      state.repetitions,
      state.lapses,
      state.lastReviewedAt,
      state.lastVerdict,
    ],
  );
}

// ---------------------------------------------------------------------------
// Queue building and overview
// ---------------------------------------------------------------------------

/**
 * Which cards a mode studies. Recall: every card type except open_ended. Explain, Connections and Apply: open_ended
 * cards made for that learning mode. `n` is the placeholder number of the mode parameter.
 */
function modeSql(n: number): string {
  return `((\$${n}::text = 'recall' AND c.card_type <> 'open_ended') OR (c.card_type = 'open_ended' AND c.learning_mode = \$${n}::text))`;
}

export interface QueueCard {
  cardId: string;
  /** Null when the card has never been practised. */
  state: ReviewState | null;
}

/**
 * Eligible cards for a Recall session: approved, evaluable without AI, and either due or never practised.
 * Due cards come first (most overdue first), then new cards in deck order.
 * Without a deck (global review) only cards that are due are returned.
 */
export async function findQueue(
  db: Queryable,
  userId: string,
  deckId: string | null,
  now: Date,
  limit: number,
  mode: StudyMode,
): Promise<QueueCard[]> {
  const stateCols = "rs.due_at, rs.interval_days, rs.ease::float8 AS ease, rs.repetitions, rs.lapses, rs.last_reviewed_at, rs.last_verdict";

  const result =
    deckId !== null
      ? await db.query<ReviewStateRow & { card_id: string; has_state: boolean }>(
          `SELECT c.id AS card_id, (rs.card_id IS NOT NULL) AS has_state, ${stateCols}
           FROM deck_cards dc
           JOIN cards c ON c.id = dc.card_id AND c.user_id = dc.user_id
                        AND c.status = 'approved' AND ${modeSql(5)}
           LEFT JOIN card_review_state rs ON rs.card_id = c.id AND rs.user_id = dc.user_id
           WHERE dc.deck_id = $2 AND dc.user_id = $1
             AND (rs.card_id IS NULL OR rs.due_at <= $3)
           ORDER BY (rs.card_id IS NULL), rs.due_at, dc.position, c.id
           LIMIT $4`,
          [userId, deckId, now, limit, mode],
        )
      : await db.query<ReviewStateRow & { card_id: string; has_state: boolean }>(
          `SELECT c.id AS card_id, true AS has_state, ${stateCols}
           FROM card_review_state rs
           JOIN cards c ON c.id = rs.card_id AND c.user_id = rs.user_id
                        AND c.status = 'approved' AND ${modeSql(4)}
           WHERE rs.user_id = $1 AND rs.due_at <= $2
           ORDER BY rs.due_at, c.id
           LIMIT $3`,
          [userId, now, limit, mode],
        );

  return result.rows.map((row) => ({ cardId: row.card_id, state: row.has_state ? toState(row) : null }));
}

/** Hybrid: the four phases' queues in order, each capped so one phase cannot crowd out the rest. */
export async function findHybridQueue(db: Queryable, userId: string, deckId: string | null, now: Date, limit: number): Promise<QueueCard[]> {
  const perPhase = Math.max(1, Math.ceil(limit / HYBRID_PHASES.length));
  const queue: QueueCard[] = [];
  for (const phase of HYBRID_PHASES) {
    queue.push(...(await findQueue(db, userId, deckId, now, perPhase, phase)));
  }
  return queue.slice(0, limit);
}

/** Hybrid overview: the sum over the four phases. */
export async function getHybridOverview(db: Queryable, userId: string, deckId: string | null, now: Date): Promise<Overview> {
  const parts = await Promise.all(HYBRID_PHASES.map((m) => getOverview(db, userId, deckId, now, m)));
  const next = parts.map((p) => p.nextDueAt).filter((x): x is string => x !== null).sort()[0] ?? null;
  return {
    dueCount: parts.reduce((n, p) => n + p.dueCount, 0),
    newCount: parts.reduce((n, p) => n + p.newCount, 0),
    eligibleCount: parts.reduce((n, p) => n + p.eligibleCount, 0),
    nextDueAt: next,
  };
}

export async function getOverview(db: Queryable, userId: string, deckId: string | null, now: Date, mode: StudyMode = "recall"): Promise<Overview> {
  if (mode === "hybrid") return getHybridOverview(db, userId, deckId, now);
  if (deckId !== null) {
    const result = await db.query<{ eligible: number; new_count: number; due_count: number; next_due_at: Date | null }>(
      `SELECT count(*)::int AS eligible,
              count(*) FILTER (WHERE rs.card_id IS NULL)::int AS new_count,
              count(*) FILTER (WHERE rs.card_id IS NOT NULL AND rs.due_at <= $3)::int AS due_count,
              min(rs.due_at) FILTER (WHERE rs.due_at > $3) AS next_due_at
       FROM deck_cards dc
       JOIN cards c ON c.id = dc.card_id AND c.user_id = dc.user_id
                    AND c.status = 'approved' AND ${modeSql(4)}
       LEFT JOIN card_review_state rs ON rs.card_id = c.id AND rs.user_id = dc.user_id
       WHERE dc.deck_id = $2 AND dc.user_id = $1`,
      [userId, deckId, now, mode],
    );
    const row = result.rows[0]!;
    return {
      dueCount: row.due_count,
      newCount: row.new_count,
      eligibleCount: row.eligible,
      nextDueAt: row.next_due_at ? row.next_due_at.toISOString() : null,
    };
  }

  const result = await db.query<{ eligible: number; due_count: number; next_due_at: Date | null }>(
    `SELECT count(*)::int AS eligible,
            count(*) FILTER (WHERE rs.due_at <= $2)::int AS due_count,
            min(rs.due_at) FILTER (WHERE rs.due_at > $2) AS next_due_at
     FROM card_review_state rs
     JOIN cards c ON c.id = rs.card_id AND c.user_id = rs.user_id
                  AND c.status = 'approved' AND ${modeSql(3)}
     WHERE rs.user_id = $1`,
    [userId, now, mode],
  );
  const row = result.rows[0]!;
  return {
    dueCount: row.due_count,
    newCount: 0,
    eligibleCount: row.eligible,
    nextDueAt: row.next_due_at ? row.next_due_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function insertSession(db: Queryable, userId: string, deckId: string | null, mode: StudyMode): Promise<string> {
  const result = await db.query<{ id: string }>(
    "INSERT INTO study_sessions (user_id, deck_id, mode) VALUES ($1, $2, $3) RETURNING id",
    [userId, deckId, mode],
  );
  return result.rows[0]!.id;
}

export async function insertItems(
  db: Queryable,
  userId: string,
  sessionId: string,
  items: Array<{ cardId: string; reason: string }>,
): Promise<void> {
  for (const [position, item] of items.entries()) {
    await db.query(
      `INSERT INTO study_session_items (session_id, card_id, user_id, position, queue_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, item.cardId, userId, position, item.reason],
    );
  }
}

export interface LockedSession {
  id: string;
  status: "active" | "completed" | "abandoned";
  mode: StudyMode;
  deckId: string | null;
}

/** Locks the session row until the transaction ends, serialising answers within one session. */
export async function lockSession(db: Queryable, userId: string, id: string): Promise<LockedSession | null> {
  const result = await db.query<{ id: string; status: LockedSession["status"]; mode: StudyMode; deck_id: string | null }>(
    "SELECT id, status, mode, deck_id FROM study_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
    [id, userId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status, mode: row.mode, deckId: row.deck_id } : null;
}

export async function setSessionStatus(
  db: Queryable,
  userId: string,
  id: string,
  status: "completed" | "abandoned",
): Promise<void> {
  await db.query("UPDATE study_sessions SET status = $3, ended_at = now() WHERE id = $1 AND user_id = $2", [id, userId, status]);
}

export async function sessionItemExists(db: Queryable, userId: string, sessionId: string, cardId: string): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM study_session_items WHERE session_id = $1 AND card_id = $2 AND user_id = $3",
    [sessionId, cardId, userId],
  );
  return result.rows.length > 0;
}

export async function responseExists(db: Queryable, sessionId: string, cardId: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM study_responses WHERE session_id = $1 AND card_id = $2", [sessionId, cardId]);
  return result.rows.length > 0;
}

export async function countUnanswered(db: Queryable, userId: string, sessionId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM study_session_items i
     LEFT JOIN study_responses r ON r.session_id = i.session_id AND r.card_id = i.card_id
     WHERE i.session_id = $1 AND i.user_id = $2 AND r.id IS NULL`,
    [sessionId, userId],
  );
  return result.rows[0]!.n;
}

export interface CardForStudy {
  id: string;
  cardType: CardType;
  answer: string;
  answerSpec: Json | null;
  explanation: string | null;
  revision: number;
  prompt: string;
  rubric: Json | null;
  learningMode: "explain" | "connections" | "apply" | null;
}

/** Where a card stands in a session, read without locking. Used to decide how an answer is evaluated. */
export async function findSessionCard(
  db: Queryable,
  userId: string,
  sessionId: string,
  cardId: string,
): Promise<{ sessionStatus: "active" | "completed" | "abandoned"; cardType: CardType; answered: boolean } | null> {
  const result = await db.query<{ status: "active" | "completed" | "abandoned"; card_type: CardType; answered: boolean }>(
    `SELECT s.status, c.card_type,
            EXISTS (SELECT 1 FROM study_responses r WHERE r.session_id = s.id AND r.card_id = i.card_id) AS answered
       FROM study_sessions s
       JOIN study_session_items i ON i.session_id = s.id AND i.card_id = $3
       JOIN cards c ON c.id = i.card_id AND c.user_id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2`,
    [sessionId, userId, cardId],
  );
  const row = result.rows[0];
  return row ? { sessionStatus: row.status, cardType: row.card_type, answered: row.answered } : null;
}

/** Up to three passages the card was made from, so a written answer can be judged against the source. */
export async function findCardExcerpts(db: Queryable, userId: string, cardId: string): Promise<string[]> {
  const result = await db.query<{ excerpt: string }>(
    "SELECT excerpt FROM card_sources WHERE card_id = $1 AND user_id = $2 ORDER BY created_at, id LIMIT 3",
    [cardId, userId],
  );
  return result.rows.map((r) => r.excerpt);
}

/** Reads the card as it is right now and blocks edits until the answer is recorded (FOR SHARE). */
export async function lockCardForStudy(db: Queryable, userId: string, cardId: string): Promise<CardForStudy | null> {
  const result = await db.query<{
    id: string;
    card_type: CardType;
    answer: string;
    answer_spec: Json | null;
    explanation: string | null;
    revision: number;
    prompt: string;
    rubric: Json | null;
    learning_mode: "explain" | "connections" | "apply" | null;
  }>(
    `SELECT id, card_type, answer, answer_spec, explanation, revision, prompt, rubric, learning_mode
     FROM cards WHERE id = $1 AND user_id = $2 AND status = 'approved' FOR SHARE`,
    [cardId, userId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        cardType: row.card_type,
        answer: row.answer,
        answerSpec: row.answer_spec,
        explanation: row.explanation,
        revision: row.revision,
        prompt: row.prompt,
        rubric: row.rubric,
        learningMode: row.learning_mode,
      }
    : null;
}

export interface NewResponse {
  sessionId: string;
  cardId: string;
  cardRevision: number;
  submittedAnswer: string | null;
  verdict: Verdict;
  evalMethod: "deterministic" | "self_assessed" | "ai";
  feedback: string;
  confidence: number | null;
  metadata: Json;
  respondedAt: Date;
}

export async function insertResponse(db: Queryable, userId: string, response: NewResponse): Promise<void> {
  await db.query(
    `INSERT INTO study_responses
       (session_id, card_id, user_id, card_revision, submitted_answer, verdict, eval_method, feedback, confidence, evaluator_metadata, responded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [
      response.sessionId,
      response.cardId,
      userId,
      response.cardRevision,
      response.submittedAnswer,
      response.verdict,
      response.evalMethod,
      response.feedback,
      response.confidence,
      JSON.stringify(response.metadata),
      response.respondedAt,
    ],
  );
}

interface ItemRow {
  card_id: string;
  position: number;
  queue_reason: string;
  card_type: CardType;
  learning_mode: "explain" | "connections" | "apply" | null;
  prompt: string;
  answer: string;
  answer_spec: Json | null;
  verdict: Verdict | null;
  eval_method: "deterministic" | "self_assessed" | "ai" | null;
  feedback: string | null;
  submitted_answer: string | null;
  confidence: number | null;
  responded_at: Date | null;
}

interface SessionRow {
  id: string;
  mode: StudyMode;
  status: "active" | "completed" | "abandoned";
  deck_id: string | null;
  deck_title: string | null;
  started_at: Date;
  ended_at: Date | null;
}

function phaseOf(row: Pick<ItemRow, "card_type" | "learning_mode">): PhaseMode {
  return row.card_type === "open_ended" ? (row.learning_mode ?? "explain") : "recall";
}

function buildStudyItem(row: ItemRow): StudyItem {
  const kind = evaluationKind(row.card_type);
  return {
    cardId: row.card_id,
    position: row.position,
    cardType: row.card_type,
    prompt: row.prompt,
    choices: row.card_type === "multiple_choice" ? ((row.answer_spec?.choices as string[] | undefined) ?? []) : null,
    evaluation: kind,
    phase: phaseOf(row),
    reason: row.queue_reason,
    // The model answer is only sent for self-assessed cards, where seeing it is the point.
    revealAnswer: kind === "self" ? row.answer : null,
  };
}

export async function loadSessionDetail(db: Queryable, userId: string, sessionId: string): Promise<SessionDetail | null> {
  const sessionResult = await db.query<SessionRow>(
    `SELECT s.id, s.mode, s.status, s.deck_id, d.title AS deck_title, s.started_at, s.ended_at
     FROM study_sessions s
     LEFT JOIN decks d ON d.id = s.deck_id AND d.user_id = s.user_id
     WHERE s.id = $1 AND s.user_id = $2`,
    [sessionId, userId],
  );
  const session = sessionResult.rows[0];
  if (!session) return null;

  const itemResult = await db.query<ItemRow>(
    `SELECT i.card_id, i.position, i.queue_reason, c.card_type, c.learning_mode, c.prompt, c.answer, c.answer_spec,
            r.verdict, r.eval_method, r.feedback, r.submitted_answer, r.confidence, r.responded_at
     FROM study_session_items i
     JOIN cards c ON c.id = i.card_id AND c.user_id = i.user_id
     LEFT JOIN study_responses r ON r.session_id = i.session_id AND r.card_id = i.card_id
     WHERE i.session_id = $1 AND i.user_id = $2
     ORDER BY i.position`,
    [sessionId, userId],
  );

  const progress: Progress = { total: itemResult.rows.length, answered: 0, correct: 0, partial: 0, incorrect: 0 };
  const results: ResultItem[] = [];
  let current: StudyItem | null = null;
  const phaseCounts = new Map<PhaseMode, { total: number; answered: number }>();

  for (const row of itemResult.rows) {
    const counts = phaseCounts.get(phaseOf(row)) ?? { total: 0, answered: 0 };
    counts.total += 1;
    if (row.verdict !== null) counts.answered += 1;
    phaseCounts.set(phaseOf(row), counts);
    if (row.verdict === null) {
      if (current === null && session.status === "active") current = buildStudyItem(row);
      continue;
    }
    progress.answered += 1;
    if (row.verdict === "correct") progress.correct += 1;
    else if (row.verdict === "partial") progress.partial += 1;
    else if (row.verdict === "incorrect") progress.incorrect += 1;
    results.push({
      cardId: row.card_id,
      position: row.position,
      cardType: row.card_type,
      prompt: row.prompt,
      verdict: row.verdict,
      evalMethod: row.eval_method!,
      feedback: row.feedback!,
      submittedAnswer: row.submitted_answer,
      correctAnswer: row.answer,
      confidence: row.confidence,
      respondedAt: row.responded_at!.toISOString(),
    });
  }

  return {
    id: session.id,
    mode: session.mode,
    status: session.status,
    deckId: session.deck_id,
    deckTitle: session.deck_title,
    startedAt: session.started_at.toISOString(),
    endedAt: session.ended_at ? session.ended_at.toISOString() : null,
    progress,
    phases: session.mode === "hybrid" ? HYBRID_PHASES.filter((m) => phaseCounts.has(m)).map((m) => ({ mode: m, ...phaseCounts.get(m)! })) : null,
    current,
    results,
  };
}

export async function listSessions(
  db: Queryable,
  userId: string,
  query: { status?: SessionDetail["status"]; deckId?: string; limit: number },
): Promise<SessionSummary[]> {
  const result = await db.query<SessionRow & { total: number; answered: number }>(
    `SELECT s.id, s.mode, s.status, s.deck_id, d.title AS deck_title, s.started_at, s.ended_at,
            (SELECT count(*)::int FROM study_session_items i WHERE i.session_id = s.id) AS total,
            (SELECT count(*)::int FROM study_responses r WHERE r.session_id = s.id) AS answered
     FROM study_sessions s
     LEFT JOIN decks d ON d.id = s.deck_id AND d.user_id = s.user_id
     WHERE s.user_id = $1
       AND ($2::text IS NULL OR s.status = $2::text)
       AND ($3::uuid IS NULL OR s.deck_id = $3::uuid)
     ORDER BY s.started_at DESC, s.id
     LIMIT $4`,
    [userId, query.status ?? null, query.deckId ?? null, query.limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    mode: row.mode,
    status: row.status,
    deckId: row.deck_id,
    deckTitle: row.deck_title,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    total: row.total,
    answered: row.answered,
  }));
}
