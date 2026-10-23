import type pg from "pg";
import type {
  ListSessionsQuery,
  Overview,
  SessionDetail,
  SessionSummary,
  StartSessionInput,
  StudyMode,
  SubmitOutcome,
  SubmitResponseInput,
  SubmitResult,
} from "@witlab/contracts";
import { AiProviderError, aiHttpStatus, type AiProvider } from "../ai/provider.js";
import { EVAL_PROMPT_VERSION, evaluateWrittenAnswer } from "../evaluation/aiEvaluator.js";
import * as aiEval from "../evaluation/aiEvaluation.repository.js";
import { withTransaction } from "../../db/types.js";
import { HttpError, notFoundError } from "../../middleware/errorHandler.js";
import { evaluate, SubmissionError } from "../evaluation/evaluator.js";
import { explainDue, schedule } from "../scheduling/scheduler.js";
import * as decks from "../decks/deck.repository.js";
import * as study from "./study.repository.js";

export interface StudyServiceOptions {
  /** Injectable so tests control time. Defaults to the real clock. */
  now?: () => Date;
  /** Judges written answers. Null: Explain, Connections and Apply answer 503 ai_not_configured; Recall is unaffected. */
  provider?: AiProvider | null;
  evaluationLimits?: { perUserPerDay: number; globalPerDay: number };
}

const MODE_NAMES: Record<string, string> = { recall: "Recall", explain: "Explain", connections: "Connections", apply: "Apply", hybrid: "Hybrid" };

function notConfigured(): HttpError {
  return new HttpError(503, "ai_not_configured", "Written-answer study needs an AI key, and none is configured on this server. Recall mode still works.");
}

