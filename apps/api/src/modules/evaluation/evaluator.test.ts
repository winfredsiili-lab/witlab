import { describe, expect, it } from "vitest";
import { evaluate, evaluationKind, normaliseText, parseNumber, SubmissionError, type CardForEvaluation } from "./evaluator.js";

const mc: CardForEvaluation = {
  cardType: "multiple_choice",
  answer: "Beta",
  answerSpec: { choices: ["Alpha", "Beta", "Gamma"], correctIndex: 1 },
};
const numeric = (value: number, tolerance: number): CardForEvaluation => ({
  cardType: "numeric",
  answer: String(value),
  answerSpec: { value, tolerance },
});
const shortAnswer = (answer: string, acceptedAnswers?: string[]): CardForEvaluation => ({
  cardType: "short_answer",
  answer,
  answerSpec: acceptedAnswers ? { acceptedAnswers } : null,
});
const definition: CardForEvaluation = { cardType: "term_definition", answer: "An isolated location.", answerSpec: null };

describe("evaluationKind", () => {
  it("classifies each card type", () => {
    expect(evaluationKind("multiple_choice")).toBe("auto");
    expect(evaluationKind("numeric")).toBe("auto");
    expect(evaluationKind("short_answer")).toBe("auto");
    expect(evaluationKind("term_definition")).toBe("self");
    expect(evaluationKind("open_ended")).toBe("ai");
  });
});

describe("normaliseText", () => {
  it("ignores case, outer punctuation, curly quotes and extra whitespace", () => {
    expect(normaliseText("  Virtual   MACHINE. ")).toBe("virtual machine");
    expect(normaliseText("“It’s fine!”")).toBe("it's fine");
  });
  it("keeps accents, because they can change meaning", () => {
    expect(normaliseText("cafe")).not.toBe(normaliseText("café"));
  });
  it("applies NFKC so full-width characters match", () => {
    expect(normaliseText("ＡＢＣ")).toBe("abc");
  });
});

describe("parseNumber", () => {
  it.each([["12", 12], ["-3.5", -3.5], [" +.5 ", 0.5], ["1e3", 1000], ["7.", 7]])("parses %s", (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });
  it.each(["", "abc", "1,000", "12 apples", "1.2.3", "NaN", "Infinity", "0x10"])("rejects %j", (input) => {
    expect(parseNumber(input)).toBeNull();
  });
});

describe("multiple_choice", () => {
  it("marks the correct choice correct", () => {
    const e = evaluate(mc, { selectedIndex: 1 });
    expect(e).toMatchObject({ verdict: "correct", method: "deterministic", submittedAnswer: "Beta" });
    expect(e.feedback).toContain("Correct");
  });
  it("marks a wrong choice incorrect and shows the right answer", () => {
    const e = evaluate(mc, { selectedIndex: 0 });
    expect(e.verdict).toBe("incorrect");
    expect(e.submittedAnswer).toBe("Alpha");
    expect(e.feedback).toContain("Alpha");
    expect(e.feedback).toContain("Beta");
  });
  it("records no selection as incorrect, not as an error", () => {
    const e = evaluate(mc, {});
    expect(e).toMatchObject({ verdict: "incorrect", submittedAnswer: null });
    expect(e.feedback).toContain("No answer was selected");
  });
  it("rejects an out-of-range index and unrelated fields", () => {
    expect(() => evaluate(mc, { selectedIndex: 3 })).toThrow(SubmissionError);
    expect(() => evaluate(mc, { selectedIndex: -1 })).toThrow(SubmissionError);
    expect(() => evaluate(mc, { selectedIndex: 1.5 })).toThrow(SubmissionError);
    expect(() => evaluate(mc, { selectedIndex: 1, answer: "Beta" })).toThrow(SubmissionError);
    expect(() => evaluate(mc, { selfGrade: "correct" })).toThrow(SubmissionError);
  });
});

