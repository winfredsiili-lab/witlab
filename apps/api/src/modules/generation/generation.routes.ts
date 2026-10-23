import { Router } from "express";
import { generateCardsSchema } from "@witlab/contracts";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getUserId } from "../../middleware/auth.js";
import { parseId, parseWith } from "../../validators/parse.js";
import type { GenerationService } from "./generation.service.js";

/** Mounted under /api/sources, so paths here are /:id/generate and /:id/generations. */
export function createGenerationRouter(service: GenerationService): Router {
  const router = Router();

  router.post(
    "/:id/generate",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const input = parseWith(generateCardsSchema, req.body ?? {});
      res.status(201).json(await service.generate(getUserId(req), id, input));
    }),
  );

  router.get(
    "/:id/generations",
    asyncHandler(async (req, res) => {
      res.json({ items: await service.listJobs(getUserId(req), parseId(req.params.id)) });
    }),
  );

  return router;
}
