import type { Queryable } from "../db/types.js";

/**
 * Database integrity checks: invariants that the schema's constraints cannot express on their own.
 * Each check is a query that returns the rows that BREAK the rule, so zero rows means the rule holds.
 * Read-only. Run with `npm run check:db`, and in the test suite after realistic flows.
 *  - "error": the data is wrong and something is broken.
 *  - "warning": something is stuck or stale and worth a look, but is not corruption.
 */
export interface IntegrityCheck {
  name: string;
  rule: string;
  severity: "error" | "warning";
  sql: string;
}

export const CHECKS: IntegrityCheck[] = [
  {
    name: "approved-have-timestamp",
    rule: "Approved cards have approved_at and nothing else does.",
    severity: "error",
    sql: "SELECT id FROM cards WHERE (status = 'approved') <> (approved_at IS NOT NULL)",
  },
  {
    name: "only-approved-in-decks",
    rule: "Only approved cards are in decks (drafts and rejected cards never reach study).",
    severity: "error",
    sql: "SELECT dc.card_id AS id FROM deck_cards dc JOIN cards c ON c.id = dc.card_id AND c.user_id = dc.user_id WHERE c.status <> 'approved'",
  },
  {
    name: "ai-cards-have-provenance",
    rule: "Every AI-generated card keeps at least one source reference.",
    severity: "error",
    sql: "SELECT c.id FROM cards c WHERE c.origin = 'ai_generated' AND NOT EXISTS (SELECT 1 FROM card_sources s WHERE s.card_id = c.id)",
  },
  {
    name: "excerpts-match-text-sources",
    rule: "For text sources, a reference's excerpt is exactly the source text at its recorded offsets.",
    severity: "error",
    sql: `SELECT cs.id FROM card_sources cs JOIN sources s ON s.id = cs.source_id AND s.user_id = cs.user_id
          WHERE s.source_type = 'text' AND cs.char_start IS NOT NULL AND cs.char_end IS NOT NULL
            AND substring(s.content_text FROM cs.char_start + 1 FOR cs.char_end - cs.char_start) <> cs.excerpt`,
  },
  {
    name: "mode-matches-card-type",
    rule: "Only open-ended cards have a learning mode, and they have a rubric with criteria.",
    severity: "error",
    sql: `SELECT id FROM cards WHERE (card_type = 'open_ended') <> (learning_mode IS NOT NULL)
          OR (card_type = 'open_ended' AND status = 'approved' AND (rubric IS NULL OR jsonb_array_length(COALESCE(rubric->'criteria', '[]'::jsonb)) = 0))`,
  },
  {
    name: "multiple-choice-index-valid",
    rule: "A multiple-choice card's correct index points at one of its choices, and the answer is that choice.",
    severity: "error",
    sql: `SELECT id FROM cards WHERE card_type = 'multiple_choice' AND (
            jsonb_typeof(answer_spec->'choices') <> 'array'
            OR (answer_spec->>'correctIndex')::int >= jsonb_array_length(answer_spec->'choices')
            OR (answer_spec->>'correctIndex')::int < 0
            OR answer_spec->'choices'->>((answer_spec->>'correctIndex')::int) <> answer)`,
  },
  {
    name: "responses-never-ambiguous",
    rule: "Ambiguous or not-evaluated results are never recorded as answers.",
    severity: "error",
    sql: "SELECT id FROM study_responses WHERE verdict IN ('ambiguous', 'not_evaluated')",
  },
  {
    name: "response-revision-not-in-future",
    rule: "A response never records a card revision newer than the card's current revision.",
    severity: "error",
    sql: "SELECT r.id FROM study_responses r JOIN cards c ON c.id = r.card_id AND c.user_id = r.user_id WHERE r.card_revision > c.revision",
  },
  {
    name: "ai-responses-have-ledger-entry",
    rule: "Every AI-judged response has a succeeded row in the evaluation ledger for the same session.",
    severity: "error",
    sql: `SELECT r.id FROM study_responses r WHERE r.eval_method = 'ai'
          AND NOT EXISTS (SELECT 1 FROM ai_evaluations e WHERE e.session_id = r.session_id AND e.user_id = r.user_id
                          AND e.status = 'succeeded' AND e.verdict = r.verdict)`,
  },
  {
    name: "ai-responses-name-their-model",
    rule: "AI-judged responses record the model and prompt version that judged them.",
    severity: "error",
    sql: "SELECT id FROM study_responses WHERE eval_method = 'ai' AND (evaluator_metadata->>'model' IS NULL OR evaluator_metadata->>'promptVersion' IS NULL)",
  },
  {
    name: "review-state-has-evidence",
    rule: "A card has schedule state only if it has at least one recorded response.",
    severity: "error",
    sql: "SELECT rs.card_id AS id FROM card_review_state rs WHERE NOT EXISTS (SELECT 1 FROM study_responses r WHERE r.card_id = rs.card_id AND r.user_id = rs.user_id)",
  },
  {
    name: "review-state-matches-last-response",
    rule: "The schedule's last verdict equals the most recent response's verdict.",
    severity: "error",
    sql: `SELECT rs.card_id AS id FROM card_review_state rs
          JOIN LATERAL (SELECT verdict FROM study_responses r WHERE r.card_id = rs.card_id AND r.user_id = rs.user_id
                        ORDER BY r.responded_at DESC, r.id DESC LIMIT 1) last ON true
          WHERE last.verdict <> rs.last_verdict`,
  },
  {
    name: "completed-sessions-fully-answered",
    rule: "A completed session has every item answered; an active session is never fully answered.",
    severity: "error",
    sql: `SELECT s.id FROM study_sessions s
          WHERE (s.status = 'completed' AND EXISTS (SELECT 1 FROM study_session_items i WHERE i.session_id = s.id
                    AND NOT EXISTS (SELECT 1 FROM study_responses r WHERE r.session_id = i.session_id AND r.card_id = i.card_id)))
             OR (s.status = 'active' AND EXISTS (SELECT 1 FROM study_session_items i WHERE i.session_id = s.id)
                    AND NOT EXISTS (SELECT 1 FROM study_session_items i WHERE i.session_id = s.id
                        AND NOT EXISTS (SELECT 1 FROM study_responses r WHERE r.session_id = i.session_id AND r.card_id = i.card_id)))`,
  },
  {
    name: "session-items-fit-mode",
    rule: "Non-hybrid sessions only contain cards that mode studies (Recall: not open-ended; written modes: their own learning mode).",
    severity: "error",
    sql: `SELECT i.id FROM study_session_items i JOIN study_sessions s ON s.id = i.session_id JOIN cards c ON c.id = i.card_id
          WHERE (s.mode = 'recall' AND c.card_type = 'open_ended')
             OR (s.mode IN ('explain', 'connections', 'apply') AND (c.card_type <> 'open_ended' OR c.learning_mode <> s.mode))`,
  },
  {
    name: "deck-positions-contiguous",
    rule: "Cards in a deck are numbered 0..n-1 without gaps or repeats.",
    severity: "error",
    sql: `SELECT deck_id AS id FROM deck_cards GROUP BY deck_id
          HAVING min(position) <> 0 OR max(position) <> count(*) - 1 OR count(DISTINCT position) <> count(*)`,
  },
  {
    name: "stuck-generation-jobs",
    rule: "No generation job has been 'running' for over 10 minutes (the server may have stopped mid-request).",
    severity: "warning",
    sql: "SELECT id FROM generation_jobs WHERE status = 'running' AND created_at < now() - interval '10 minutes'",
  },
  {
    name: "stuck-ai-evaluations",
    rule: "No AI evaluation attempt has been 'pending' for over 10 minutes.",
    severity: "warning",
    sql: "SELECT id FROM ai_evaluations WHERE status = 'pending' AND created_at < now() - interval '10 minutes'",
  },
];

export interface IntegrityResult {
  name: string;
  rule: string;
  severity: "error" | "warning";
  violations: number;
  sample: string[];
}

export async function runIntegrityChecks(db: Queryable): Promise<IntegrityResult[]> {
  const results: IntegrityResult[] = [];
  for (const check of CHECKS) {
    const rows = await db.query<{ id: string }>(check.sql);
    results.push({ name: check.name, rule: check.rule, severity: check.severity, violations: rows.rows.length, sample: rows.rows.slice(0, 5).map((r) => String(r.id)) });
  }
  return results;
}
