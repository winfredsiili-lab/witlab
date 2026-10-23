import type { Queryable } from "../../db/types.js";

/** Returns the id of the user with this email, creating the user if needed (case-insensitive match). */
export async function ensureUserByEmail(db: Queryable, email: string, displayName: string | null = null): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT ((lower(email))) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [email, displayName],
  );
  return result.rows[0]!.id;
}
