import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDatabaseCheck, createPool } from "./db/pool.js";
import { devStubAuthenticate } from "./middleware/auth.js";
import { cookieAuthenticate } from "./modules/auth/auth.routes.js";
import { createOpenAiCompatibleProvider } from "./modules/ai/openaiCompatible.js";
import { ensureUserByEmail } from "./modules/users/user.repository.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);

let devUserId = "";
try {
  if (env.AUTH_MODE === "dev-stub") devUserId = await ensureUserByEmail(pool, env.DEV_USER_EMAIL, "Dev User");
  else await pool.query("SELECT 1 FROM auth_sessions LIMIT 1"); // fails with 42P01 if migrations have not been run
} catch (err) {
  const code = (err as { code?: string }).code;
  if (code === "42P01") {
    console.error("The database schema is missing. Run: npm run migrate");
  } else {
    console.error("Could not prepare the development user:", err instanceof Error ? err.message : err);
  }
  await pool.end();
  process.exit(1);
}

const aiProvider = env.AI_API_KEY
  ? createOpenAiCompatibleProvider({
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL,
      model: env.AI_MODEL,
      strictSchema: env.AI_STRICT_SCHEMA,
      reasoningEffort: env.AI_REASONING_EFFORT,
      timeoutMs: env.AI_TIMEOUT_MS,
    })
  : null;

const app = createApp({
  aiProvider,
  generationLimits: { perUserPerDay: env.GENERATION_DAILY_LIMIT, globalPerDay: env.GENERATION_GLOBAL_DAILY_LIMIT },
  evaluationLimits: { perUserPerDay: env.EVALUATION_DAILY_LIMIT, globalPerDay: env.EVALUATION_GLOBAL_DAILY_LIMIT },
  corsOrigin: env.CORS_ORIGIN,
  checkDatabase: createDatabaseCheck(pool),
  authenticate: env.AUTH_MODE === "dev-stub" ? devStubAuthenticate(devUserId) : cookieAuthenticate(pool),
  auth: {
    sessionDays: env.SESSION_DAYS,
    allowRegistration: env.ALLOW_REGISTRATION,
    secureCookies: env.NODE_ENV === "production",
    allowClaimLegacyAccounts: env.NODE_ENV !== "production",
  },
  pool,
});

const server = app.listen(env.PORT, () => {
  console.log(`WitLab API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  console.log(aiProvider ? `AI generation: ${env.AI_MODEL} via ${new URL(env.AI_BASE_URL).host}` : "AI generation: not configured (set AI_API_KEY to enable).");
  if (env.AUTH_MODE === "dev-stub") console.log(`WARNING: AUTH_MODE=dev-stub. All requests act as ${env.DEV_USER_EMAIL}. Development only; there is no sign-in.`);
  else console.log(`Sign-in: email and password${env.ALLOW_REGISTRATION ? " (registration open)" : " (registration closed)"}.`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down.`);
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
