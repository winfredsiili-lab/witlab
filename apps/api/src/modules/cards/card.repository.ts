import type { Card, CardOrigin, CardStatus, CardType, LearningMode, SourceRef } from "@witlab/contracts";
import type { Queryable } from "../../db/types.js";

type Json = Record<string, unknown>;

const CARD_COLUMNS = `c.id, c.status, c.origin, c.card_type, c.learning_mode, c.prompt, c.answer, c.answer_spec, c.rubric,
  c.explanation, c.revision, c.approved_at, c.created_at, c.updated_at`;

interface CardRow {
  id: string;
  status: CardStatus;
  origin: CardOrigin;
  card_type: CardType;
  learning_mode: LearningMode | null;
  prompt: string;
  answer: string;
  answer_spec: Json | null;
  rubric: Json | null;
  explanation: string | null;
  revision: number;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SourceRefRow {
  id: string;
  card_id: string;
  source_id: string | null;
  source_title: string;
  excerpt: string;
  page_start: number | null;
  page_end: number | null;
  char_start: number | null;
  char_end: number | null;
  created_at: Date;
}

/** jsonb parameters are always sent as JSON text, because node-postgres would turn arrays into SQL arrays. */
const json = (value: Json | null): string | null => (value === null ? null : JSON.stringify(value));

async function loadSourceRefs(db: Queryable, userId: string, cardIds: string[]): Promise<Map<string, SourceRef[]>> {
  const byCard = new Map<string, SourceRef[]>();
  if (cardIds.length === 0) return byCard;
  const result = await db.query<SourceRefRow>(
    `SELECT id, card_id, source_id, source_title, excerpt, page_start, page_end, char_start, char_end, created_at
     FROM card_sources
     WHERE user_id = $1 AND card_id = ANY($2::uuid[])
     ORDER BY created_at, id`,
    [userId, cardIds],
  );
  for (const row of result.rows) {
    const ref: SourceRef = {
      id: row.id,
      sourceId: row.source_id,
      sourceTitle: row.source_title,
      excerpt: row.excerpt,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      charStart: row.char_start,
      charEnd: row.char_end,
      createdAt: row.created_at.toISOString(),
    };
    const list = byCard.get(row.card_id);
    if (list) list.push(ref);
    else byCard.set(row.card_id, [ref]);
  }
  return byCard;
}

async function hydrate(db: Queryable, userId: string, rows: CardRow[]): Promise<Card[]> {
  const refs = await loadSourceRefs(
    db,
    userId,
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    origin: row.origin,
    cardType: row.card_type,
    learningMode: row.learning_mode,
    prompt: row.prompt,
    answer: row.answer,
    explanation: row.explanation,
    answerSpec: row.answer_spec,
    rubric: row.rubric,
    revision: row.revision,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sourceRefs: refs.get(row.id) ?? [],
  }));
}

export interface NewCard {
  status: CardStatus;
  origin: CardOrigin;
  cardType: CardType;
  learningMode?: LearningMode | null;
  prompt: string;
  answer: string;
  explanation: string | null;
  answerSpec: Json | null;
  rubric: Json | null;
}

export async function insertCard(db: Queryable, userId: string, card: NewCard): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO cards (user_id, status, origin, card_type, learning_mode, prompt, answer, answer_spec, rubric, explanation, approved_at)
     VALUES ($1, $2::text, $3, $4, $10, $5, $6, $7::jsonb, $8::jsonb, $9,
             CASE WHEN $2::text = 'approved' THEN now() ELSE NULL END)
     RETURNING id`,
    [
      userId,
      card.status,
      card.origin,
      card.cardType,
      card.prompt,
      card.answer,
      json(card.answerSpec),
      json(card.rubric),
      card.explanation,
      card.learningMode ?? null,
    ],
  );
  return result.rows[0]!.id;
}

export interface NewSourceRef {
  sourceId: string;
  sourceTitle: string;
  excerpt: string;
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number | null;
  charEnd: number | null;
}

export async function insertSourceRefs(
  db: Queryable,
  userId: string,
  cardId: string,
  refs: NewSourceRef[],
): Promise<void> {
  for (const ref of refs) {
    await db.query(
      `INSERT INTO card_sources
         (card_id, user_id, source_id, source_title, excerpt, page_start, page_end, char_start, char_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        cardId,
        userId,
        ref.sourceId,
        ref.sourceTitle,
        ref.excerpt,
        ref.pageStart,
        ref.pageEnd,
        ref.charStart,
        ref.charEnd,
      ],
    );
  }
}

export async function findCard(db: Queryable, userId: string, id: string): Promise<Card | null> {
  const result = await db.query<CardRow>(`SELECT ${CARD_COLUMNS} FROM cards c WHERE c.id = $1 AND c.user_id = $2`, [
    id,
    userId,
  ]);
  if (result.rows.length === 0) return null;
  return (await hydrate(db, userId, result.rows))[0]!;
}

