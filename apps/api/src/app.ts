import cors from "cors";
import express from "express";
import type pg from "pg";
import type { DatabaseCheck } from "./db/pool.js";
import { requireUser, type Authenticate } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import type { AiProvider } from "./modules/ai/provider.js";
import { createAuthRouter, originGuard } from "./modules/auth/auth.routes.js";
import { createAuthService, type AuthOptions } from "./modules/auth/auth.service.js";
import { createMeRouter } from "./modules/me/me.routes.js";
import { createProgressRouter } from "./modules/progress/progress.routes.js";
import { createCardRouter } from "./modules/cards/card.routes.js";
import { createCardService } from "./modules/cards/card.service.js";
import { createDeckRouter } from "./modules/decks/deck.routes.js";
import { createDeckService } from "./modules/decks/deck.service.js";
import { createGenerationRouter } from "./modules/generation/generation.routes.js";
import { createGenerationService, type GenerationLimits } from "./modules/generation/generation.service.js";
import { createSourceRouter } from "./modules/sources/source.routes.js";
import { createSourceService } from "./modules/sources/source.service.js";
import { createStudyRouter } from "./modules/study/study.routes.js";
import { createStudyService } from "./modules/study/study.service.js";
import { createHealthRouter } from "./routes/health.routes.js";

export interface AppDependencies {
  corsOrigin: string;
  checkDatabase: DatabaseCheck;
  /** Decides who is making each request. Replaced by real authentication later without touching routes. */
  authenticate: Authenticate;
  pool: pg.Pool;
  /** Injectable clock so tests can control time. Defaults to the real clock. */
  now?: () => Date;
  /** AI provider for card generation. Null or absent: generation answers 503 ai_not_configured. */
  aiProvider?: AiProvider | null;
  generationLimits?: GenerationLimits;
  /** Daily caps on AI-judged written answers. */
  evaluationLimits?: GenerationLimits;
  /** Sign-in behaviour. Defaults suit tests and development. */
  auth?: Partial<AuthOptions> & { secureCookies?: boolean };
}

/** Builds the Express app. Dependencies are injected so tests control the database and the acting user. */
export function createApp(deps: AppDependencies): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    // API responses are data for the app only: never sniffed as another type, never framed, never cached or leaked via referrer.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(cors({ origin: deps.corsOrigin, credentials: true }));
  app.use(originGuard([deps.corsOrigin]));
  app.use(express.json({ limit: "2mb" }));

  // Public: health only. Everything else requires an authenticated user.
  app.use("/api/health", createHealthRouter(deps.checkDatabase));

  const auth = requireUser(deps.authenticate);
  const authService = createAuthService(deps.pool, {
    sessionDays: deps.auth?.sessionDays ?? 30,
    allowRegistration: deps.auth?.allowRegistration ?? true,
    allowClaimLegacyAccounts: deps.auth?.allowClaimLegacyAccounts ?? false,
    loginThrottle: deps.auth?.loginThrottle,
    now: deps.now,
  });
  // Public: sign-in. (Its own routes decide which of them need a signed-in user.)
  app.use("/api/auth", createAuthRouter(authService, { authenticate: deps.authenticate, secureCookies: deps.auth?.secureCookies ?? false, sessionDays: deps.auth?.sessionDays ?? 30 }));
  const generation = createGenerationService(deps.pool, {
    provider: deps.aiProvider ?? null,
    limits: deps.generationLimits ?? { perUserPerDay: 20, globalPerDay: 500 },
  });
  app.use("/api/sources", auth, createGenerationRouter(generation));
  app.use("/api/sources", auth, createSourceRouter(createSourceService(deps.pool)));
  app.use("/api/cards", auth, createCardRouter(createCardService(deps.pool)));
  app.use("/api/decks", auth, createDeckRouter(createDeckService(deps.pool)));
  const evaluationLimits = deps.evaluationLimits ?? { perUserPerDay: 60, globalPerDay: 300 };
  const limits = deps.generationLimits ?? { perUserPerDay: 20, globalPerDay: 500 };
  app.use("/api/me", auth, createMeRouter(deps.pool, { configured: Boolean(deps.aiProvider), dailyLimit: limits.perUserPerDay, evaluationDailyLimit: evaluationLimits.perUserPerDay }));
  app.use("/api/progress", auth, createProgressRouter(deps.pool, deps.now ?? (() => new Date())));
  app.use("/api/study", auth, createStudyRouter(createStudyService(deps.pool, { now: deps.now, provider: deps.aiProvider ?? null, evaluationLimits })));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
