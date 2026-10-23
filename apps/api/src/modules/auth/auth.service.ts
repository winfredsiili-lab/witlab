import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { AuthUser, ChangePasswordInput, LoginInput, RegisterInput } from "@witlab/contracts";
import { withTransaction } from "../../db/types.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from "./password.js";
import { createThrottle, type Throttle } from "./throttle.js";

export interface AuthOptions {
  sessionDays: number;
  allowRegistration: boolean;
  /** Development only: let someone register an email that already has data but no password (an account made before sign-in existed). */
  allowClaimLegacyAccounts: boolean;
  /** Test hooks. */
  loginThrottle?: Throttle;
  now?: () => Date;
}

export const SESSION_COOKIE = "witlab_session";

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string | null;
}
const toUser = (r: UserRow): AuthUser => ({ id: r.id, email: r.email, displayName: r.display_name });

function badCredentials(): HttpError {
  return new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
}

export function createAuthService(pool: pg.Pool, options: AuthOptions) {
  const now = options.now ?? (() => new Date());
  const loginThrottle = options.loginThrottle ?? createThrottle({ max: 5, windowMs: 15 * 60_000 });

  async function startSession(db: pg.Pool | pg.PoolClient, userId: string, userAgent: string | null): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + options.sessionDays * 86_400_000);
    await db.query("INSERT INTO auth_sessions (user_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4)", [
      userId,
      hashToken(token),
      expiresAt,
      userAgent?.slice(0, 300) ?? null,
    ]);
    return { token, expiresAt };
  }

  return {
    async register(input: RegisterInput, userAgent: string | null): Promise<{ user: AuthUser; token: string; expiresAt: Date }> {
      if (!options.allowRegistration) throw new HttpError(403, "registration_closed", "New accounts are not being accepted on this server.");
      const problem = passwordProblem(input.password, input.email);
      if (problem) throw new HttpError(400, "weak_password", problem);
      const passwordHash = await hashPassword(input.password);

      return withTransaction(pool, async (tx) => {
        const existing = await tx.query<UserRow>("SELECT id, email, display_name, password_hash FROM users WHERE lower(email) = lower($1) FOR UPDATE", [input.email]);
        let row = existing.rows[0];
        if (row) {
          if (row.password_hash !== null || !options.allowClaimLegacyAccounts) {
            throw new HttpError(409, "email_in_use", "An account with this email already exists. Try signing in.");
          }
          const claimed = await tx.query<UserRow>(
            "UPDATE users SET password_hash = $2, password_changed_at = now(), display_name = COALESCE($3, display_name), updated_at = now() WHERE id = $1 RETURNING id, email, display_name, password_hash",
            [row.id, passwordHash, input.displayName ?? null],
          );
          row = claimed.rows[0]!;
        } else {
          const created = await tx.query<UserRow>(
            "INSERT INTO users (email, display_name, password_hash, password_changed_at) VALUES ($1, $2, $3, now()) RETURNING id, email, display_name, password_hash",
            [input.email, input.displayName ?? null, passwordHash],
          );
          row = created.rows[0]!;
        }
        const session = await startSession(tx, row.id, userAgent);
        return { user: toUser(row), ...session };
      });
    },

    async login(input: LoginInput, clientKey: string, userAgent: string | null): Promise<{ user: AuthUser; token: string; expiresAt: Date }> {
      const key = `${clientKey}|${input.email}`;
      const wait = loginThrottle.retryAfter(key);
      if (wait > 0) {
        throw new HttpError(429, "too_many_attempts", `Too many failed sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""}.`);
      }
      const found = await pool.query<UserRow>("SELECT id, email, display_name, password_hash FROM users WHERE lower(email) = lower($1)", [input.email]);
      const row = found.rows[0];
      // Always do one hash comparison, so timing does not reveal whether the account exists.
      const ok = await verifyPassword(input.password, row?.password_hash ?? (await dummyHash()));
      if (!row || !row.password_hash || !ok) {
        loginThrottle.fail(key);
        throw badCredentials();
      }
      loginThrottle.succeed(key);
      const session = await startSession(pool, row.id, userAgent);
      return { user: toUser(row), ...session };
    },

    async logout(token: string | null): Promise<void> {
      if (token) await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [hashToken(token)]);
    },

    async logoutEverywhere(userId: string): Promise<void> {
      await pool.query("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);
    },

    async session(userId: string): Promise<AuthUser | null> {
      const r = await pool.query<UserRow>("SELECT id, email, display_name, password_hash FROM users WHERE id = $1", [userId]);
      return r.rows[0] ? toUser(r.rows[0]) : null;
    },

    /** Changes the password and signs out every OTHER device; the current session stays. */
    async changePassword(userId: string, currentToken: string | null, input: ChangePasswordInput): Promise<void> {
      const key = `pw|${userId}`;
      const wait = loginThrottle.retryAfter(key);
      if (wait > 0) throw new HttpError(429, "too_many_attempts", "Too many failed attempts. Try again later.");
      const r = await pool.query<UserRow>("SELECT id, email, display_name, password_hash FROM users WHERE id = $1", [userId]);
      const row = r.rows[0];
      if (!row) throw new HttpError(404, "not_found", "User not found.");
      if (!row.password_hash || !(await verifyPassword(input.currentPassword, row.password_hash))) {
        loginThrottle.fail(key);
        throw new HttpError(403, "wrong_password", "The current password is not correct.");
      }
      loginThrottle.succeed(key);
      const problem = passwordProblem(input.newPassword, row.email);
      if (problem) throw new HttpError(400, "weak_password", problem);
      const hash = await hashPassword(input.newPassword);
      await withTransaction(pool, async (tx) => {
        await tx.query("UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1", [userId, hash]);
        await tx.query("DELETE FROM auth_sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)", [userId, currentToken ? hashToken(currentToken) : null]);
      });
    },

    /** Deletes the account and everything it owns (foreign keys cascade). Requires the password. */
    async deleteAccount(userId: string, password: string): Promise<void> {
      const key = `pw|${userId}`;
      if (loginThrottle.retryAfter(key) > 0) throw new HttpError(429, "too_many_attempts", "Too many failed attempts. Try again later.");
      const r = await pool.query<UserRow>("SELECT id, email, display_name, password_hash FROM users WHERE id = $1", [userId]);
      const row = r.rows[0];
      if (!row) throw new HttpError(404, "not_found", "User not found.");
      if (!row.password_hash || !(await verifyPassword(password, row.password_hash))) {
        loginThrottle.fail(key);
        throw new HttpError(403, "wrong_password", "The password is not correct. Nothing was deleted.");
      }
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    },

    /** Removes sessions that have expired. Safe to call any time. */
    async purgeExpired(): Promise<number> {
      const r = await pool.query("DELETE FROM auth_sessions WHERE expires_at < now()");
      return r.rowCount ?? 0;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
