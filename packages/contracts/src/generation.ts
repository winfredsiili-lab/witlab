import { z } from "zod";
import { cardSchema } from "./cards.js";
import { idSchema, timestampSchema } from "./common.js";

/**
 * The most source text one generation request reads. Chosen to stay inside the free AI tier's per-minute
 * token limit (see docs/AI_PROVIDER.md). A larger selection is refused, never silently cut.
 */
export const GENERATION_MAX_SCOPE_CHARS = 12_000;
export const GENERATION_MAX_CARDS = 12;
export const GENERATION_DEFAULT_CARDS = 6;

export const generationScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("section"), sectionId: idSchema }),
  /** PDF sources only. */
  z.object({ type: z.literal("pages"), pageStart: z.number().int().min(1), pageEnd: z.number().int().min(1) }),
  /** Text sources only. `charEnd` is exclusive. */
  z.object({ type: z.literal("chars"), charStart: z.number().int().min(0), charEnd: z.number().int().min(1) }),
]);

/**
 * What kind of cards to draft. "recall" makes the quick-check types (flashcards, multiple choice, short and numeric answers).
 * The others make written-answer cards for that study mode: an open question, a model answer and the criteria a good answer meets.
 */
export const generationStyleSchema = z.enum(["recall", "explain", "connections", "apply"]);

export const generateCardsSchema = z.object({
  style: generationStyleSchema.default("recall"),
  scope: generationScopeSchema.default({ type: "all" }),
  maxCards: z.number().int().min(1).max(GENERATION_MAX_CARDS).default(GENERATION_DEFAULT_CARDS),
}).strict();

export const generationJobStatusSchema = z.enum(["running", "succeeded", "failed"]);

export const discardedCandidateSchema = z.object({
  /** The candidate's question, when it had one, so the learner can see what was dropped. */
  prompt: z.string().nullable(),
  reason: z.string(),
});

export const generationJobSchema = z.object({
  id: idSchema,
  sourceId: idSchema.nullable(),
  status: generationJobStatusSchema,
  scope: generationScopeSchema,
  scopeChars: z.number().int(),
  model: z.string(),
  requestedCards: z.number().int(),
  candidatesReturned: z.number().int(),
  draftsCreated: z.number().int(),
  discarded: z.array(discardedCandidateSchema),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});

/** Generated cards are always drafts. They do nothing until a person approves them. */
export const generateCardsResponseSchema = z.object({
  job: generationJobSchema,
  cards: z.array(cardSchema),
});

export type GenerationStyle = z.infer<typeof generationStyleSchema>;
export type GenerationScope = z.infer<typeof generationScopeSchema>;
export type GenerateCardsInput = z.infer<typeof generateCardsSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;
export type GenerateCardsResponse = z.infer<typeof generateCardsResponseSchema>;
