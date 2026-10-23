import type pg from "pg";
import {
  GENERATION_MAX_SCOPE_CHARS,
  type Card,
  type GenerateCardsInput,
  type GenerateCardsResponse,
  type GenerationJob,
  type GenerationScope,
} from "@witlab/contracts";
import { withTransaction } from "../../db/types.js";
import { HttpError, notFoundError } from "../../middleware/errorHandler.js";
import { AiProviderError, aiHttpStatus, type AiProvider } from "../ai/provider.js";
import { createCardInTransaction } from "../cards/card.service.js";
import * as sources from "../sources/source.repository.js";
import {
  buildCandidate,
  CARDS_JSON_SCHEMA,
  WRITTEN_CARDS_JSON_SCHEMA,
  dropDuplicates,
  envelopeSchema,
  normalisePrompt,
  type Discard,
  type ScopeSegment,
} from "./candidates.js";
import * as repo from "./generation.repository.js";
import { buildSystemPrompt, buildUserPrompt, buildWrittenSystemPrompt, GENERATION_MAX_OUTPUT_TOKENS } from "./prompt.js";

export interface GenerationLimits {
  perUserPerDay: number;
  globalPerDay: number;
}

const MIN_SCOPE_CHARS = 40;

function invalidScope(message: string): HttpError {
  return new HttpError(400, "invalid_scope", message);
}

