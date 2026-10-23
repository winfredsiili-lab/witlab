import type { ErrorRequestHandler, RequestHandler } from "express";
import type { ApiError } from "@witlab/contracts";

export interface ErrorIssue {
  path: string;
  message: string;
}

/** Error with an HTTP status and a stable machine-readable code. Throw this from services and routes. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues?: ErrorIssue[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Use for "does not exist OR belongs to someone else". The two cases are deliberately indistinguishable
 * so an attacker cannot discover which ids exist in other accounts.
 */
export function notFoundError(what: string): HttpError {
  return new HttpError(404, "not_found", `${what} not found.`);
}

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiError = {
    error: { code: "not_found", message: `No route for ${req.method} ${req.path}` },
  };
  res.status(404).json(body);
};

function send(res: Parameters<ErrorRequestHandler>[2], status: number, error: ApiError["error"]): void {
  const body: ApiError = { error };
  res.status(status).json(body);
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    send(res, err.status, {
      code: err.code,
      message: err.message,
      ...(err.issues ? { issues: err.issues } : {}),
    });
    return;
  }

  // body-parser errors: malformed JSON or oversized body.
  const bodyErrorType = (err as { type?: unknown } | null)?.type;
  if (bodyErrorType === "entity.parse.failed") {
    send(res, 400, { code: "invalid_json", message: "Request body is not valid JSON." });
    return;
  }
  if (bodyErrorType === "entity.too.large") {
    send(res, 413, { code: "payload_too_large", message: "Request body is too large." });
    return;
  }

  // Database constraint violations that slipped past service-level checks. The database is the last line
  // of defence for invariants (approval, ownership), so report them as conflicts rather than crashing.
  const pgCode = (err as { code?: unknown } | null)?.code;
  if (pgCode === "23514" || pgCode === "23503" || pgCode === "23505") {
    console.error("Database constraint violation:", (err as Error).message);
    send(res, 409, { code: "constraint_violation", message: "The request conflicts with a data integrity rule." });
    return;
  }

  // Unknown error: log it, but do not leak internals to the client.
  console.error("Unhandled error:", err);
  send(res, 500, { code: "internal_error", message: "Something went wrong on the server." });
};
