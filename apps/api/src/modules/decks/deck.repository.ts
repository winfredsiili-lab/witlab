import type { DeckSummary } from "@witlab/contracts";
import type { Queryable } from "../../db/types.js";

const SUMMARY_COLUMNS = `d.id, d.title, d.description, d.created_at, d.updated_at,
  (SELECT count(*)::int FROM deck_cards dc WHERE dc.deck_id = d.id) AS card_count`;

interface DeckRow {
  id: string;
  title: string;
  description: string | null;
  card_count: number;
  created_at: Date;
  updated_at: Date;
}

function toSummary(row: DeckRow): DeckSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    cardCount: row.card_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function insertDeck(
  db: Queryable,
  userId: string,
  input: { title: string; description: string | null },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    "INSERT INTO decks (user_id, title, description) VALUES ($1, $2, $3) RETURNING id",
    [userId, input.title, input.description],
  );
  return result.rows[0]!.id;
}

export async function listDecks(
  db: Queryable,
  userId: string,
  page: { limit: number; offset: number },
): Promise<{ items: DeckSummary[]; total: number }> {
  const [rows, count] = await Promise.all([
    db.query<DeckRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM decks d
       WHERE d.user_id = $1
       ORDER BY d.updated_at DESC, d.id
       LIMIT $2 OFFSET $3`,
      [userId, page.limit, page.offset],
    ),
    db.query<{ total: number }>("SELECT count(*)::int AS total FROM decks WHERE user_id = $1", [userId]),
  ]);
  return { items: rows.rows.map(toSummary), total: count.rows[0]!.total };
}

export async function findDeck(db: Queryable, userId: string, id: string): Promise<DeckSummary | null> {
  const result = await db.query<DeckRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM decks d WHERE d.id = $1 AND d.user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ? toSummary(result.rows[0]) : null;
}

/** Locks the deck row until the transaction ends so membership changes to one deck are serialised. */
export async function lockDeck(db: Queryable, userId: string, id: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM decks WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, userId]);
  return result.rows.length > 0;
}

export async function updateDeck(
  db: Queryable,
  userId: string,
  id: string,
  fields: { title: string; description: string | null },
): Promise<boolean> {
  const result = await db.query(
    "UPDATE decks SET title = $3, description = $4, updated_at = now() WHERE id = $1 AND user_id = $2",
    [id, userId, fields.title, fields.description],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function touchDeck(db: Queryable, userId: string, id: string): Promise<void> {
  await db.query("UPDATE decks SET updated_at = now() WHERE id = $1 AND user_id = $2", [id, userId]);
}

/** Deleting a deck removes only its membership rows. The cards themselves are kept. */
export async function deleteDeck(db: Queryable, userId: string, id: string): Promise<boolean> {
  const result = await db.query("DELETE FROM decks WHERE id = $1 AND user_id = $2", [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

/** Appends a card at the end of the deck. Returns false if it was already in the deck. */
export async function appendCard(db: Queryable, userId: string, deckId: string, cardId: string): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO deck_cards (deck_id, card_id, user_id, position)
     VALUES ($1, $2, $3, COALESCE((SELECT max(position) + 1 FROM deck_cards WHERE deck_id = $1), 0))
     ON CONFLICT (deck_id, card_id) DO NOTHING`,
    [deckId, cardId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function removeCard(db: Queryable, userId: string, deckId: string, cardId: string): Promise<boolean> {
  const result = await db.query("DELETE FROM deck_cards WHERE deck_id = $1 AND card_id = $2 AND user_id = $3", [
    deckId,
    cardId,
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export async function listCardIdsInOrder(db: Queryable, userId: string, deckId: string): Promise<string[]> {
  const result = await db.query<{ card_id: string }>(
    "SELECT card_id FROM deck_cards WHERE deck_id = $1 AND user_id = $2 ORDER BY position, added_at, card_id",
    [deckId, userId],
  );
  return result.rows.map((r) => r.card_id);
}

export async function setPositions(db: Queryable, userId: string, deckId: string, orderedCardIds: string[]): Promise<void> {
  await db.query(
    `UPDATE deck_cards dc
     SET position = v.pos
     FROM unnest($3::uuid[], $4::int[]) AS v(card_id, pos)
     WHERE dc.deck_id = $1 AND dc.user_id = $2 AND dc.card_id = v.card_id`,
    [deckId, userId, orderedCardIds, orderedCardIds.map((_, index) => index)],
  );
}
