import type { CardType } from "@witlab/contracts";

/** Outcomes this evaluator can produce. (`ambiguous` and `not_evaluated` are reserved for AI evaluation.) */
export type Verdict = "correct" | "partial" | "incorrect";

/** "auto": the server decides correctness. "self": the learner grades themselves. "ai": a written answer judged by AI (see aiEvaluator.ts). */
export type EvaluationKind = "auto" | "self" | "ai";

export interface CardForEvaluation {
  cardType: CardType;
  answer: string;
  answerSpec: Record<string, unknown> | null;
}

export interface Submission {
  /** Typed answer (short_answer, numeric, and optionally term_definition). */
  answer?: string;
  /** Chosen option (multiple_choice). */
  selectedIndex?: number;
  /** Learner's own verdict (term_definition only). */
  selfGrade?: Verdict;
}

export interface Evaluation {
  verdict: Verdict;
  method: "deterministic" | "self_assessed";
  /** What the learner submitted, as text. For multiple choice, the text of the chosen option. */
  submittedAnswer: string | null;
  feedback: string;
  metadata: Record<string, unknown>;
}

/** The submission does not fit the card (wrong fields, or an answer that cannot be read). The learner should fix it and retry. */
export class SubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionError";
  }
}

export function evaluationKind(cardType: CardType): EvaluationKind {
  switch (cardType) {
    case "multiple_choice":
    case "numeric":
    case "short_answer":
      return "auto";
    case "term_definition":
      return "self";
    case "open_ended":
      return "ai";
  }
}

/**
 * Normalises text for comparison: Unicode NFKC, lower case, straight quotes, trimmed of surrounding
 * punctuation and spaces, inner whitespace collapsed. Accents are deliberately kept (they can change meaning).
 */
export function normaliseText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .replace(/\s+/g, " ");
}

