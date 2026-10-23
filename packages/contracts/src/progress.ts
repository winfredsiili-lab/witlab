import { z } from "zod";
import { idSchema, timestampSchema } from "./common.js";

/**
 * Where each studyable card stands, from review evidence only. The four states are mutually exclusive:
 *  - never: in a deck but never practised.
 *  - struggling: the most recent answer was partly right or wrong.
 *  - learning: the most recent answer was right, but fewer than 3 right in a row or the gap is still short.
 *  - established: the last 3 or more reviews in a row were right and the scheduled gap is now at least 14 days.
 * "Established" is evidence of consistent recall so far, not proof of long-term retention.
 */
export const stateCountsSchema = z.object({
  never: z.number().int(),
  struggling: z.number().int(),
  learning: z.number().int(),
  established: z.number().int(),
});

export const learningProgressSchema = z.object({
  deckId: idSchema.nullable(),
  totalCards: z.number().int(),
  states: stateCountsSchema,
  /** The last 14 days (UTC dates), oldest first, including days with no activity. */
  activity: z.array(z.object({ date: z.string(), answered: z.number().int(), correct: z.number().int() })),
  last30Days: z.object({
    answered: z.number().int(),
    correct: z.number().int(),
    partial: z.number().int(),
    incorrect: z.number().int(),
    /** Answers the learner graded themselves (term/definition cards): weaker evidence than automatic checks. */
    selfAssessed: z.number().int(),
    automatic: z.number().int(),
    /** Written answers judged by AI: useful feedback, but a model's judgement is not as firm as an automatic check. */
    aiEvaluated: z.number().int(),
    cardsPracticed: z.number().int(),
  }),
  needsAttention: z.array(
    z.object({
      cardId: idSchema,
      prompt: z.string(),
      lastVerdict: z.enum(["partial", "incorrect"]),
      lapses: z.number().int(),
      dueAt: timestampSchema,
    }),
  ),
  /** Per-deck breakdown, only when no single deck was requested. */
  decks: z.array(z.object({ deckId: idSchema, title: z.string(), totalCards: z.number().int(), states: stateCountsSchema })),
});

export const progressQuerySchema = z.object({ deckId: idSchema.optional() });

export type StateCounts = z.infer<typeof stateCountsSchema>;
export type LearningProgress = z.infer<typeof learningProgressSchema>;
