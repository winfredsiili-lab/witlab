import { Router, type Request, type RequestHandler, type Response } from "express";
import type pg from "pg";
import { authSessionSchema, changePasswordSchema, deleteAccountSchema, loginSchema, registerSchema } from "@witlab/contracts";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getUserId, requireUser, type Authenticate } from "../../middleware/auth.js";
import { HttpError, notFoundError } from "../../middleware/errorHandler.js";
import { parseWith } from "../../validators/parse.js";
import { hashToken, SESSION_COOKIE, type AuthService } from "./auth.service.js";

/** Reads one cookie from the Cookie header (no cookie-parser dependency needed). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Authenticates from the session cookie. The token is random and only its hash is stored. Expired sessions never match.
 * `last_seen_at` is refreshed at most every 10 minutes so reads do not become writes.
 */
export function cookieAuthenticate(pool: pg.Pool): Authenticate {
  return async (req) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || token.length < 20 || token.length > 200) return null;
    const r = await pool.query<{ user_id: string; stale: boolean }>(
      "SELECT user_id, last_seen_at < now() - interval '10 minutes' AS stale FROM auth_sessions WHERE token_hash = $1 AND expires_at > now()",
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.stale) await pool.query("UPDATE auth_sessions SET last_seen_at = now() WHERE token_hash = $1", [hashToken(token)]);
    return row.user_id;
  };
}

/**
 * Cookies are sent automatically by the browser, so a page on another site could try to make state-changing requests.
 * SameSite=Lax already blocks most of that; this refuses any write whose Origin header names a site we do not serve.
 * Requests without an Origin header (scripts, curl, tests) are not browser cross-site requests and pass.
 */
export function originGuard(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) return next(new HttpError(403, "bad_origin", "This request came from a site that is not allowed to use the API."));
    next();
  };
}

export function createAuthRouter(
  service: AuthService,
  deps: { authenticate: Authenticate; secureCookies: boolean; sessionDays: number },
): Router {
  const router = Router();
  const auth = requireUser(deps.authenticate);

  const setCookie = (res: Response, token: string, expiresAt: Date) =>
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: deps.secureCookies, path: "/", expires: expiresAt });
  const clearCookie = (res: Response) => res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: deps.secureCookies, path: "/" });
  const agent = (req: Request) => req.header("user-agent") ?? null;

  router.post(
    "/register",
    asyncHandler(async (req, res) => {
      const input = parseWith(registerSchema, req.body);
      const { user, token, expiresAt } = await service.register(input, agent(req));
      setCookie(res, token, expiresAt);
      res.status(201).json({ user });
    }),
  );

  router.post(
    "/login",
    asyncHandler(async (req, res) => {
      const input = parseWith(loginSchema, req.body);
      const { user, token, expiresAt } = await service.login(input, req.ip ?? "unknown", agent(req));
      setCookie(res, token, expiresAt);
      res.json({ user });
    }),
  );

  router.post(
    "/logout",
    asyncHandler(async (req, res) => {
      await service.logout(readCookie(req, SESSION_COOKIE));
      clearCookie(res);
      res.status(204).end();
    }),
  );

  router.get(
    "/session",
    auth,
    asyncHandler(async (req, res) => {
      const user = await service.session(getUserId(req));
      if (!user) throw notFoundError("User");
      res.json(authSessionSchema.parse({ user }));
    }),
  );

  router.post(
    "/password",
    auth,
    asyncHandler(async (req, res) => {
      const input = parseWith(changePasswordSchema, req.body);
      await service.changePassword(getUserId(req), readCookie(req, SESSION_COOKIE), input);
      res.status(204).end();
    }),
  );

  router.post(
    "/logout-all",
    auth,
    asyncHandler(async (req, res) => {
      await service.logoutEverywhere(getUserId(req));
      clearCookie(res);
      res.status(204).end();
    }),
  );

  router.post(
    "/delete-account",
    auth,
    asyncHandler(async (req, res) => {
      const input = parseWith(deleteAccountSchema, req.body);
      await service.deleteAccount(getUserId(req), input.password);
      clearCookie(res);
      res.status(204).end();
    }),
  );

  return router;
}
