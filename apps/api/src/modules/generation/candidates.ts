import { createCardSchema, type CreateCardInput, type GenerationStyle } from "@witlab/contracts";
import { z } from "zod";

/**
 * Turns what the AI returned into card drafts, and throws away anything that is not trustworthy.
 * Pure functions: no database, no network. The rules here are what make AI output "source-grounded":
 *  - the model must quote the source, and the quote must really occur in the text it was given;
 *  - the stored excerpt and its position are taken from the SOURCE, never from the model's claim;
 *  - the card must pass the same per-type validation as a hand-written card.
 */

/** A piece of the selected source text. `page` is set for PDFs; `offset` is the segment's start inside a text source. */
export interface ScopeSegment {
  page: number | null;
  text: string;
  offset: number;
}

export type Discard = { prompt: string | null; reason: string };

const CARD_TYPES = ["term_definition", "short_answer", "multiple_choice", "numeric"] as const;

/** JSON Schema sent to the model (strict mode: every property required, no extras). */
export const CARDS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "card_type", "prompt", "answer", "explanation", "choices", "correct_choice_index",
          "accepted_answers", "numeric_answer", "numeric_tolerance", "quote",
        ],
        properties: {
          card_type: { type: "string", enum: [...CARD_TYPES] },
          prompt: { type: "string" },
          answer: { type: "string" },
          explanation: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
          correct_choice_index: { type: "integer" },
          accepted_answers: { type: "array", items: { type: "string" } },
          numeric_answer: { type: "string" },
          numeric_tolerance: { type: "string" },
          quote: { type: "string" },
        },
      },
    },
  },
} as const;

/** JSON Schema for written-answer styles (Explain, Connections, Apply). */
export const WRITTEN_CARDS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["card_type", "prompt", "answer", "explanation", "criteria", "quote"],
        properties: {
          card_type: { type: "string", enum: ["open_ended"] },
          prompt: { type: "string" },
          answer: { type: "string" },
          explanation: { type: "string" },
          criteria: { type: "array", items: { type: "string" } },
          quote: { type: "string" },
        },
      },
    },
  },
} as const;

export const envelopeSchema = z.object({ cards: z.array(z.unknown()) });

const rawCardSchema = z.object({
  card_type: z.enum([...CARD_TYPES, "open_ended"]),
  criteria: z.array(z.string()).default([]),
  prompt: z.string(),
  answer: z.string(),
  explanation: z.string(),
  choices: z.array(z.string()).default([]),
  correct_choice_index: z.number().int().default(-1),
  accepted_answers: z.array(z.string()).default([]),
  numeric_answer: z.string().default(""),
  numeric_tolerance: z.string().default(""),
  quote: z.string(),
});

const MIN_QUOTE_CHARS = 12;
const MIN_PROMPT_CHARS = 8;

/** Lower-cases and collapses whitespace; used to compare prompts for duplicates. */
export function normalisePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Finds `quote` in `text`, ignoring differences in whitespace (line breaks in PDFs are arbitrary) but nothing else.
 * Returns the matching range in the ORIGINAL text (end exclusive), or null.
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (needle === "") return null;

  let hay = "";
  const map: number[] = []; // hay index -> original index
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      pendingSpace = hay.length > 0;
      continue;
    }
    if (pendingSpace) {
      hay += " ";
      map.push(i - 1);
      pendingSpace = false;
    }
    hay += ch;
    map.push(i);
  }
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  return { start: map[at]!, end: map[at + needle.length - 1]! + 1 };
}

export interface BuiltCandidate {
  input: CreateCardInput;
}

