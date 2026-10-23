import { Router } from "express";
import { approveCardSchema, bulkReviewSchema, createCardSchema, listCardsQuerySchema, updateCardSchema } from "@witlab/contracts";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getUserId } from "../../middleware/auth.js";
import { parseId, parseWith } from "../../validators/parse.js";
import type { CardService } from "./card.service.js";

export function createCardRouter(service: CardService): Router {
  const router = Router();

  // Cards created through the API are manual cards and are approved on creation.
  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const input = parseWith(createCardSchema, req.body);
      res.status(201).json(await service.create(getUserId(req), input, "manual"));
    }),
  );

  router.post(
    "/bulk",
    asyncHandler(async (req, res) => {
      res.json(await service.bulk(getUserId(req), parseWith(bulkReviewSchema, req.body)));
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const query = parseWith(listCardsQuerySchema, req.query);
      res.json(await service.list(getUserId(req), query));
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      res.json(await service.get(getUserId(req), parseId(req.params.id)));
    }),
  );

  router.patch(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const patch = parseWith(updateCardSchema, req.body);
      res.json(await service.update(getUserId(req), id, patch));
    }),
  );

  router.post(
    "/:id/approve",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const input = parseWith(approveCardSchema, req.body ?? {});
      res.json(await service.approve(getUserId(req), id, input));
    }),
  );

  router.post(
    "/:id/reject",
    asyncHandler(async (req, res) => {
      res.json(await service.reject(getUserId(req), parseId(req.params.id)));
    }),
  );

  router.delete(
    "/:id",
    asyncHandler(async (req, res) => {
      await service.delete(getUserId(req), parseId(req.params.id));
      res.status(204).end();
    }),
  );

  return router;
}
