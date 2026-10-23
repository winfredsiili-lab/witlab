import type pg from "pg";
import type {
  CreateDeckInput,
  DeckDetail,
  DeckPage,
  ListQuery,
  UpdateDeckInput,
} from "@witlab/contracts";
import { withTransaction, type Queryable } from "../../db/types.js";
import { HttpError, notFoundError } from "../../middleware/errorHandler.js";
import * as cards from "../cards/card.repository.js";
import * as decks from "./deck.repository.js";

async function loadDetail(db: Queryable, userId: string, deckId: string): Promise<DeckDetail> {
  const summary = await decks.findDeck(db, userId, deckId);
  if (!summary) throw notFoundError("Deck");
  return { ...summary, cards: await cards.listCardsInDeck(db, userId, deckId) };
}

export function createDeckService(pool: pg.Pool) {
  return {
    async create(userId: string, input: CreateDeckInput): Promise<DeckDetail> {
      const id = await decks.insertDeck(pool, userId, {
        title: input.title,
        description: input.description ?? null,
      });
      return loadDetail(pool, userId, id);
    },

    list(userId: string, query: ListQuery): Promise<DeckPage> {
      return decks.listDecks(pool, userId, query);
    },

    get(userId: string, id: string): Promise<DeckDetail> {
      return loadDetail(pool, userId, id);
    },

    async update(userId: string, id: string, patch: UpdateDeckInput): Promise<DeckDetail> {
      return withTransaction(pool, async (tx) => {
        const current = await decks.findDeck(tx, userId, id);
        if (!current) throw notFoundError("Deck");
        await decks.updateDeck(tx, userId, id, {
          title: patch.title ?? current.title,
          description: patch.description !== undefined ? patch.description : current.description,
        });
        return loadDetail(tx, userId, id);
      });
    },

    /** Removes the deck only. Its cards remain in the library. */
    async delete(userId: string, id: string): Promise<void> {
      const deleted = await decks.deleteDeck(pool, userId, id);
      if (!deleted) throw notFoundError("Deck");
    },

    /** Only approved cards may be added. The database enforces this too, but we answer with a clear error first. */
    async addCard(userId: string, deckId: string, cardId: string): Promise<DeckDetail> {
      return withTransaction(pool, async (tx) => {
        if (!(await decks.lockDeck(tx, userId, deckId))) throw notFoundError("Deck");

        const status = await cards.lockCardStatusShared(tx, userId, cardId);
        if (status === null) throw notFoundError("Card");
        if (status !== "approved") {
          throw new HttpError(409, "card_not_approved", `Only approved cards can be added to a deck (this card is ${status}).`);
        }

        const added = await decks.appendCard(tx, userId, deckId, cardId);
        if (!added) throw new HttpError(409, "already_in_deck", "This card is already in the deck.");

        await decks.touchDeck(tx, userId, deckId);
        return loadDetail(tx, userId, deckId);
      });
    },

    async removeCard(userId: string, deckId: string, cardId: string): Promise<DeckDetail> {
      return withTransaction(pool, async (tx) => {
        if (!(await decks.lockDeck(tx, userId, deckId))) throw notFoundError("Deck");
        const removed = await decks.removeCard(tx, userId, deckId, cardId);
        if (!removed) throw notFoundError("Card in this deck");
        await decks.touchDeck(tx, userId, deckId);
        return loadDetail(tx, userId, deckId);
      });
    },

    /** The new order must list exactly the cards currently in the deck, each once. */
    async reorder(userId: string, deckId: string, orderedCardIds: string[]): Promise<DeckDetail> {
      return withTransaction(pool, async (tx) => {
        if (!(await decks.lockDeck(tx, userId, deckId))) throw notFoundError("Deck");

        const current = await decks.listCardIdsInOrder(tx, userId, deckId);
        const sameSet =
          orderedCardIds.length === current.length &&
          new Set(orderedCardIds).size === orderedCardIds.length &&
          orderedCardIds.every((id) => current.includes(id));
        if (!sameSet) {
          throw new HttpError(400, "invalid_order", "cardIds must list every card in the deck exactly once.");
        }

        await decks.setPositions(tx, userId, deckId, orderedCardIds);
        await decks.touchDeck(tx, userId, deckId);
        return loadDetail(tx, userId, deckId);
      });
    },
  };
}

export type DeckService = ReturnType<typeof createDeckService>;
