import { z } from "zod";
import {
  bulkReviewResultSchema,
  learningProgressSchema,
  meSchema,
  type UpdateMeInput,
  cardListPageSchema,
  generateCardsResponseSchema,
  generationJobSchema,
  sourceDetailSchema,
  sourceListSchema,
  sourceSectionsSchema,
  sourceSummarySchema,
  importWarningsSchema,
  type GenerationScope,
  cardSchema,
  deckDetailSchema,
  deckPageSchema,
  healthResponseSchema,
  authSessionSchema,
  pdfPagesSchema,
  overviewSchema,
  sessionDetailSchema,
  sessionListSchema,
  submitOutcomeSchema,
  type AvailableStudyMode,
  type GenerationStyle,
  type CardStatus,
  type SubmitResponseInput,
} from "@witlab/contracts";
import { request } from "./apiClient";

/** Typed endpoint functions. Components call these, never fetch directly. */
export const api = {
  // Sign-in
  session: () => request("GET", "/api/auth/session", authSessionSchema),
  register: (body: { email: string; password: string; displayName?: string }) => request("POST", "/api/auth/register", authSessionSchema, { body }),
  login: (body: { email: string; password: string }) => request("POST", "/api/auth/login", authSessionSchema, { body }),
  logout: () => request("POST", "/api/auth/logout", null, { body: {} }),
  logoutEverywhere: () => request("POST", "/api/auth/logout-all", null, { body: {} }),
  changePassword: (body: { currentPassword: string; newPassword: string }) => request("POST", "/api/auth/password", null, { body }),
  deleteAccount: (password: string) => request("POST", "/api/auth/delete-account", null, { body: { password } }),

  health: () => request("GET", "/api/health", healthResponseSchema, { acceptStatuses: [503] }),

  // Decks
  listDecks: () => request("GET", "/api/decks?limit=200", deckPageSchema),
  getDeck: (id: string) => request("GET", `/api/decks/${id}`, deckDetailSchema),
  createDeck: (body: { title: string; description?: string | null }) =>
    request("POST", "/api/decks", deckDetailSchema, { body }),
  deleteDeck: (id: string) => request("DELETE", `/api/decks/${id}`, null),
  addCardToDeck: (deckId: string, cardId: string) =>
    request("POST", `/api/decks/${deckId}/cards`, deckDetailSchema, { body: { cardId } }),
  removeCardFromDeck: (deckId: string, cardId: string) =>
    request("DELETE", `/api/decks/${deckId}/cards/${cardId}`, deckDetailSchema),

  // Cards
  listCards: (status?: CardStatus) =>
    request("GET", `/api/cards?limit=200${status ? `&status=${status}` : ""}`, cardListPageSchema),
  createCard: (body: Record<string, unknown>) => request("POST", "/api/cards", cardSchema, { body }),
  deleteCard: (id: string) => request("DELETE", `/api/cards/${id}`, null),

  listDrafts: (sourceId?: string) =>
    request("GET", `/api/cards?limit=200&status=draft${sourceId ? `&sourceId=${sourceId}` : ""}`, cardListPageSchema),
  updateCard: (id: string, body: Record<string, unknown>) => request("PATCH", `/api/cards/${id}`, cardSchema, { body }),
  bulkReview: (action: "approve" | "reject", cardIds: string[], deckId?: string) =>
    request("POST", "/api/cards/bulk", bulkReviewResultSchema, { body: { action, cardIds, ...(deckId ? { deckId } : {}) } }),
  approveCard: (id: string) => request("POST", `/api/cards/${id}/approve`, cardSchema),
  rejectCard: (id: string) => request("POST", `/api/cards/${id}/reject`, cardSchema),

  // Sources
  listSources: () => request("GET", "/api/sources?limit=200", sourceListSchema),
  getSource: (id: string) => request("GET", `/api/sources/${id}`, sourceDetailSchema),
  createTextSource: (body: { title: string; contentText: string }) =>
    request("POST", "/api/sources", sourceDetailSchema, { body: { ...body, sourceType: "text" } }),
  uploadPdf: (file: File, title: string) =>
    request(
      "POST",
      `/api/sources/pdf?filename=${encodeURIComponent(file.name)}${title.trim() ? `&title=${encodeURIComponent(title.trim())}` : ""}`,
      z.object({ source: sourceSummarySchema, warnings: importWarningsSchema }),
      { raw: { data: file, contentType: "application/pdf" } },
    ),
  sourcePages: (id: string) => request("GET", `/api/sources/${id}/pages`, pdfPagesSchema),
  deleteSource: (id: string) => request("DELETE", `/api/sources/${id}`, null),
  sourceSections: (id: string) => request("GET", `/api/sources/${id}/sections`, sourceSectionsSchema),
  generateCards: (id: string, scope: GenerationScope, maxCards: number, style: GenerationStyle = "recall") =>
    request("POST", `/api/sources/${id}/generate`, generateCardsResponseSchema, { body: { scope, maxCards, style } }),
  generations: (id: string) =>
    request("GET", `/api/sources/${id}/generations`, z.object({ items: z.array(generationJobSchema) })),

  // Profile, preferences, progress
  me: () => request("GET", "/api/me", meSchema),
  updateMe: (body: UpdateMeInput) => request("PATCH", "/api/me", meSchema, { body }),
  progress: (deckId?: string) => request("GET", `/api/progress${deckId ? `?deckId=${deckId}` : ""}`, learningProgressSchema),

  // Study
  overview: (deckId?: string, mode: AvailableStudyMode = "recall") =>
    request("GET", `/api/study/overview?mode=${mode}${deckId ? `&deckId=${deckId}` : ""}`, overviewSchema),
  startSession: (deckId?: string, mode: AvailableStudyMode = "recall") =>
    request("POST", "/api/study/sessions", sessionDetailSchema, { body: { ...(deckId ? { deckId } : {}), mode } }),
  getSession: (id: string) => request("GET", `/api/study/sessions/${id}`, sessionDetailSchema),
  activeSessions: (deckId?: string) =>
    request("GET", `/api/study/sessions?status=active${deckId ? `&deckId=${deckId}` : ""}`, sessionListSchema),
  submitAnswer: (sessionId: string, body: SubmitResponseInput) =>
    request("POST", `/api/study/sessions/${sessionId}/responses`, submitOutcomeSchema, { body }),
  endSession: (id: string) => request("POST", `/api/study/sessions/${id}/end`, sessionDetailSchema),
};
