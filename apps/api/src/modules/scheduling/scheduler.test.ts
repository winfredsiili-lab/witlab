import { describe, expect, it } from "vitest";
import { explainDue, MIN_EASE, schedule, type ReviewState } from "./scheduler.js";

const DAY = 86_400_000;
const t0 = new Date("2026-01-01T09:00:00.000Z");
const after = (ms: number) => new Date(t0.getTime() + ms);

/** Applies a sequence of verdicts, each `gapDays` after the previous review (or exactly when due when gapDays is null). */
function run(verdicts: Array<"correct" | "partial" | "incorrect">, gapDays: number | null = null): ReviewState[] {
  const states: ReviewState[] = [];
  let state: ReviewState | null = null;
  let now = t0;
  for (const verdict of verdicts) {
    state = schedule(state, verdict, now);
    states.push(state);
    now = gapDays === null ? state.dueAt : new Date(now.getTime() + gapDays * DAY);
  }
  return states;
}

describe("schedule: correct answers", () => {
  it("first success: due in 1 day; second: 6 days; then grows by ease", () => {
    const [a, b, c, d] = run(["correct", "correct", "correct", "correct"]);
    expect(a).toMatchObject({ repetitions: 1, intervalDays: 1, ease: 2.5, lapses: 0 });
    expect(a!.dueAt).toEqual(after(DAY));
    expect(b).toMatchObject({ repetitions: 2, intervalDays: 6 });
    expect(c).toMatchObject({ repetitions: 3, intervalDays: 15 }); // round(6 * 2.5)
    expect(d).toMatchObject({ repetitions: 4, intervalDays: 38 }); // round(15 * 2.5)
  });

  it("always grows by at least one day, even at the minimum ease", () => {
    let state: ReviewState | null = null;
    for (const v of ["incorrect", "incorrect", "incorrect", "incorrect", "incorrect", "incorrect", "incorrect"] as const) state = schedule(state, v, t0);
    expect(state!.ease).toBe(MIN_EASE);
    const s3 = schedule({ ...state!, repetitions: 2, intervalDays: 1 }, "correct", t0);
    expect(s3.intervalDays).toBeGreaterThanOrEqual(2);
  });

  it("does not change ease", () => {
    const [a, b, c] = run(["correct", "correct", "correct"]);
    expect([a!.ease, b!.ease, c!.ease]).toEqual([2.5, 2.5, 2.5]);
  });
});

describe("schedule: incorrect answers", () => {
  it("on a new card: relearn in 10 minutes, no lapse (it was never known)", () => {
    const s = schedule(null, "incorrect", t0);
    expect(s).toMatchObject({ repetitions: 0, intervalDays: 0, lapses: 0, ease: 2.3, lastVerdict: "incorrect" });
    expect(s.dueAt).toEqual(after(10 * 60_000));
  });

  it("after successes: resets repetitions, counts a lapse, lowers ease, relearns in 10 minutes", () => {
    const [, , third] = run(["correct", "correct", "correct"]);
    const lapsed = schedule(third!, "incorrect", after(20 * DAY));
    expect(lapsed).toMatchObject({ repetitions: 0, intervalDays: 0, lapses: 1, ease: 2.3 });
    expect(lapsed.dueAt).toEqual(new Date(after(20 * DAY).getTime() + 10 * 60_000));
  });

  it("restarts the ladder from 1 day after a lapse", () => {
    const states = run(["correct", "correct", "incorrect", "correct", "correct"]);
    expect(states[3]).toMatchObject({ repetitions: 1, intervalDays: 1 });
    expect(states[4]).toMatchObject({ repetitions: 2, intervalDays: 6 });
    expect(states[4]!.lapses).toBe(1);
  });

  it("never lets ease fall below the minimum", () => {
    let state: ReviewState | null = null;
    for (let i = 0; i < 20; i++) state = schedule(state, "incorrect", t0);
    expect(state!.ease).toBe(MIN_EASE);
  });
});

describe("schedule: partial answers", () => {
  it("halves the interval, keeps repetitions, lowers ease slightly, adds no lapse", () => {
    const [, , third] = run(["correct", "correct", "correct"]); // interval 15
    const p = schedule(third!, "partial", after(15 * DAY));
    expect(p).toMatchObject({ intervalDays: 8, repetitions: 3, lapses: 0, ease: 2.35, lastVerdict: "partial" });
  });
  it("on a new card: due in 1 day, no repetition progress", () => {
    expect(schedule(null, "partial", t0)).toMatchObject({ intervalDays: 1, repetitions: 0, ease: 2.35 });
  });
});

describe("schedule: properties", () => {
  it("is deterministic and does not mutate its input", () => {
    const [first] = run(["correct"]);
    const snapshot = JSON.stringify(first);
    const a = schedule(first!, "correct", after(DAY));
    const b = schedule(first!, "correct", after(DAY));
    expect(a).toEqual(b);
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it("records when and how the card was last reviewed", () => {
    const s = schedule(null, "correct", after(5 * DAY));
    expect(s.lastReviewedAt).toEqual(after(5 * DAY));
    expect(s.lastVerdict).toBe("correct");
  });

  it("one correct answer does not claim long-term retention: the first interval is just one day", () => {
    expect(schedule(null, "correct", t0).intervalDays).toBe(1);
  });
});

describe("explainDue", () => {
  it("explains a never-practised card", () => {
    expect(explainDue(null, t0)).toMatch(/New card/);
  });

  it("explains each kind of due card", () => {
    const base = schedule(null, "correct", t0);
    const now = after(3 * DAY);
    expect(explainDue(base, now)).toBe("Last answered correctly 3 days ago; the 1-day interval has passed.");
    expect(explainDue(schedule(null, "incorrect", t0), after(2 * 3_600_000))).toBe("Answered incorrectly 2 hours ago; due for another try.");
    expect(explainDue(schedule(null, "partial", t0), now)).toBe("Partly correct 3 days ago; due for review.");
  });

  it("says when a card is not due yet", () => {
    const s = schedule(null, "correct", t0);
    expect(explainDue(s, after(1000))).toBe(`Not due until ${s.dueAt.toISOString()}.`);
  });

  it("uses a sensible unit for short gaps", () => {
    expect(explainDue(schedule(null, "incorrect", t0), after(11 * 60_000))).toBe("Answered incorrectly less than an hour ago; due for another try.");
  });
});
