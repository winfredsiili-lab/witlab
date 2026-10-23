import { z } from "zod";
import { cardSchema } from "./cards.js";
import { idSchema, pageSchema, timestampSchema } from "./common.js";

export const createDeckSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
}).strict();

export const updateDeckSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), "Provide at least one field to update.");

export const addCardToDeckSchema = z.object({ cardId: idSchema }).strict();

/** Full ordering: must list exactly the cards currently in the deck, each once. */
export const reorderDeckSchema = z.object({ cardIds: z.array(idSchema).max(5000) }).strict();

export const deckSummarySchema = z.object({
  id: idSchema,
  title: z.string(),
  description: z.string().nullable(),
  cardCount: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const deckDetailSchema = deckSummarySchema.extend({
  /** Approved cards only, in deck order. */
  cards: z.array(cardSchema),
});

export const deckPageSchema = pageSchema(deckSummarySchema);

export type CreateDeckInput = z.infer<typeof createDeckSchema>;
export type UpdateDeckInput = z.infer<typeof updateDeckSchema>;
export type DeckSummary = z.infer<typeof deckSummarySchema>;
export type DeckDetail = z.infer<typeof deckDetailSchema>;
export type DeckPage = z.infer<typeof deckPageSchema>;
