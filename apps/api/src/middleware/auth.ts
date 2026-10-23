import type { Request, RequestHandler } from "express";
import { HttpError } from "./errorHandler.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by requireUser. Services receive this id and never trust a user id from the request body. */
    userId?: string;
  }
}

/** Resolves the acting user for a request, or null when the request is not authenticated. */
export type Authenticate = (req: Request) => Promise<string | null>;

export function requireUser(authenticate: Authenticate): RequestHandler {
  return (req, _res, next) => {
    authenticate(req)
      .then((userId) => {
        if (!userId) throw new HttpError(401, "unauthorized", "Authentication required.");
        req.userId = userId;
        next();
      })
      .catch(next);
  };
}

export function getUserId(req: Request): string {
  if (!req.userId) throw new HttpError(401, "unauthorized", "Authentication required.");
  return req.userId;
}

/**
 * DEVELOPMENT ONLY. Every request acts as one seeded user. This is not authentication and gives no
 * protection between real people; env validation refuses to start in production with it.
 */
export function devStubAuthenticate(userId: string): Authenticate {
  return async () => userId;
}