const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Parses a plain number. Commas are rejected on purpose: "1,000" means different things in different locales. */
export function parseNumber(input: string): number | null {
  const trimmed = input.trim();
  if (!NUMBER_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

const quote = (text: string) => `“${text}”`;

function isBlank(text: string | undefined): boolean {
  return text === undefined || text.trim() === "";
}

function rejectUnexpected(card: CardForEvaluation, submission: Submission, allowed: Array<keyof Submission>): void {
  for (const field of ["answer", "selectedIndex", "selfGrade"] as const) {
    if (submission[field] !== undefined && !allowed.includes(field)) {
      throw new SubmissionError(`${card.cardType} cards do not accept "${field}".`);
    }
  }
}

function evaluateMultipleChoice(card: CardForEvaluation, submission: Submission): Evaluation {
  rejectUnexpected(card, submission, ["selectedIndex"]);
  const choices = (card.answerSpec?.choices ?? []) as string[];
  const correctIndex = card.answerSpec?.correctIndex as number;
  const correctChoice = choices[correctIndex] ?? card.answer;
  const selected = submission.selectedIndex;

  if (selected === undefined) {
    return {
      verdict: "incorrect",
      method: "deterministic",
      submittedAnswer: null,
      feedback: `No answer was selected. The correct answer is ${quote(correctChoice)}.`,
      metadata: { selectedIndex: null, correctIndex },
    };
  }
  if (!Number.isInteger(selected) || selected < 0 || selected >= choices.length) {
    throw new SubmissionError(`selectedIndex must be between 0 and ${choices.length - 1}.`);
  }

  const chosen = choices[selected]!;
  const correct = selected === correctIndex;
  return {
    verdict: correct ? "correct" : "incorrect",
    method: "deterministic",
    submittedAnswer: chosen,
    feedback: correct
      ? `Correct: ${quote(chosen)}.`
      : `You chose ${quote(chosen)}. The correct answer is ${quote(correctChoice)}.`,
    metadata: { selectedIndex: selected, correctIndex },
  };
}

function evaluateNumeric(card: CardForEvaluation, submission: Submission): Evaluation {
  rejectUnexpected(card, submission, ["answer"]);
  const value = card.answerSpec?.value as number;
  const tolerance = card.answerSpec?.tolerance as number;
  const low = value - tolerance;
  const high = value + tolerance;

  if (isBlank(submission.answer)) {
    return {
      verdict: "incorrect",
      method: "deterministic",
      submittedAnswer: null,
      feedback: `No answer was given. The correct answer is ${tolerance === 0 ? value : `${value} (accepted range ${low} to ${high})`}.`,
      metadata: { parsed: null, value, tolerance },
    };
  }

  const submitted = submission.answer!.trim();
  const parsed = parseNumber(submitted);
  if (parsed === null) {
    throw new SubmissionError("Enter a number using digits and a decimal point (for example 12.5). Commas are not accepted.");
  }

  const epsilon = 1e-9 * Math.max(1, Math.abs(value));
  const correct = Math.abs(parsed - value) <= tolerance + epsilon;
  const range = tolerance === 0 ? `The correct answer is ${value}.` : `The accepted range is ${low} to ${high} (${value} ± ${tolerance}).`;
  return {
    verdict: correct ? "correct" : "incorrect",
    method: "deterministic",
    submittedAnswer: submitted,
    feedback: correct
      ? tolerance === 0
        ? `Correct: ${parsed}.`
        : `Correct: ${parsed} is within ${tolerance} of ${value}.`
      : `${parsed} is not correct. ${range}`,
    metadata: { parsed, value, tolerance },
  };
}

function evaluateShortAnswer(card: CardForEvaluation, submission: Submission): Evaluation {
  rejectUnexpected(card, submission, ["answer"]);
  const extra = Array.isArray(card.answerSpec?.acceptedAnswers) ? (card.answerSpec!.acceptedAnswers as string[]) : [];
  const accepted = [...new Set([card.answer, ...extra])];
  const acceptedList = accepted.map(quote).join(", ");

  if (isBlank(submission.answer)) {
    return {
      verdict: "incorrect",
      method: "deterministic",
      submittedAnswer: null,
      feedback: `No answer was given. Accepted: ${acceptedList}.`,
      metadata: { accepted },
    };
  }

  const submitted = submission.answer!.trim();
  const normalised = normaliseText(submitted);
  const correct = normalised !== "" && accepted.some((a) => normaliseText(a) === normalised);
  return {
    verdict: correct ? "correct" : "incorrect",
    method: "deterministic",
    submittedAnswer: submitted,
    feedback: correct ? "Correct." : `${quote(submitted)} does not match an accepted answer. Accepted: ${acceptedList}.`,
    metadata: { accepted, normalisedSubmission: normalised },
  };
}

const SELF_FEEDBACK: Record<Verdict, string> = {
  correct: "You marked this correct.",
  partial: "You marked this partly correct. Compare with the model answer and note what was missing.",
  incorrect: "You marked this incorrect. Review the model answer below.",
};

function evaluateSelfAssessed(card: CardForEvaluation, submission: Submission): Evaluation {
  rejectUnexpected(card, submission, ["answer", "selfGrade"]);
  if (submission.selfGrade === undefined) {
    throw new SubmissionError("Grade yourself: selfGrade must be correct, partial or incorrect.");
  }
  return {
    verdict: submission.selfGrade,
    method: "self_assessed",
    submittedAnswer: isBlank(submission.answer) ? null : submission.answer!.trim(),
    feedback: SELF_FEEDBACK[submission.selfGrade],
    metadata: { selfGrade: submission.selfGrade },
  };
}

/**
 * Evaluates one submission against one card. Pure: no database, no clock, no network, no AI.
 * Throws SubmissionError when the submission cannot be interpreted (nothing should be recorded then).
 */
export function evaluate(card: CardForEvaluation, submission: Submission): Evaluation {
  switch (card.cardType) {
    case "multiple_choice":
      return evaluateMultipleChoice(card, submission);
    case "numeric":
      return evaluateNumeric(card, submission);
    case "short_answer":
      return evaluateShortAnswer(card, submission);
    case "term_definition":
      return evaluateSelfAssessed(card, submission);
    case "open_ended":
      throw new SubmissionError("Open-ended cards cannot be evaluated in Recall mode yet.");
  }
}
