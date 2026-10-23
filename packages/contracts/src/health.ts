import { z } from "zod";

/** Result of checking one dependency. "error" always carries a message; we never report a fake "ok". */
export const dependencyStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), latencyMs: z.number().nonnegative() }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

export const healthResponseSchema = z.object({
  /** "ok" only when every dependency is ok, otherwise "degraded". */
  status: z.enum(["ok", "degraded"]),
  service: z.literal("witlab-api"),
  timestamp: z.string(),
  database: dependencyStatusSchema,
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
