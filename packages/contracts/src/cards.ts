import { z } from "zod";
import { idSchema, listQuerySchema, pageSchema, timestampSchema } from "./common.js";

export const cardStatusSchema = z.enum(["draft", "approved", "rejected"]);
export const cardOriginSchema = z.enum(["manual", "ai_generated", "ai_reviewed", "ai_auto_added"]);
/** The FORM of the task. Not the study mode, and not the review schedule. */
export const cardTypeSchema = z.enum(["term_definition", "short_answer", "multiple_choice", "numeric", "open_ended"]);

/** The learning mode a written-answer (open_ended) card is for. Other card types are studied in Recall and have no mode. */
export const learningModeSchema = z.enum(["explain", "connections", "apply"]);
export type LearningMode = z.infer<typeof learningModeSchema>;

export type CardStatus = z.infer<typeof cardStatusSchema>;
export type CardOrigin = z.infer<typeof cardOriginSchema>;
export type CardType = z.infer<typeof cardTypeSchema>;

// ---------------------------------------------------------------------------
// Per-type answer data
// ---------------------------------------------------------------------------

const shortText = z.string().trim().min(1).max(500);

const shortAnswerSpecSchema = z.object({ acceptedAnswers: z.array(shortText).min(1).max(20) }).strict();

const multipleChoiceSpecSchema = z
  .object({
    choices: z.array(shortText).min(2).max(8),
    correctIndex: z.number().int().min(0),
  })
  .strict();

const numericSpecSchema = z
  .object({
    value: z.number().finite(),
    tolerance: z.number().finite().min(0),
  })
  .strict();

const rubricSchema = z.object({ criteria: z.array(shortText).min(1).max(10) }).strict();

type Json = Record<string, unknown>;

interface ContentShape {
  cardType: CardType;
  learningMode?: LearningMode | null;
  answer: string;
  answerSpec?: Json | null;
  rubric?: Json | null;
}

/**
 * Validates the type-specific parts of a card and returns them normalised (trimmed, unknown keys rejected).
 * Used for creating cards and for re-validating a card after an edit, so the rules live in exactly one place.
 */
function normaliseCardContent<T extends ContentShape>(value: T, ctx: z.RefinementCtx): T {
  let ok = true;
  const fail = (path: (string | number)[], message: string) => {
    ok = false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  const forward = (root: string, error: z.ZodError) => {
    for (const issue of error.issues) {
      ok = false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [root, ...issue.path], message: issue.message });
    }
  };

  let answerSpec: Json | null = value.answerSpec ?? null;
  let rubric: Json | null = value.rubric ?? null;
  let learningMode: LearningMode | null = value.learningMode ?? null;
  if (value.cardType === "open_ended") learningMode = learningMode ?? "explain";
  else if (learningMode !== null) fail(["learningMode"], "Only open_ended cards have a learning mode; other card types are studied in Recall.");

  switch (value.cardType) {
    case "term_definition":
    case "open_ended":
      if (answerSpec !== null) fail(["answerSpec"], `${value.cardType} cards do not take an answerSpec.`);
      break;

    case "short_answer":
      if (answerSpec !== null) {
        const parsed = shortAnswerSpecSchema.safeParse(answerSpec);
        if (parsed.success) answerSpec = parsed.data;
        else forward("answerSpec", parsed.error);
      }
      break;

    case "multiple_choice": {
      if (answerSpec === null) {
        fail(["answerSpec"], "multiple_choice cards require answerSpec with choices and correctIndex.");
        break;
      }
      const parsed = multipleChoiceSpecSchema.safeParse(answerSpec);
      if (!parsed.success) {
        forward("answerSpec", parsed.error);
        break;
      }
      const { choices, correctIndex } = parsed.data;
      if (correctIndex >= choices.length) {
        fail(["answerSpec", "correctIndex"], "correctIndex must point at one of the choices.");
      } else if (value.answer !== choices[correctIndex]) {
        fail(["answer"], "For multiple_choice cards, answer must equal the correct choice text.");
      }
      if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) {
        fail(["answerSpec", "choices"], "Choices must be distinct.");
      }
      answerSpec = parsed.data;
      break;
    }

    case "numeric": {
      if (answerSpec === null) {
        fail(["answerSpec"], "numeric cards require answerSpec with value and tolerance.");
        break;
      }
      const parsed = numericSpecSchema.safeParse(answerSpec);
      if (parsed.success) answerSpec = parsed.data;
      else forward("answerSpec", parsed.error);
      break;
    }
  }

  if (rubric !== null) {
    if (value.cardType !== "open_ended") {
      fail(["rubric"], "Only open_ended cards take a rubric.");
    } else {
      const parsed = rubricSchema.safeParse(rubric);
      if (parsed.success) rubric = parsed.data;
      else forward("rubric", parsed.error);
    }
  }

  if (!ok) return z.NEVER;
  return { ...value, answerSpec, rubric, learningMode };
}

