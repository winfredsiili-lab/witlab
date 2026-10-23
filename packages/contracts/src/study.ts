import { z } from "zod";
import { cardTypeSchema } from "./cards.js";
import { idSchema, timestampSchema } from "./common.js";

/** All study modes. */
export const studyModeSchema = z.enum(["recall", "connections", "explain", "apply", "hybrid"]);
/**
 * Recall studies every card type except open_ended. Explain, Connections and Apply study open_ended cards of that learning
 * mode, with AI feedback. Hybrid runs those four in a fixed order (see HYBRID_PHASES).
 */
export const availableStudyModeSchema = z.enum(["recall", "explain", "connections", "apply", "hybrid"]);
/** The four single modes. A hybrid session moves through them in this order, once: retrieve, explain, relate, apply. */
export const phaseModeSchema = z.enum(["recall", "explain", "connections", "apply"]);
export const HYBRID_PHASES = ["recall", "explain", "connections", "apply"] as const;
export const sessionStatusSchema = z.enum(["active", "completed", "abandoned"]);

/**
 * `ambiguous` is an AI result that asks the learner to clarify: it is never recorded or scheduled. `not_evaluated` is reserved:
 * a failed AI evaluation records nothing at all, so the learner can retry without losing the card.
 */
export const verdictSchema = z.enum(["correct", "partial", "incorrect", "ambiguous", "not_evaluated"]);
export const selfGradeSchema = z.enum(["correct", "partial", "incorrect"]);
export const evalMethodSchema = z.enum(["deterministic", "self_assessed", "ai"]);

export type StudyMode = z.infer<typeof studyModeSchema>;
export type PhaseMode = z.infer<typeof phaseModeSchema>;
export type AvailableStudyMode = z.infer<typeof availableStudyModeSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type SelfGrade = z.infer<typeof selfGradeSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const startSessionSchema = z
  .object({
    /** Omit for a global review of everything that is due. */
    deckId: idSchema.optional(),
    mode: availableStudyModeSchema.default("recall"),
    /** Defaults to the learner's session-size preference (20 unless changed). */
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

/**
 * One answer. Which fields are allowed depends on the card type and is checked on the server:
 * multiple_choice uses selectedIndex; numeric and short_answer use answer; term_definition uses selfGrade
 * (and optionally answer). Confidence is optional supplementary evidence and never affects correctness.
 */
export const submitResponseSchema = z
  .object({
    cardId: idSchema,
    answer: z.string().max(4000).optional(),
    selectedIndex: z.number().int().min(0).max(7).optional(),
    selfGrade: selfGradeSchema.optional(),
    confidence: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export const listSessionsQuerySchema = z.object({
  status: sessionStatusSchema.optional(),
  deckId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const overviewQuerySchema = z.object({ deckId: idSchema.optional(), mode: availableStudyModeSchema.default("recall") });

export type StartSessionInput = z.infer<typeof startSessionSchema>;
export type SubmitResponseInput = z.infer<typeof submitResponseSchema>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The card the learner is currently working on. It never contains the correct answer for automatically evaluated cards. */
export const studyItemSchema = z.object({
  cardId: idSchema,
  position: z.number().int(),
  cardType: cardTypeSchema,
  prompt: z.string(),
  /** Options for multiple_choice cards; null otherwise. The correct index is never sent. */
  choices: z.array(z.string()).nullable(),
  /** "auto": the server checks it. "self": the learner grades themselves after seeing `revealAnswer`. "ai": a written answer judged by AI. */
  evaluation: z.enum(["auto", "self", "ai"]),
  /** The single mode this card is practised in. Equals the session mode, except in a hybrid session where it is the current phase. */
  phase: phaseModeSchema,
  /** Why this card is in the session. */
  reason: z.string(),
  /** The model answer, only for self-assessed cards. */
  revealAnswer: z.string().nullable(),
});

export const progressSchema = z.object({
  total: z.number().int().nonnegative(),
  answered: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  incorrect: z.number().int().nonnegative(),
});

export const resultItemSchema = z.object({
  cardId: idSchema,
  position: z.number().int(),
  cardType: cardTypeSchema,
  prompt: z.string(),
  verdict: verdictSchema,
  evalMethod: evalMethodSchema,
  feedback: z.string(),
  submittedAnswer: z.string().nullable(),
  correctAnswer: z.string(),
  confidence: z.number().int().nullable(),
  respondedAt: timestampSchema,
});

export const sessionDetailSchema = z.object({
  id: idSchema,
  mode: studyModeSchema,
  status: sessionStatusSchema,
  deckId: idSchema.nullable(),
  deckTitle: z.string().nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  progress: progressSchema,
  /** Hybrid sessions only: the fixed sequence of phases with their card counts; null otherwise. */
  phases: z.array(z.object({ mode: phaseModeSchema, total: z.number().int(), answered: z.number().int() })).nullable(),
  /** The next unanswered card, or null when the session has ended or every card is answered. */
  current: studyItemSchema.nullable(),
  /** Answered cards in session order. */
  results: z.array(resultItemSchema),
});

export const sessionSummarySchema = z.object({
  id: idSchema,
  mode: studyModeSchema,
  status: sessionStatusSchema,
  deckId: idSchema.nullable(),
  deckTitle: z.string().nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  total: z.number().int().nonnegative(),
  answered: z.number().int().nonnegative(),
});

export const sessionListSchema = z.object({ items: z.array(sessionSummarySchema) });

export const submitResultSchema = z.object({
  result: z.object({
    cardId: idSchema,
    verdict: verdictSchema,
    evalMethod: evalMethodSchema,
    feedback: z.string(),
    correctAnswer: z.string(),
    explanation: z.string().nullable(),
  }),
  nextReview: z.object({
    dueAt: timestampSchema,
    intervalDays: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  /** The session after this answer, including the next card (if any). */
  session: sessionDetailSchema,
});

/** The AI could not tell whether the answer is right and asks the learner to say more. Nothing is recorded; the card stays unanswered. */
export const clarificationSchema = z.object({
  needsClarification: z.literal(true),
  feedback: z.string(),
});

export const submitOutcomeSchema = z.union([submitResultSchema, clarificationSchema]);

export const overviewSchema = z.object({
  /** Cards whose review is due now. */
  dueCount: z.number().int().nonnegative(),
  /** Cards never practised (deck overview only; 0 for the global overview). */
  newCount: z.number().int().nonnegative(),
  /** Cards that can be studied in the requested mode (approved; open-ended cards of that learning mode, or every other type for Recall). */
  eligibleCount: z.number().int().nonnegative(),
  /** When the next not-yet-due card comes due, if any. */
  nextDueAt: timestampSchema.nullable(),
});

export type StudyItem = z.infer<typeof studyItemSchema>;
export type Progress = z.infer<typeof progressSchema>;
export type ResultItem = z.infer<typeof resultItemSchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SubmitResult = z.infer<typeof submitResultSchema>;
export type SubmitOutcome = z.infer<typeof submitOutcomeSchema>;
export type Clarification = z.infer<typeof clarificationSchema>;
export type Overview = z.infer<typeof overviewSchema>;
