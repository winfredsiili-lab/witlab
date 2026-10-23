import express, { Router } from "express";
import { createSourceSchema, listQuerySchema, pdfUploadQuerySchema, updateSourceSchema } from "@witlab/contracts";
import { HttpError } from "../../middleware/errorHandler.js";
import { PDF_MAX_BYTES } from "./pdf/extractPdf.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getUserId } from "../../middleware/auth.js";
import { parseId, parseWith } from "../../validators/parse.js";
import type { SourceService } from "./source.service.js";

export function createSourceRouter(service: SourceService): Router {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const input = parseWith(createSourceSchema, req.body);
      res.status(201).json(await service.create(getUserId(req), input));
    }),
  );

  // Raw PDF body. Registered before "/:id" routes; only this route accepts a body of this type.
  router.post(
    "/pdf",
    express.raw({ type: "application/pdf", limit: PDF_MAX_BYTES }),
    asyncHandler(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        throw new HttpError(415, "unsupported_media_type", "Send the PDF as the request body with Content-Type: application/pdf.");
      }
      const query = parseWith(pdfUploadQuerySchema, req.query);
      const result = await service.importPdf(getUserId(req), req.body, query);
      res.status(201).json(result);
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

  router.get(
    "/:id/sections",
    asyncHandler(async (req, res) => {
      res.json({ items: await service.sections(getUserId(req), parseId(req.params.id)) });
    }),
  );

  router.get(
    "/:id/pages",
    asyncHandler(async (req, res) => {
      res.json({ items: await service.pages(getUserId(req), parseId(req.params.id)) });
    }),
  );

  router.get(
    "/:id/pages/:pageNumber",
    asyncHandler(async (req, res) => {
      const n = Number(req.params.pageNumber);
      if (!Number.isInteger(n) || n < 1) {
        throw new HttpError(400, "validation_error", "Invalid page number.", [{ path: "pageNumber", message: "must be a positive integer" }]);
      }
      res.json(await service.pageText(getUserId(req), parseId(req.params.id), n));
    }),
  );

  router.patch(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const input = parseWith(updateSourceSchema, req.body);
      res.json(await service.update(getUserId(req), id, input));
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