/** The part of a card that is evaluated. Re-validated whenever any of it changes. */
export const cardContentSchema = z
  .object({
    cardType: cardTypeSchema,
    answer: z.string(),
    answerSpec: z.record(z.unknown()).nullable().optional(),
    rubric: z.record(z.unknown()).nullable().optional(),
  })
  .transform(normaliseCardContent);

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const sourceRefInputSchema = z
  .object({
    sourceId: idSchema,
    excerpt: z.string().trim().min(1).max(2000),
    pageStart: z.number().int().min(1).optional(),
    pageEnd: z.number().int().min(1).optional(),
    charStart: z.number().int().min(0).optional(),
    charEnd: z.number().int().min(0).optional(),
  })
  .refine((r) => r.pageStart === undefined || r.pageEnd === undefined || r.pageEnd >= r.pageStart, {
    message: "pageEnd must not be before pageStart.",
    path: ["pageEnd"],
  })
  .refine((r) => r.charStart === undefined || r.charEnd === undefined || r.charEnd >= r.charStart, {
    message: "charEnd must not be before charStart.",
    path: ["charEnd"],
  });

export const sourceRefSchema = z.object({
  id: idSchema,
  /** Null once the source has been deleted; the title and excerpt are kept so provenance stays readable. */
  sourceId: idSchema.nullable(),
  sourceTitle: z.string(),
  excerpt: z.string(),
  pageStart: z.number().int().nullable(),
  pageEnd: z.number().int().nullable(),
  charStart: z.number().int().nullable(),
  charEnd: z.number().int().nullable(),
  createdAt: timestampSchema,
});

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

const cardFieldsSchema = z.object({
  cardType: cardTypeSchema,
  /** open_ended only. Defaults to "explain". */
  learningMode: learningModeSchema.nullable().optional(),
  prompt: z.string().trim().min(1).max(2000),
  answer: z.string().trim().min(1).max(4000),
  explanation: z.string().trim().max(4000).nullable().optional(),
  answerSpec: z.record(z.unknown()).nullable().optional(),
  rubric: z.record(z.unknown()).nullable().optional(),
  sourceRefs: z.array(sourceRefInputSchema).max(10).optional(),
}).strict();

/**
 * Cards created through the API are manual cards. AI-generated drafts are created only by the
 * generation service (Batch 4), never from a client request.
 */
export const createCardSchema = cardFieldsSchema.transform(normaliseCardContent);

export const updateCardSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000).optional(),
    answer: z.string().trim().min(1).max(4000).optional(),
    explanation: z.string().trim().max(4000).nullable().optional(),
    answerSpec: z.record(z.unknown()).nullable().optional(),
    rubric: z.record(z.unknown()).nullable().optional(),
    /** Written-answer cards only: which study mode judges this card. */
    learningMode: learningModeSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), "Provide at least one field to update.");

export const listCardsQuerySchema = listQuerySchema.extend({
  status: cardStatusSchema.optional(),
  origin: cardOriginSchema.optional(),
  /** Only cards that quote this source. */
  sourceId: idSchema.optional(),
});

/** Optional body of `POST /api/cards/:id/approve`: approve and add to a deck in one step. */
export const approveCardSchema = z.object({ deckId: idSchema.optional() }).strict();

/** Approve or reject several drafts at once. All-or-nothing: if any card cannot be changed, none is. */
export const bulkReviewSchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    cardIds: z.array(idSchema).min(1).max(100),
    /** Approve only: also add every approved card to this deck. */
    deckId: idSchema.optional(),
  })
  .strict()
  .refine((b) => new Set(b.cardIds).size === b.cardIds.length, { message: "cardIds must not repeat.", path: ["cardIds"] })
  .refine((b) => b.deckId === undefined || b.action === "approve", {
    message: "deckId can only be used when approving.",
    path: ["deckId"],
  });

export const cardSchema = z.object({
  id: idSchema,
  status: cardStatusSchema,
  origin: cardOriginSchema,
  cardType: cardTypeSchema,
  /** Set for open_ended cards only. */
  learningMode: learningModeSchema.nullable(),
  prompt: z.string(),
  answer: z.string(),
  explanation: z.string().nullable(),
  answerSpec: z.record(z.unknown()).nullable(),
  rubric: z.record(z.unknown()).nullable(),
  /** Increases when the evaluated content (prompt, answer, answerSpec, rubric) of an approved card changes. */
  revision: z.number().int().min(1),
  approvedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  sourceRefs: z.array(sourceRefSchema),
});

export const cardPageSchema = pageSchema(cardSchema);

/** Library list items also say which decks a card is in. A card in no deck can never be studied. */
export const cardListItemSchema = cardSchema.extend({ decks: z.array(z.object({ id: idSchema, title: z.string() })) });
export const cardListPageSchema = pageSchema(cardListItemSchema);
export type CardListItem = z.infer<typeof cardListItemSchema>;
export type CardListPage = z.infer<typeof cardListPageSchema>;

export const bulkReviewResultSchema = z.object({
  action: z.enum(["approve", "reject"]),
  cards: z.array(cardSchema),
  addedToDeckId: idSchema.nullable(),
});

export type SourceRefInput = z.infer<typeof sourceRefInputSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
export type ListCardsQuery = z.infer<typeof listCardsQuerySchema>;
export type Card = z.infer<typeof cardSchema>;
export type CardPage = z.infer<typeof cardPageSchema>;
export type ApproveCardInput = z.infer<typeof approveCardSchema>;
export type BulkReviewInput = z.infer<typeof bulkReviewSchema>;
export type BulkReviewResult = z.infer<typeof bulkReviewResultSchema>;
