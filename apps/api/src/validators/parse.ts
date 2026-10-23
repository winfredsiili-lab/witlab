import type { ZodType, ZodTypeDef } from "zod";
import { idSchema } from "@witlab/contracts";
import { HttpError } from "../middleware/errorHandler.js";

/** Validate untrusted input (body, query, params). Throws a 400 listing every problem. */
export function parseWith<Out, In = Out>(schema: ZodType<Out, ZodTypeDef, In>, data: unknown): Out {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
  throw new HttpError(400, "validation_error", `Invalid request. ${summary}`, issues);
}

/** Validate a path parameter that must be a UUID. */
export function parseId(value: unknown, name = "id"): string {
  const result = idSchema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "validation_error", `Invalid ${name}: must be a UUID.`, [
      { path: name, message: "must be a UUID" },
    ]);
  }
  return result.data;
}
