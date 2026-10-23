import { z } from "zod";

export const idSchema = z.string().uuid();
/** ISO 8601 timestamp string. */
export const timestampSchema = z.string();

/** Query parameters shared by every list endpoint. */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
  });
}
