import type pg from "pg";
import {
  cardContentSchema,
  type ApproveCardInput,
  type BulkReviewInput,
  type BulkReviewResult,
  type Card,
  type CardListPage,
  type CardOrigin,
  type CreateCardInput,
  type ListCardsQuery,
  type UpdateCardInput,
} from "@witlab/contracts";
import { withTransaction, type Queryable } from "../../db/types.js";
import { HttpError, notFoundError } from "../../middleware/errorHandler.js";
import { parseWith } from "../../validators/parse.js";
import * as decks from "../decks/deck.repository.js";
import * as sources from "../sources/source.repository.js";
import * as cards from "./card.repository.js";

/**
 * Creates a card and its provenance links inside the caller's transaction, so several cards (a generation
 * batch) can be created all-or-nothing.
 *
 * Manual cards are approved immediately (the author wrote them). AI-generated cards ALWAYS start as drafts
 * and must carry at least one source reference. The HTTP card API only exposes the manual path; the generation
 * service is the only caller that passes origin "ai_generated".
 */
export async function createCardInTransaction(
  tx: Queryable,
  userId: string,
  input: CreateCardInput,
  origin: CardOrigin,
): Promise<Card> {
  const refs = input.sourceRefs ?? [];
  if (origin === "ai_generated" && refs.length === 0) {
    throw new HttpError(400, "provenance_required", "AI-generated cards must reference at least one source passage.");
  }

  const titles = await sources.findOwnedSourceTitles(tx, userId, [...new Set(refs.map((r) => r.sourceId))]);
  const missing = refs.find((r) => !titles.has(r.sourceId));
  if (missing) {
    throw new HttpError(400, "unknown_source", `Source ${missing.sourceId} does not exist.`, [
      { path: "sourceRefs", message: "references a source that does not exist" },
    ]);
  }

  const cardId = await cards.insertCard(tx, userId, {
    status: origin === "manual" ? "approved" : "draft",
    origin,
    cardType: input.cardType,
    learningMode: input.learningMode ?? null,
    prompt: input.prompt,
    answer: input.answer,
    explanation: input.explanation ?? null,
    answerSpec: input.answerSpec ?? null,
    rubric: input.rubric ?? null,
  });

  await cards.insertSourceRefs(
    tx,
    userId,
    cardId,
    refs.map((r) => ({
      sourceId: r.sourceId,
      sourceTitle: titles.get(r.sourceId)!,
      excerpt: r.excerpt,
      pageStart: r.pageStart ?? null,
      pageEnd: r.pageEnd ?? null,
      charStart: r.charStart ?? null,
      charEnd: r.charEnd ?? null,
    })),
  );

  return (await cards.findCard(tx, userId, cardId))!;
}

