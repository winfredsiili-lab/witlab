/**
 * Review scheduler: a small, transparent SM-2-style algorithm. See docs/LEARNING_ENGINE.md section 5.
 * Pure and deterministic. The current time is always passed in. It knows nothing about the UI or about AI.
 */

export type ScheduledVerdict = "correct" | "partial" | "incorrect";

export interface ReviewState {
  dueAt: Date;
  intervalDays: number;
  ease: number;
  repetitions: number;
  lapses: number;
  lastReviewedAt: Date;
  lastVerdict: ScheduledVerdict;
}

export const INITIAL_EASE = 2.5;
export const MIN_EASE = 1.3;
export const RELEARN_MINUTES = 10;
export const FIRST_INTERVAL_DAYS = 1;
export const SECOND_INTERVAL_DAYS = 6;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const roundEase = (ease: number) => Math.round(Math.max(MIN_EASE, ease) * 100) / 100;

/** `previous` is null when the card has never been practised. */
export function schedule(previous: ReviewState | null, verdict: ScheduledVerdict, now: Date): ReviewState {
  const prevInterval = previous?.intervalDays ?? 0;
  const prevEase = previous?.ease ?? INITIAL_EASE;
  const prevReps = previous?.repetitions ?? 0;
  const prevLapses = previous?.lapses ?? 0;

  switch (verdict) {
    case "correct": {
      const repetitions = prevReps + 1;
      const intervalDays =
        repetitions === 1
          ? FIRST_INTERVAL_DAYS
          : repetitions === 2
            ? SECOND_INTERVAL_DAYS
            : Math.max(prevInterval + 1, Math.round(prevInterval * prevEase));
      return {
        dueAt: new Date(now.getTime() + intervalDays * MS_PER_DAY),
        intervalDays,
        ease: roundEase(prevEase),
        repetitions,
        lapses: prevLapses,
        lastReviewedAt: now,
        lastVerdict: verdict,
      };
    }

    case "partial": {
      const intervalDays = Math.max(1, Math.round(prevInterval * 0.5));
      return {
        dueAt: new Date(now.getTime() + intervalDays * MS_PER_DAY),
        intervalDays,
        ease: roundEase(prevEase - 0.15),
        repetitions: prevReps,
        lapses: prevLapses,
        lastReviewedAt: now,
        lastVerdict: verdict,
      };
    }

    case "incorrect":
      return {
        dueAt: new Date(now.getTime() + RELEARN_MINUTES * MS_PER_MINUTE),
        intervalDays: 0,
        ease: roundEase(prevEase - 0.2),
        repetitions: 0,
        // A lapse is forgetting something that had been answered correctly before.
        lapses: prevLapses + (prevReps > 0 ? 1 : 0),
        lastReviewedAt: now,
        lastVerdict: verdict,
      };
  }
}

function formatAgo(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / MS_PER_MINUTE));
  if (minutes < 60) return "less than an hour";
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/** Plain-language reason a card is (or is not) due. Pass null for a card that has never been practised. */
export function explainDue(state: ReviewState | null, now: Date): string {
  if (state === null) return "New card: you have not practised it yet.";

  const ago = formatAgo(state.lastReviewedAt, now);
  if (state.dueAt.getTime() > now.getTime()) {
    return `Not due until ${state.dueAt.toISOString()}.`;
  }
  switch (state.lastVerdict) {
    case "incorrect":
      return `Answered incorrectly ${ago} ago; due for another try.`;
    case "partial":
      return `Partly correct ${ago} ago; due for review.`;
    case "correct":
      return `Last answered correctly ${ago} ago; the ${state.intervalDays}-day interval has passed.`;
  }
}