export function createGenerationService(
  pool: pg.Pool,
  deps: { provider: AiProvider | null; limits: GenerationLimits },
) {
  /** Reads exactly the text the learner selected. Refuses (never truncates) a selection that is too large. */
  async function resolveScope(
    userId: string,
    source: NonNullable<Awaited<ReturnType<typeof sources.findSource>>>,
    scope: GenerationScope,
  ): Promise<{ segments: ScopeSegment[]; chars: number }> {
    let segments: ScopeSegment[];

    if (source.sourceType === "pdf") {
      let from = 1;
      let to = source.pageCount ?? 0;
      if (scope.type === "chars") throw invalidScope("A PDF is selected by pages or sections, not by character positions.");
      if (scope.type === "pages") {
        from = scope.pageStart;
        to = scope.pageEnd;
      } else if (scope.type === "section") {
        const section = await sources.findSection(pool, userId, source.id, scope.sectionId);
        if (!section || section.pageStart === null || section.pageEnd === null) throw invalidScope("That section does not exist in this source.");
        from = section.pageStart;
        to = section.pageEnd;
      }
      if (from < 1 || to < from || to > (source.pageCount ?? 0)) {
        throw invalidScope(`Choose pages between 1 and ${source.pageCount}, with the first page not after the last.`);
      }
      const pages = await sources.findPageRange(pool, userId, source.id, from, to);
      segments = pages.filter((p) => p.content !== "").map((p) => ({ page: p.pageNumber, text: p.content, offset: 0 }));
    } else {
      const full = source.contentText ?? "";
      let start = 0;
      let end = full.length;
      if (scope.type === "pages") throw invalidScope("Pasted text is selected by section or character range, not by pages.");
      if (scope.type === "chars") {
        start = scope.charStart;
        end = scope.charEnd;
      } else if (scope.type === "section") {
        const section = await sources.findSection(pool, userId, source.id, scope.sectionId);
        if (!section || section.charStart === null || section.charEnd === null) throw invalidScope("That section does not exist in this source.");
        start = section.charStart;
        end = section.charEnd;
      }
      if (start < 0 || end <= start || end > full.length) {
        throw invalidScope(`Choose a character range inside the text (0 to ${full.length}).`);
      }
      segments = [{ page: null, text: full.slice(start, end), offset: start }];
    }

    const chars = segments.reduce((n, s) => n + s.text.length, 0);
    if (chars < MIN_SCOPE_CHARS) {
      throw new HttpError(400, "scope_empty", "The selected part has too little readable text to make cards from.");
    }
    if (chars > GENERATION_MAX_SCOPE_CHARS) {
      throw new HttpError(
        400,
        "scope_too_large",
        `The selection has ${chars.toLocaleString("en-US")} characters; one generation reads at most ${GENERATION_MAX_SCOPE_CHARS.toLocaleString("en-US")}. Choose a smaller section or page range.`,
      );
    }
    return { segments, chars };
  }

  return {
    /**
     * Generates DRAFT cards from the selected part of a source. Drafts do nothing until a person approves them.
     * Nothing is created unless the AI answers with usable output, and all drafts are created in one transaction.
     */
    async generate(userId: string, sourceId: string, input: GenerateCardsInput): Promise<GenerateCardsResponse> {
      const source = await sources.findSource(pool, userId, sourceId);
      if (!source) throw notFoundError("Source");
      if (!deps.provider) {
        throw new HttpError(503, "ai_not_configured", "Card generation is not set up on this server (no AI key is configured). Everything else still works.");
      }
      const provider = deps.provider;
      if (source.status !== "ready") {
        throw new HttpError(409, "source_not_ready", "This source was not imported successfully, so cards cannot be made from it.");
      }

      const { segments, chars } = await resolveScope(userId, source, input.scope);

      // Reserve a slot (and enforce the limits) atomically, so concurrent requests cannot overshoot.
      const jobId = await withTransaction(pool, async (tx) => {
        await repo.lockGeneration(tx);
        const check = await repo.checkLimits(tx, userId, deps.limits);
        if (check === "in_progress") {
          throw new HttpError(409, "generation_in_progress", "A generation for you is still running. Wait for it to finish.");
        }
        if (check === "user_limit") {
          throw new HttpError(429, "generation_limit_reached", `You have reached today's limit of ${deps.limits.perUserPerDay} generations. It resets on a rolling 24-hour basis.`);
        }
        if (check === "global_limit") {
          throw new HttpError(429, "generation_capacity_reached", "The shared AI allowance for today is used up. Try again later.");
        }
        return repo.insertJob(tx, userId, {
          sourceId,
          scope: input.scope,
          scopeChars: chars,
          model: provider.model,
          requestedCards: input.maxCards,
        });
      });

      const fail = async (code: string, message: string, candidatesReturned = 0): Promise<never> => {
        await repo.finishJobFailed(pool, jobId, { code, message, candidatesReturned });
        throw new HttpError(aiHttpStatus(code as AiProviderError["code"]), code, message);
      };

      let output: unknown;
      try {
        output = await provider.generateStructured({
          system: input.style === "recall" ? buildSystemPrompt() : buildWrittenSystemPrompt(input.style),
          user: buildUserPrompt(segments, input.maxCards, input.style === "recall" ? "flashcards" : "written-answer questions"),
          schemaName: "flashcards",
          schema: (input.style === "recall" ? CARDS_JSON_SCHEMA : WRITTEN_CARDS_JSON_SCHEMA) as unknown as Record<string, unknown>,
          maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
        });
      } catch (err) {
        if (err instanceof AiProviderError) return fail(err.code, err.message);
        await repo.finishJobFailed(pool, jobId, { code: "internal_error", message: "Unexpected error while calling the AI service." });
        throw err;
      }

      const envelope = envelopeSchema.safeParse(output);
      if (!envelope.success) {
        return fail("ai_bad_response", "The AI answer did not have the expected shape. No cards were created.");
      }
      const returned = envelope.data.cards;

      const built: { card: ReturnType<typeof buildCandidate> extends infer R ? Extract<R, { card: unknown }>["card"] : never }[] = [];
      const discarded: Discard[] = [];
      for (const raw of returned) {
        const result = buildCandidate(raw, sourceId, segments, input.style);
        if ("card" in result) built.push({ card: result.card });
        else discarded.push(result.discard);
      }

      const existing = new Set((await repo.existingPromptsForSource(pool, userId, sourceId)).map(normalisePrompt));
      const { kept, discards: duplicates } = dropDuplicates(built, existing);
      discarded.push(...duplicates);
      const toCreate = kept.slice(0, input.maxCards);
      for (const extra of kept.slice(input.maxCards)) {
        discarded.push({ prompt: extra.card.prompt, reason: "More cards than requested." });
      }

      let cards: Card[];
      try {
        cards = await withTransaction(pool, async (tx) => {
          const created: Card[] = [];
          for (const item of toCreate) created.push(await createCardInTransaction(tx, userId, item.card, "ai_generated"));
          await repo.finishJobSucceeded(tx, jobId, {
            candidatesReturned: returned.length,
            draftsCreated: created.length,
            discarded,
          });
          return created;
        });
      } catch (err) {
        // The transaction rolled back, so no drafts exist. Record the failure honestly.
        await repo.finishJobFailed(pool, jobId, { code: "internal_error", message: "The drafts could not be saved.", candidatesReturned: returned.length });
        throw err;
      }

      const job: GenerationJob = (await repo.findJob(pool, userId, jobId))!;
      return { job, cards };
    },

    async listJobs(userId: string, sourceId: string): Promise<GenerationJob[]> {
      const source = await sources.findSource(pool, userId, sourceId);
      if (!source) throw notFoundError("Source");
      return repo.listJobsForSource(pool, userId, sourceId);
    },
  };
}

export type GenerationService = ReturnType<typeof createGenerationService>;