export function buildCandidate(
  raw: unknown,
  sourceId: string,
  segments: ScopeSegment[],
  style: GenerationStyle = "recall",
): { card: CreateCardInput } | { discard: Discard } {
  const parsed = rawCardSchema.safeParse(raw);
  const promptHint =
    typeof (raw as { prompt?: unknown } | null)?.prompt === "string" ? (raw as { prompt: string }).prompt.trim() || null : null;
  if (!parsed.success) {
    return { discard: { prompt: promptHint, reason: "The card was incomplete or in the wrong format." } };
  }
  const c = parsed.data;
  const prompt = c.prompt.trim();
  const discard = (reason: string) => ({ discard: { prompt: prompt || null, reason } });

  if (style === "recall" && c.card_type === "open_ended") return discard("A written-answer card was returned for a Recall request.");
  if (style !== "recall" && c.card_type !== "open_ended") return discard("The card was not a written-answer card.");
  const criteria = c.criteria.map((x) => x.trim()).filter((x) => x !== "");
  if (c.card_type === "open_ended" && criteria.length === 0) return discard("The card had no criteria for judging an answer.");
  if (prompt.length < MIN_PROMPT_CHARS) return discard("The question was too short.");
  if (c.answer.trim() === "") return discard("The card had no answer.");

  const quote = c.quote.trim();
  if (quote.length < MIN_QUOTE_CHARS) return discard("No supporting quote from the source was given.");

  let located: { segment: ScopeSegment; start: number; end: number } | null = null;
  for (const segment of segments) {
    const hit = locateQuote(segment.text, quote);
    if (hit) {
      located = { segment, ...hit };
      break;
    }
  }
  if (!located) return discard("The supporting quote does not appear in the selected source text, so the card was dropped.");
  const excerpt = located.segment.text.slice(located.start, located.end);
  if (excerpt.length > 2000) return discard("The supporting quote was too long.");

  let answer = c.answer.trim();
  let answerSpec: Record<string, unknown> | null = null;
  let rubric: Record<string, unknown> | null = null;
  switch (c.card_type) {
    case "open_ended":
      rubric = { criteria };
      break;
    case "term_definition":
      break;
    case "short_answer": {
      const accepted = [answer, ...c.accepted_answers.map((a) => a.trim())].filter((a) => a !== "");
      const seen = new Set<string>();
      answerSpec = { acceptedAnswers: accepted.filter((a) => (seen.has(a.toLowerCase()) ? false : (seen.add(a.toLowerCase()), true))) };
      break;
    }
    case "multiple_choice": {
      const choices = c.choices.map((x) => x.trim());
      const idx = c.correct_choice_index;
      if (idx < 0 || idx >= choices.length) return discard("The correct choice was not one of the choices.");
      answer = choices[idx]!;
      answerSpec = { choices, correctIndex: idx };
      break;
    }
    case "numeric": {
      const value = Number(c.numeric_answer.trim());
      const tolerance = c.numeric_tolerance.trim() === "" ? 0 : Number(c.numeric_tolerance.trim());
      if (c.numeric_answer.trim() === "" || !Number.isFinite(value) || !Number.isFinite(tolerance) || tolerance < 0) {
        return discard("The numeric answer was not a valid number.");
      }
      answerSpec = { value, tolerance };
      break;
    }
  }

  const result = createCardSchema.safeParse({
    cardType: c.card_type,
    prompt,
    answer,
    explanation: c.explanation.trim() === "" ? null : c.explanation.trim(),
    answerSpec,
    ...(rubric ? { rubric, learningMode: style === "recall" ? "explain" : style } : {}),
    sourceRefs: [
      {
        sourceId,
        excerpt,
        ...(located.segment.page !== null
          ? { pageStart: located.segment.page, pageEnd: located.segment.page }
          : {
              charStart: located.segment.offset + located.start,
              charEnd: located.segment.offset + located.end,
            }),
      },
    ],
  });
  if (!result.success) {
    const why = result.error.issues[0]?.message ?? "invalid";
    return discard(`The card did not pass validation: ${why}`);
  }
  return { card: result.data };
}

/** Drops cards whose question repeats an earlier one in the same batch or an existing card. */
export function dropDuplicates<T extends { card: CreateCardInput }>(
  built: T[],
  existingPrompts: Set<string>,
): { kept: T[]; discards: Discard[] } {
  const seen = new Set(existingPrompts);
  const kept: T[] = [];
  const discards: Discard[] = [];
  for (const item of built) {
    const key = normalisePrompt(item.card.prompt);
    if (seen.has(key)) {
      discards.push({ prompt: item.card.prompt, reason: "Duplicate of a question you already have for this source." });
    } else {
      seen.add(key);
      kept.push(item);
    }
  }
  return { kept, discards };
}