export function createCardService(pool: pg.Pool) {
  /**
   * The single place drafts change state. Lock order is deck first, then cards by id, which matches adding a
   * card to a deck, so concurrent requests cannot deadlock. Any card that is missing, not yours, or not a draft
   * fails the whole request and nothing is changed.
   */
  async function review(
    userId: string,
    action: "approve" | "reject",
    cardIds: string[],
    deckId?: string,
  ): Promise<BulkReviewResult> {
    return withTransaction(pool, async (tx) => {
      if (deckId && !(await decks.lockDeck(tx, userId, deckId))) throw notFoundError("Deck");

      for (const id of [...cardIds].sort()) {
        const current = await cards.lockCard(tx, userId, id);
        if (!current) throw notFoundError("Card");
        if (current.status !== "draft") {
          const verb = action === "approve" ? "approved" : "rejected";
          throw new HttpError(409, "invalid_state", `Only draft cards can be ${verb} (a card in this request is ${current.status}). Nothing was changed.`);
        }
      }

      const target = action === "approve" ? "approved" : "rejected";
      for (const id of cardIds) await cards.setCardStatus(tx, userId, id, target);

      if (deckId) {
        for (const id of cardIds) await decks.appendCard(tx, userId, deckId, id);
        await decks.touchDeck(tx, userId, deckId);
      }

      const result: Card[] = [];
      for (const id of cardIds) result.push((await cards.findCard(tx, userId, id))!);
      return { action, cards: result, addedToDeckId: deckId ?? null };
    });
  }

  return {
    /** Creates one card in its own transaction. See createCardInTransaction. */
    async create(userId: string, input: CreateCardInput, origin: CardOrigin = "manual"): Promise<Card> {
      return withTransaction(pool, (tx) => createCardInTransaction(tx, userId, input, origin));
    },

    list(userId: string, query: ListCardsQuery): Promise<CardListPage> {
      return cards.listCards(pool, userId, query);
    },

    async get(userId: string, id: string): Promise<Card> {
      const card = await cards.findCard(pool, userId, id);
      if (!card) throw notFoundError("Card");
      return card;
    },

    /**
     * Edits a card. Rejected cards are read-only. Changing evaluated content (prompt, answer, answerSpec,
     * rubric) of an approved card increases its revision; the card stays approved and review history is kept.
     */
    async update(userId: string, id: string, patch: UpdateCardInput): Promise<Card> {
      return withTransaction(pool, async (tx) => {
        const current = await cards.lockCard(tx, userId, id);
        if (!current) throw notFoundError("Card");
        if (current.status === "rejected") {
          throw new HttpError(409, "invalid_state", "Rejected cards cannot be edited.");
        }

        const merged = {
          prompt: patch.prompt ?? current.prompt,
          answer: patch.answer ?? current.answer,
          answerSpec: patch.answerSpec !== undefined ? patch.answerSpec : current.answerSpec,
          rubric: patch.rubric !== undefined ? patch.rubric : current.rubric,
          explanation: patch.explanation !== undefined ? patch.explanation : current.explanation,
        };

        // Re-run the type-specific rules on the final result, not just on the changed fields.
        const content = parseWith(cardContentSchema, {
          cardType: current.cardType,
          answer: merged.answer,
          answerSpec: merged.answerSpec,
          rubric: merged.rubric,
        });

        if (patch.learningMode !== undefined && current.cardType !== "open_ended") {
          throw new HttpError(400, "validation_error", "Only written-answer cards have a study mode.");
        }
        const learningMode = patch.learningMode ?? current.learningMode;

        const contentChanged =
          learningMode !== current.learningMode ||
          merged.prompt !== current.prompt ||
          merged.answer !== current.answer ||
          JSON.stringify(content.answerSpec ?? null) !== JSON.stringify(current.answerSpec) ||
          JSON.stringify(content.rubric ?? null) !== JSON.stringify(current.rubric);

        await cards.updateCardContent(tx, userId, id, {
          prompt: merged.prompt,
          answer: merged.answer,
          answerSpec: content.answerSpec ?? null,
          rubric: content.rubric ?? null,
          explanation: merged.explanation,
          learningMode,
          revision: current.status === "approved" && contentChanged ? current.revision + 1 : current.revision,
        });

        return (await cards.findCard(tx, userId, id))!;
      });
    },

    /** draft -> approved, optionally adding the card to a deck in the same transaction. */
    async approve(userId: string, id: string, input: ApproveCardInput = {}): Promise<Card> {
      const result = await review(userId, "approve", [id], input.deckId);
      return result.cards[0]!;
    },

    /** draft -> rejected. Approved cards are never rejected; delete them instead. */
    async reject(userId: string, id: string): Promise<Card> {
      const result = await review(userId, "reject", [id]);
      return result.cards[0]!;
    },

    /** Approve or reject several drafts. All-or-nothing. */
    bulk(userId: string, input: BulkReviewInput): Promise<BulkReviewResult> {
      return review(userId, input.action, input.cardIds, input.deckId);
    },

    async delete(userId: string, id: string): Promise<void> {
      const deleted = await cards.deleteCard(pool, userId, id);
      if (!deleted) throw notFoundError("Card");
    },
  };
}

export type CardService = ReturnType<typeof createCardService>;
