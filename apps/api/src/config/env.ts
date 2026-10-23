import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(4000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    /** "dev-stub" resolves every request to one seeded development user. Real authentication replaces it later. */
    AUTH_MODE: z.enum(["password", "dev-stub"]).default("password"),
    /** Whether new accounts can be created. Turn off once your own account exists if the server is reachable by others. */
    ALLOW_REGISTRATION: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    DEV_USER_EMAIL: z.string().email().default("dev@witlab.local"),

    // AI provider (any OpenAI-compatible chat-completions endpoint). See docs/AI_PROVIDER.md.
    // Without a key the app works normally and card generation answers 503 ai_not_configured.
    AI_API_KEY: z.string().trim().optional().transform((v) => (v ? v : undefined)),
    AI_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
    AI_MODEL: z.string().trim().min(1).default("openai/gpt-oss-120b"),
    AI_STRICT_SCHEMA: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    /** "off" sends no reasoning parameter (for models that do not accept it). */
    AI_REASONING_EFFORT: z.enum(["low", "medium", "high", "off"]).default("low"),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(45_000),
    GENERATION_DAILY_LIMIT: z.coerce.number().int().min(1).default(20),
    GENERATION_GLOBAL_DAILY_LIMIT: z.coerce.number().int().min(1).default(500),
    /** AI-judged written answers (Explain, Connections, Apply). Failed attempts count too, because they use provider quota. */
    EVALUATION_DAILY_LIMIT: z.coerce.number().int().min(1).default(60),
    EVALUATION_GLOBAL_DAILY_LIMIT: z.coerce.number().int().min(1).default(300),
  })
  .superRefine((env, ctx) => {
    // Without real authentication every request would act as the same user. Never allow that in production.
    if (env.NODE_ENV === "production" && env.AUTH_MODE === "dev-stub") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_MODE"],
        message: "dev-stub authentication is not allowed when NODE_ENV=production.",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validate environment variables. Throws a readable error listing every problem,
 * so a misconfigured server fails at startup instead of at the first request.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

/** Load apps/api/.env (if present) and validate process.env. Used by server.ts and the migrate CLI only. */
export function loadEnv(): Env {
  loadDotenv();
  return parseEnv(process.env);
}
