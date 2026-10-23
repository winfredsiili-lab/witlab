import { Router } from "express";
import type { HealthResponse } from "@witlab/contracts";
import type { DatabaseCheck } from "../db/pool.js";

export function createHealthRouter(checkDatabase: DatabaseCheck): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const database = await checkDatabase();
      const body: HealthResponse = {
        status: database.status === "ok" ? "ok" : "degraded",
        service: "witlab-api",
        timestamp: new Date().toISOString(),
        database,
      };
      // 503 when a dependency is down so monitors and the UI can tell the difference.
      res.status(body.status === "ok" ? 200 : 503).json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
