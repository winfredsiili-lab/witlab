import { z } from "zod";
import { idSchema } from "./common.js";

export const preferencesSchema = z.object({
  /** Most cards in one study session when the learner does not choose a size. */
  sessionSize: z.number().int().min(5).max(50),
  /** Whether study screens offer the optional 1 to 5 confidence rating. Confidence is evidence only and never changes a verdict or a schedule. */
  askConfidence: z.boolean(),
});

export const updateMeSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).nullable().optional(),
    sessionSize: preferencesSchema.shape.sessionSize.optional(),
    askConfidence: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), "Provide at least one field to update.");

export const meSchema = z.object({
  id: idSchema,
  email: z.string(),
  displayName: z.string().nullable(),
  preferences: preferencesSchema,
  /** The AI card-generation allowance, so the learner can see what is left. */
  aiUsage: z.object({
    configured: z.boolean(),
    usedToday: z.number().int(),
    dailyLimit: z.number().int(),
    /** AI-judged written answers in the last 24 hours (failed attempts included) and the cap. */
    evaluationsUsedToday: z.number().int(),
    evaluationDailyLimit: z.number().int(),
  }),
});

export type Preferences = z.infer<typeof preferencesSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type Me = z.infer<typeof meSchema>;
