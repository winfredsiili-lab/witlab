import { Router } from "express";
import {
  addCardToDeckSchema,
  createDeckSchema,
  listQuerySchema,
  reorderDeckSchema,
  updateDeckSchema,
} from "@witlab/contracts";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getUserId } from "../../middleware/auth.js";
import { parseId, parseWith } from "../../validators/parse.js";
import type { DeckService } from "./deck.service.js";

export function createDeckRouter(service: DeckService): Router {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const input = parseWith(createDeckSchema, req.body);
      res.status(201).json(await service.create(getUserId(req), input));
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const query = parseWith(listQuerySchema, req.query);
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
      const patch = parseWith(updateDeckSchema, req.body);
      res.json(await service.update(getUserId(req), id, patch));
    }),
  );

  router.delete(
    "/:id",
    asyncHandler(async (req, res) => {
      await service.delete(getUserId(req), parseId(req.params.id));
      res.status(204).end();
    }),
  );

  router.post(
    "/:id/cards",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const { cardId } = parseWith(addCardToDeckSchema, req.body);
      res.status(201).json(await service.addCard(getUserId(req), id, cardId));
    }),
  );

  router.put(
    "/:id/cards/order",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const { cardIds } = parseWith(reorderDeckSchema, req.body);
      res.json(await service.reorder(getUserId(req), id, cardIds));
    }),
  );

  router.delete(
    "/:id/cards/:cardId",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const cardId = parseId(req.params.cardId, "cardId");
      res.json(await service.removeCard(getUserId(req), id, cardId));
    }),
  );

  return router;
}
