import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Express 4 does not catch rejected promises from async handlers; this forwards them to the error handler. */
export function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