export function createStudyService(pool: pg.Pool, options: StudyServiceOptions = {}) {
  const now = options.now ?? (() => new Date());
  const provider = options.provider ?? null;
  const evaluationLimits = options.evaluationLimits ?? { perUserPerDay: 60, globalPerDay: 300 };

  async function requireDetail(db: pg.Pool | pg.PoolClient, userId: string, sessionId: string): Promise<SessionDetail> {
    const detail = await study.loadSessionDetail(db, userId, sessionId);
    if (!detail) throw notFoundError("Study session");
    return detail;
  }

  return {
    /** How much is due and new, for one deck or across everything practised. */
    async overview(userId: string, deckId?: string, mode: StudyMode = "recall"): Promise<Overview> {
      if (deckId !== undefined && !(await decks.findDeck(pool, userId, deckId))) throw notFoundError("Deck");
      return study.getOverview(pool, userId, deckId ?? null, now(), mode);
    },

    /**
     * Starts a session in the given mode. The queue (due cards first, then new ones for a deck) is snapshotted so the session
     * is stable and resumable. Answers `409 nothing_to_study` when there is nothing to do.
     */
    async start(userId: string, input: StartSessionInput): Promise<SessionDetail> {
      if (input.mode !== "recall" && !provider) throw notConfigured();
      return withTransaction(pool, async (tx) => {
        const deckId = input.deckId ?? null;
        if (deckId !== null && !(await decks.findDeck(tx, userId, deckId))) throw notFoundError("Deck");

        const at = now();
        const prefs = await tx.query<{ session_size: number }>("SELECT session_size FROM user_preferences WHERE user_id = $1", [userId]);
        const limit = input.limit ?? prefs.rows[0]?.session_size ?? 20;
        const queue =
          input.mode === "hybrid"
            ? await study.findHybridQueue(tx, userId, deckId, at, limit)
            : await study.findQueue(tx, userId, deckId, at, limit, input.mode);

        if (queue.length === 0) {
          const overview = await study.getOverview(tx, userId, deckId, at, input.mode);
          const when = overview.nextDueAt ? ` The next review is due at ${overview.nextDueAt}.` : "";
          const what =
            deckId !== null && overview.eligibleCount === 0
              ? `This deck has no approved cards that can be studied in ${MODE_NAMES[input.mode] ?? input.mode} mode.`
              : "Nothing is due for review right now.";
          throw new HttpError(409, "nothing_to_study", `${what}${when}`);
        }

        const sessionId = await study.insertSession(tx, userId, deckId, input.mode);
        await study.insertItems(
          tx,
          userId,
          sessionId,
          queue.map((card) => ({ cardId: card.cardId, reason: explainDue(card.state, at) })),
        );
        return requireDetail(tx, userId, sessionId);
      });
    },

    get(userId: string, sessionId: string): Promise<SessionDetail> {
      return requireDetail(pool, userId, sessionId);
    },

    list(userId: string, query: ListSessionsQuery): Promise<{ items: SessionSummary[] }> {
      return study.listSessions(pool, userId, query).then((items) => ({ items }));
    },

    /**
     * Evaluates and records one answer, updates the card's review schedule, and completes the session when
     * the last card is answered. All of it happens in one transaction: either everything is saved or nothing is.
     */
    async submit(userId: string, sessionId: string, input: SubmitResponseInput): Promise<SubmitOutcome> {
      const where = await study.findSessionCard(pool, userId, sessionId, input.cardId);
      if (where?.cardType === "open_ended") return submitWritten(userId, sessionId, input);
      return submitDirect(userId, sessionId, input);
    },

    async end(userId: string, sessionId: string): Promise<SessionDetail> {
      return endSession(userId, sessionId);
    },
  };

  /** Recall cards: the server (or the learner's own grade) decides, all inside one transaction. */
  async function submitDirect(userId: string, sessionId: string, input: SubmitResponseInput): Promise<SubmitResult> {
      return withTransaction(pool, async (tx) => {
        const session = await study.lockSession(tx, userId, sessionId);
        if (!session) throw notFoundError("Study session");
        if (session.status !== "active") {
          throw new HttpError(409, "session_not_active", `This session has ${session.status === "completed" ? "completed" : "ended"}.`);
        }
        if (!(await study.sessionItemExists(tx, userId, sessionId, input.cardId))) {
          throw notFoundError("Card in this session");
        }
        if (await study.responseExists(tx, sessionId, input.cardId)) {
          throw new HttpError(409, "already_answered", "This card has already been answered in this session.");
        }

        const card = await study.lockCardForStudy(tx, userId, input.cardId);
        if (!card) throw notFoundError("Card in this session");

        // The server decides correctness, using the card as it is now. The client only supplies the answer.
        let evaluation;
        try {
          evaluation = evaluate(
            { cardType: card.cardType, answer: card.answer, answerSpec: card.answerSpec },
            { answer: input.answer, selectedIndex: input.selectedIndex, selfGrade: input.selfGrade },
          );
        } catch (err) {
          if (err instanceof SubmissionError) throw new HttpError(400, "invalid_answer", err.message);
          throw err;
        }

        // One clock for the evidence log and the schedule, so they can never disagree.
        const at = now();
        await study.insertResponse(tx, userId, {
          respondedAt: at,
          sessionId,
          cardId: card.id,
          cardRevision: card.revision,
          submittedAnswer: evaluation.submittedAnswer,
          verdict: evaluation.verdict,
          evalMethod: evaluation.method,
          feedback: evaluation.feedback,
          // Stored as evidence only. It is not passed to the evaluator or the scheduler.
          confidence: input.confidence ?? null,
          metadata: evaluation.metadata,
        });

        const previous = await study.lockReviewState(tx, userId, card.id);
        const next = schedule(previous, evaluation.verdict, at);
        await study.upsertReviewState(tx, userId, card.id, next);

        if ((await study.countUnanswered(tx, userId, sessionId)) === 0) {
          await study.setSessionStatus(tx, userId, sessionId, "completed");
        }

        return {
          result: {
            cardId: card.id,
            verdict: evaluation.verdict,
            evalMethod: evaluation.method,
            feedback: evaluation.feedback,
            correctAnswer: card.answer,
            explanation: card.explanation,
          },
          nextReview: {
            dueAt: next.dueAt.toISOString(),
            intervalDays: next.intervalDays,
            reason:
              next.lastVerdict === "incorrect"
                ? "Answered incorrectly: it will come back for another try in about 10 minutes."
                : `Scheduled again in ${next.intervalDays} day${next.intervalDays === 1 ? "" : "s"}.`,
          },
          session: await requireDetail(tx, userId, sessionId),
        };
      });
  }

  /**
   * Written answers (open_ended cards). The AI call happens OUTSIDE any database transaction. Nothing is recorded
   * unless the AI returned a usable verdict: a failure, an unusable reply or an "ambiguous" result leaves the card
   * unanswered and the learner's text with them, so they can retry. The verdict is never guessed.
   */
  async function submitWritten(userId: string, sessionId: string, input: SubmitResponseInput): Promise<SubmitOutcome> {
    if (!provider) throw notConfigured();
    if (input.selectedIndex !== undefined || input.selfGrade !== undefined) {
      throw new HttpError(400, "invalid_answer", "Written-answer cards only accept a written answer.");
    }
    const answer = (input.answer ?? "").trim();
    if (!answer) throw new HttpError(400, "invalid_answer", "Write an answer first. An empty answer cannot be judged.");

    // Cheap checks without holding locks, so a doomed request never spends AI quota.
    const where = await study.findSessionCard(pool, userId, sessionId, input.cardId);
    if (!where) throw notFoundError("Card in this session");
    if (where.sessionStatus !== "active") {
      throw new HttpError(409, "session_not_active", `This session has ${where.sessionStatus === "completed" ? "completed" : "ended"}.`);
    }
    if (where.answered) throw new HttpError(409, "already_answered", "This card has already been answered in this session.");
    const card = await study.lockCardForStudy(pool, userId, input.cardId);
    if (!card || card.learningMode === null) throw notFoundError("Card in this session");
    const excerpts = await study.findCardExcerpts(pool, userId, card.id);
    const criteria = Array.isArray((card.rubric as { criteria?: unknown } | null)?.criteria)
      ? ((card.rubric as { criteria: string[] }).criteria)
      : [];

    // Reserve an attempt (and enforce the daily limits) atomically.
    const attemptId = await withTransaction(pool, async (tx) => {
      await aiEval.lockEvaluations(tx);
      const check = await aiEval.checkLimits(tx, userId, evaluationLimits);
      if (check === "user_limit") {
        throw new HttpError(429, "evaluation_limit_reached", `You have reached today's limit of ${evaluationLimits.perUserPerDay} AI-judged answers. Your answer was not recorded. The limit resets on a rolling 24-hour basis.`);
      }
      if (check === "global_limit") {
        throw new HttpError(429, "evaluation_capacity_reached", "The shared AI allowance for today is used up. Your answer was not recorded; try again later.");
      }
      return aiEval.reserveAttempt(tx, userId, { cardId: card.id, sessionId, model: provider.model });
    });

    let evaluation;
    try {
      evaluation = await evaluateWrittenAnswer(provider, {
        mode: card.learningMode,
        prompt: card.prompt,
        modelAnswer: card.answer,
        criteria,
        excerpts,
        learnerAnswer: answer,
      });
    } catch (err) {
      const code = err instanceof AiProviderError ? err.code : "internal_error";
      await aiEval.finishAttempt(pool, attemptId, { status: "failed", errorCode: code }).catch(() => undefined);
      if (err instanceof AiProviderError) {
        throw new HttpError(aiHttpStatus(err.code), err.code, `${err.message} Your answer was not recorded, so you can try again.`);
      }
      throw err;
    }

    if (evaluation.verdict === "ambiguous") {
      await aiEval.finishAttempt(pool, attemptId, { status: "succeeded", verdict: "ambiguous" });
      return { needsClarification: true as const, feedback: evaluation.feedback };
    }
    const verdict = evaluation.verdict;

    try {
      return await withTransaction(pool, async (tx) => {
        const session = await study.lockSession(tx, userId, sessionId);
        if (!session) throw notFoundError("Study session");
        if (session.status !== "active") {
          throw new HttpError(409, "session_not_active", `This session has ${session.status === "completed" ? "completed" : "ended"}.`);
        }
        if (await study.responseExists(tx, sessionId, card.id)) {
          throw new HttpError(409, "already_answered", "This card has already been answered in this session.");
        }
        const current = await study.lockCardForStudy(tx, userId, card.id);
        if (!current) throw notFoundError("Card in this session");
        if (current.revision !== card.revision) {
          throw new HttpError(409, "card_changed", "This card was edited while your answer was being judged, so the result was discarded. Nothing was recorded; answer it again.");
        }

        const at = now();
        await study.insertResponse(tx, userId, {
          respondedAt: at,
          sessionId,
          cardId: card.id,
          cardRevision: card.revision,
          submittedAnswer: answer,
          verdict,
          evalMethod: "ai",
          feedback: evaluation.feedback,
          confidence: input.confidence ?? null,
          metadata: { model: provider.model, promptVersion: EVAL_PROMPT_VERSION, mode: card.learningMode, parts: evaluation.parts },
        });
        const previous = await study.lockReviewState(tx, userId, card.id);
        const next = schedule(previous, verdict, at);
        await study.upsertReviewState(tx, userId, card.id, next);
        await aiEval.finishAttempt(tx, attemptId, { status: "succeeded", verdict });
        if ((await study.countUnanswered(tx, userId, sessionId)) === 0) {
          await study.setSessionStatus(tx, userId, sessionId, "completed");
        }
        return {
          result: {
            cardId: card.id,
            verdict,
            evalMethod: "ai" as const,
            feedback: evaluation.feedback,
            correctAnswer: card.answer,
            explanation: card.explanation,
          },
          nextReview: {
            dueAt: next.dueAt.toISOString(),
            intervalDays: next.intervalDays,
            reason:
              next.lastVerdict === "incorrect"
                ? "Judged incorrect: it will come back for another try in about 10 minutes."
                : `Scheduled again in ${next.intervalDays} day${next.intervalDays === 1 ? "" : "s"}.`,
          },
          session: await requireDetail(tx, userId, sessionId),
        };
      });
    } catch (err) {
      await aiEval.finishAttempt(pool, attemptId, { status: "failed", errorCode: err instanceof HttpError ? err.code : "internal_error" }).catch(() => undefined);
      throw err;
    }
  }

  /** Ends a session early. It is `completed` if every card was answered, otherwise `abandoned`. Safe to repeat. */
  async function endSession(userId: string, sessionId: string): Promise<SessionDetail> {
    return withTransaction(pool, async (tx) => {
      const session = await study.lockSession(tx, userId, sessionId);
      if (!session) throw notFoundError("Study session");
      if (session.status === "active") {
        const remaining = await study.countUnanswered(tx, userId, sessionId);
        await study.setSessionStatus(tx, userId, sessionId, remaining === 0 ? "completed" : "abandoned");
      }
      return requireDetail(tx, userId, sessionId);
    });
  }
}

export type StudyService = ReturnType<typeof createStudyService>;