describe("numeric", () => {
  it("accepts the exact value and values inside the tolerance, including the boundaries", () => {
    expect(evaluate(numeric(10, 0.5), { answer: "10" }).verdict).toBe("correct");
    expect(evaluate(numeric(10, 0.5), { answer: "9.5" }).verdict).toBe("correct");
    expect(evaluate(numeric(10, 0.5), { answer: "10.5" }).verdict).toBe("correct");
  });
  it("rejects values outside the tolerance and explains the range", () => {
    const e = evaluate(numeric(10, 0.5), { answer: "10.6" });
    expect(e.verdict).toBe("incorrect");
    expect(e.feedback).toContain("9.5");
    expect(e.feedback).toContain("10.5");
  });
  it("handles floating point noise (0.1 + 0.2 style values)", () => {
    expect(evaluate(numeric(0.3, 0), { answer: "0.30000000000000004" }).verdict).toBe("correct");
  });
  it("treats a zero tolerance as an exact match", () => {
    expect(evaluate(numeric(42, 0), { answer: "42" }).verdict).toBe("correct");
    expect(evaluate(numeric(42, 0), { answer: "42.1" }).verdict).toBe("incorrect");
  });
  it("records a blank answer as incorrect", () => {
    expect(evaluate(numeric(42, 0), { answer: "  " })).toMatchObject({ verdict: "incorrect", submittedAnswer: null });
    expect(evaluate(numeric(42, 0), {})).toMatchObject({ verdict: "incorrect" });
  });
  it("throws (records nothing) when the text is not a number", () => {
    expect(() => evaluate(numeric(42, 0), { answer: "forty two" })).toThrow(SubmissionError);
    expect(() => evaluate(numeric(1000, 0), { answer: "1,000" })).toThrow(/Commas/);
  });
  it("records the parsed value and tolerance as evidence", () => {
    expect(evaluate(numeric(10, 0.5), { answer: " 9.8 " }).metadata).toEqual({ parsed: 9.8, value: 10, tolerance: 0.5 });
  });
});

describe("short_answer", () => {
  it("matches the canonical answer ignoring case and punctuation", () => {
    expect(evaluate(shortAnswer("Virtual machine"), { answer: "  virtual MACHINE. " }).verdict).toBe("correct");
  });
  it("matches any accepted variant", () => {
    const card = shortAnswer("VM", ["virtual machine", "vm instance"]);
    expect(evaluate(card, { answer: "Virtual Machine" }).verdict).toBe("correct");
    expect(evaluate(card, { answer: "vm" }).verdict).toBe("correct");
  });
  it("rejects a different answer and lists what was accepted", () => {
    const e = evaluate(shortAnswer("VM", ["virtual machine"]), { answer: "container" });
    expect(e.verdict).toBe("incorrect");
    expect(e.feedback).toContain("container");
    expect(e.feedback).toContain("virtual machine");
  });
  it("does not accept a partial match as correct", () => {
    expect(evaluate(shortAnswer("virtual machine"), { answer: "virtual" }).verdict).toBe("incorrect");
  });
  it("does not let punctuation alone count as an answer", () => {
    expect(evaluate(shortAnswer("..."), { answer: "!!!" }).verdict).toBe("incorrect");
  });
  it("records a blank answer as incorrect with the accepted answers shown", () => {
    const e = evaluate(shortAnswer("VM"), { answer: "" });
    expect(e).toMatchObject({ verdict: "incorrect", submittedAnswer: null });
    expect(e.feedback).toContain("VM");
  });
  it("rejects fields that do not belong to this card type", () => {
    expect(() => evaluate(shortAnswer("VM"), { selfGrade: "correct" })).toThrow(SubmissionError);
    expect(() => evaluate(shortAnswer("VM"), { selectedIndex: 0 })).toThrow(SubmissionError);
  });
});

describe("term_definition (self-assessed)", () => {
  it.each(["correct", "partial", "incorrect"] as const)("records the learner's own %s verdict", (selfGrade) => {
    const e = evaluate(definition, { answer: "my attempt", selfGrade });
    expect(e).toMatchObject({ verdict: selfGrade, method: "self_assessed", submittedAnswer: "my attempt" });
  });
  it("works without a typed answer", () => {
    expect(evaluate(definition, { selfGrade: "correct" }).submittedAnswer).toBeNull();
  });
  it("requires a self-grade: it never silently marks anything correct", () => {
    expect(() => evaluate(definition, {})).toThrow(/selfGrade/);
    expect(() => evaluate(definition, { answer: "text" })).toThrow(SubmissionError);
  });
  it("does not accept a choice index", () => {
    expect(() => evaluate(definition, { selfGrade: "correct", selectedIndex: 0 })).toThrow(SubmissionError);
  });
});

describe("open_ended", () => {
  it("cannot be evaluated in Recall mode and is never marked correct", () => {
    expect(() => evaluate({ cardType: "open_ended", answer: "x", answerSpec: null }, { answer: "x" })).toThrow(SubmissionError);
  });
});
