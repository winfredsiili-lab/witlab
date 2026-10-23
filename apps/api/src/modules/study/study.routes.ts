import { Router } from "express";
import {
  listSessionsQuerySchema,
  overviewQuerySchema,
  startSessionSchema,
  submitResponseSchema,
} from "@witlab/contracts";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getUserId } from "../../middleware/auth.js";
import { parseId, parseWith } from "../../validators/parse.js";
import type { StudyService } from "./study.service.js";

export function createStudyRouter(service: StudyService): Router {
  const router = Router();

  router.get(
    "/overview",
    asyncHandler(async (req, res) => {
      const { deckId, mode } = parseWith(overviewQuerySchema, req.query);
      res.json(await service.overview(getUserId(req), deckId, mode));
    }),
  );

  router.post(
    "/sessions",
    asyncHandler(async (req, res) => {
      const input = parseWith(startSessionSchema, req.body ?? {});
      res.status(201).json(await service.start(getUserId(req), input));
    }),
  );

  router.get(
    "/sessions",
    asyncHandler(async (req, res) => {
      const query = parseWith(listSessionsQuerySchema, req.query);
      res.json(await service.list(getUserId(req), query));
    }),
  );

  router.get(
    "/sessions/:id",
    asyncHandler(async (req, res) => {
      res.json(await service.get(getUserId(req), parseId(req.params.id)));
    }),
  );

  router.post(
    "/sessions/:id/responses",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const input = parseWith(submitResponseSchema, req.body);
      const outcome = await service.submit(getUserId(req), id, input);
      // A clarification request records nothing, so it is not a "created" response.
      res.status("needsClarification" in outcome ? 200 : 201).json(outcome);
    }),
  );

  router.post(
    "/sessions/:id/end",
    asyncHandler(async (req, res) => {
      res.json(await service.end(getUserId(req), parseId(req.params.id)));
    }),
  );

  return router;
}
