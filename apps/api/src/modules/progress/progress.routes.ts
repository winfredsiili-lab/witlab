import { Router } from "express";
import type pg from "pg";
import { progressQuerySchema } from "@witlab/contracts";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getUserId } from "../../middleware/auth.js";
import { notFoundError } from "../../middleware/errorHandler.js";
import { parseWith } from "../../validators/parse.js";
import * as decks from "../decks/deck.repository.js";
import { getProgress } from "./progress.repository.js";

export function createProgressRouter(pool: pg.Pool, now: () => Date): Router {
  const router = Router();
  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const { deckId } = parseWith(progressQuerySchema, req.query);
      const userId = getUserId(req);
      if (deckId !== undefined && !(await decks.findDeck(pool, userId, deckId))) throw notFoundError("Deck");
      res.json(await getProgress(pool, userId, deckId ?? null, now()));
    }),
  );
  return router;
}
