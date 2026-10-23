import { Router } from "express";
import type pg from "pg";
import { updateMeSchema, type Me } from "@witlab/contracts";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getUserId } from "../../middleware/auth.js";
import { notFoundError } from "../../middleware/errorHandler.js";
import { parseWith } from "../../validators/parse.js";

interface Row {
  id: string;
  email: string;
  display_name: string | null;
  session_size: number | null;
  ask_confidence: boolean | null;
}

export function createMeRouter(pool: pg.Pool, ai: { configured: boolean; dailyLimit: number; evaluationDailyLimit: number }): Router {
  const router = Router();

  async function load(userId: string): Promise<Me> {
    const result = await pool.query<Row>(
      `SELECT u.id, u.email, u.display_name, p.session_size, p.ask_confidence
         FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw notFoundError("User");
    const used = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM generation_jobs WHERE user_id = $1 AND created_at > now() - interval '24 hours'",
      [userId],
    );
    const evals = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai_evaluations WHERE user_id = $1 AND created_at > now() - interval '24 hours'",
      [userId],
    );
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      preferences: { sessionSize: row.session_size ?? 20, askConfidence: row.ask_confidence ?? true },
      aiUsage: { configured: ai.configured, usedToday: used.rows[0]!.n, dailyLimit: ai.dailyLimit, evaluationsUsedToday: evals.rows[0]!.n, evaluationDailyLimit: ai.evaluationDailyLimit },
    };
  }

  /** A complete copy of the signed-in user's own data, for backup or moving elsewhere. Never includes password hashes or sessions. */
  router.get(
    "/export",
    asyncHandler(async (req, res) => {
      const userId = getUserId(req);
      const q = async (sql: string) => (await pool.query(sql, [userId])).rows;
      const [profile, sources, decks, cards, deckCards, responses] = await Promise.all([
        q("SELECT email, display_name, created_at FROM users WHERE id = $1"),
        q("SELECT id, title, source_type, original_filename, content_text, created_at FROM sources WHERE user_id = $1 ORDER BY created_at"),
        q("SELECT id, title, description, created_at FROM decks WHERE user_id = $1 ORDER BY created_at"),
        q("SELECT id, card_type, learning_mode, status, origin, prompt, answer, answer_spec, rubric, explanation, revision, created_at FROM cards WHERE user_id = $1 ORDER BY created_at"),
        q("SELECT deck_id, card_id FROM deck_cards WHERE user_id = $1"),
        q("SELECT card_id, card_revision, submitted_answer, verdict, eval_method, feedback, confidence, responded_at FROM study_responses WHERE user_id = $1 ORDER BY responded_at"),
      ]);
      res.setHeader("Content-Disposition", `attachment; filename="witlab-export-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json({ exportedAt: new Date().toISOString(), format: "witlab-export-v1", profile: profile[0] ?? null, sources, decks, cards, deckCards, studyResponses: responses });
    }),
  );

  router.get("/", asyncHandler(async (req, res) => {
    res.json(await load(getUserId(req)));
  }));

  router.patch(
    "/",
    asyncHandler(async (req, res) => {
      const userId = getUserId(req);
      const patch = parseWith(updateMeSchema, req.body);
      if (patch.displayName !== undefined) {
        await pool.query("UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1", [userId, patch.displayName]);
      }
      if (patch.sessionSize !== undefined || patch.askConfidence !== undefined) {
        await pool.query(
          `INSERT INTO user_preferences (user_id, session_size, ask_confidence)
           VALUES ($1, COALESCE($2, 20), COALESCE($3, true))
           ON CONFLICT (user_id) DO UPDATE SET
             session_size = COALESCE($2, user_preferences.session_size),
             ask_confidence = COALESCE($3, user_preferences.ask_confidence),
             updated_at = now()`,
          [userId, patch.sessionSize ?? null, patch.askConfidence ?? null],
        );
      }
      res.json(await load(userId));
    }),
  );

  return router;
}