export interface LockedCard {
  id: string;
  status: CardStatus;
  cardType: CardType;
  learningMode: LearningMode | null;
  prompt: string;
  answer: string;
  answerSpec: Json | null;
  rubric: Json | null;
  explanation: string | null;
  revision: number;
}

/** Reads a card the user owns and locks the row until the transaction ends, so concurrent edits cannot interleave. */
export async function lockCard(db: Queryable, userId: string, id: string): Promise<LockedCard | null> {
  const result = await db.query<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM cards c WHERE c.id = $1 AND c.user_id = $2 FOR UPDATE`,
    [id, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    cardType: row.card_type,
    learningMode: row.learning_mode,
    prompt: row.prompt,
    answer: row.answer,
    answerSpec: row.answer_spec,
    rubric: row.rubric,
    explanation: row.explanation,
    revision: row.revision,
  };
}

/** Status of a card the user owns, locked FOR SHARE so it cannot change while we add it to a deck. */
export async function lockCardStatusShared(db: Queryable, userId: string, id: string): Promise<CardStatus | null> {
  const result = await db.query<{ status: CardStatus }>(
    "SELECT status FROM cards WHERE id = $1 AND user_id = $2 FOR SHARE",
    [id, userId],
  );
  return result.rows[0]?.status ?? null;
}

export async function listCards(
  db: Queryable,
  userId: string,
  query: { status?: CardStatus; origin?: CardOrigin; sourceId?: string; limit: number; offset: number },
): Promise<{ items: Array<Card & { decks: Array<{ id: string; title: string }> }>; total: number }> {
  const status = query.status ?? null;
  const origin = query.origin ?? null;
  const sourceId = query.sourceId ?? null;
  const filter = `c.user_id = $1 AND ($2::text IS NULL OR c.status = $2::text)
       AND ($3::text IS NULL OR c.origin = $3::text)
       AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM card_sources cs WHERE cs.card_id = c.id AND cs.source_id = $4::uuid))`;
  const [rows, count] = await Promise.all([
    db.query<CardRow>(
      `SELECT ${CARD_COLUMNS} FROM cards c
       WHERE ${filter}
       ORDER BY c.created_at DESC, c.id
       LIMIT $5 OFFSET $6`,
      [userId, status, origin, sourceId, query.limit, query.offset],
    ),
    db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM cards c WHERE ${filter}`,
      [userId, status, origin, sourceId],
    ),
  ]);
  const items = await hydrate(db, userId, rows.rows);
  const membership = await db.query<{ card_id: string; deck_id: string; title: string }>(
    `SELECT dc.card_id, d.id AS deck_id, d.title FROM deck_cards dc
       JOIN decks d ON d.id = dc.deck_id AND d.user_id = dc.user_id
      WHERE dc.user_id = $1 AND dc.card_id = ANY($2::uuid[]) ORDER BY d.title, d.id`,
    [userId, items.map((c) => c.id)],
  );
  const byCard = new Map<string, Array<{ id: string; title: string }>>();
  for (const m of membership.rows) byCard.set(m.card_id, [...(byCard.get(m.card_id) ?? []), { id: m.deck_id, title: m.title }]);
  return { items: items.map((c) => ({ ...c, decks: byCard.get(c.id) ?? [] })), total: count.rows[0]!.total };
}

export async function listCardsInDeck(db: Queryable, userId: string, deckId: string): Promise<Card[]> {
  const result = await db.query<CardRow>(
    `SELECT ${CARD_COLUMNS}
     FROM deck_cards dc
     JOIN cards c ON c.id = dc.card_id AND c.user_id = dc.user_id
     WHERE dc.deck_id = $2 AND dc.user_id = $1
     ORDER BY dc.position, dc.added_at, c.id`,
    [userId, deckId],
  );
  return hydrate(db, userId, result.rows);
}

export async function updateCardContent(
  db: Queryable,
  userId: string,
  id: string,
  fields: {
    prompt: string;
    answer: string;
    answerSpec: Json | null;
    rubric: Json | null;
    explanation: string | null;
    learningMode: LearningMode | null;
    revision: number;
  },
): Promise<void> {
  await db.query(
    `UPDATE cards
     SET prompt = $3, answer = $4, answer_spec = $5::jsonb, rubric = $6::jsonb,
         explanation = $7, revision = $8, learning_mode = $9, updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [id, userId, fields.prompt, fields.answer, json(fields.answerSpec), json(fields.rubric), fields.explanation, fields.revision, fields.learningMode],
  );
}

export async function setCardStatus(
  db: Queryable,
  userId: string,
  id: string,
  status: "approved" | "rejected",
): Promise<void> {
  await db.query(
    `UPDATE cards
     SET status = $3::text,
         approved_at = CASE WHEN $3::text = 'approved' THEN now() ELSE NULL END,
         updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [id, userId, status],
  );
}

export async function deleteCard(db: Queryable, userId: string, id: string): Promise<boolean> {
  const result = await db.query("DELETE FROM cards WHERE id = $1 AND user_id = $2", [id, userId]);
  return (result.rowCount ?? 0) > 0;
}
