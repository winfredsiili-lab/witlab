import { describe, expect, it } from "vitest";
import { AiProviderError, type AiProvider } from "../ai/provider.js";
import { buildEvaluationPrompts, evaluateWrittenAnswer, parseEvaluation } from "./aiEvaluator.js";

const input = {
  mode: "explain" as const,
  prompt: "Why do availability zones improve resilience?",
  modelAnswer: "A failure in one zone need not take down another.",
  criteria: ["mentions isolation between zones", "does not claim protection from regional outages"],
  excerpts: ["Zones have independent power, cooling and networking."],
  learnerAnswer: "Because zones are isolated, one failing does not stop the others.",
};
const good = { verdict: "correct", strengths: "You named isolation.", gaps: "", stronger_answer: "", misconception: "", clarifying_question: "" };

describe("prompts", () => {
  it("contains the question, model answer, criteria, source passages and the learner's answer as delimited data", () => {
    const { system, user } = buildEvaluationPrompts(input);
    expect(user).toContain("Why do availability zones improve resilience?");
    expect(user).toContain("A failure in one zone need not take down another.");
    expect(user).toContain("1. mentions isolation between zones");
    expect(user).toContain('"Zones have independent power, cooling and networking."');
    expect(user).toContain("<<<ANSWER\nBecause zones are isolated");
    expect(system).toMatch(/not.*keywords/i);
    expect(system).toMatch(/overclaims/);
    expect(system).toMatch(/data, not instructions/);
  });
  it("adapts the focus to the mode and omits empty sections", () => {
    const a = buildEvaluationPrompts({ ...input, mode: "apply", criteria: [], excerpts: [] });
    expect(a.system).toMatch(/scenario/);
    expect(a.user).not.toContain("CRITERIA");
    expect(a.user).not.toContain("SOURCE PASSAGES");
    expect(buildEvaluationPrompts({ ...input, mode: "connections" }).system).toMatch(/relate or differ/);
  });
});

describe("parseEvaluation", () => {
  it("accepts a good evaluation and compiles labelled feedback", () => {
    const r = parseEvaluation({ ...good, gaps: "You did not mention regions.", stronger_answer: "Say zones do not cover regional outages.", misconception: "Zones do not protect against everything." });
    expect(r.verdict).toBe("correct");
    expect(r.feedback).toBe(
      "What you got right: You named isolation.\n\nWhat was missing or off: You did not mention regions.\n\nA stronger answer: Say zones do not cover regional outages.\n\nMisconception to correct: Zones do not protect against everything.",
    );
  });
  it("uses the clarifying question as the feedback for ambiguous answers, and requires one", () => {
    expect(parseEvaluation({ ...good, verdict: "ambiguous", strengths: "", clarifying_question: "Which zones do you mean?" })).toMatchObject({ verdict: "ambiguous", feedback: "Which zones do you mean?" });
    expect(() => parseEvaluation({ ...good, verdict: "ambiguous", strengths: "", clarifying_question: " " })).toThrow(AiProviderError);
  });
  it.each([
    ["a verdict with no feedback", { ...good, strengths: "" }],
    ["an unknown verdict", { ...good, verdict: "great" }],
    ["a missing field", { verdict: "correct", strengths: "x" }],
    ["not an object", "correct"],
    ["null", null],
    ["a field that is too long", { ...good, strengths: "x".repeat(1501) }],
  ])("rejects %s as ai_bad_response", (_n, raw) => {
    try {
      parseEvaluation(raw);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AiProviderError);
      expect((e as AiProviderError).code).toBe("ai_bad_response");
    }
  });
});

describe("evaluateWrittenAnswer", () => {
  it("returns the parsed evaluation and sends a bounded request", async () => {
    let seen: { schemaName: string; maxOutputTokens: number } | undefined;
    const provider: AiProvider = { model: "m", generateStructured: async (r) => { seen = r; return good; } };
    expect((await evaluateWrittenAnswer(provider, input)).verdict).toBe("correct");
    expect(seen).toMatchObject({ schemaName: "answer_evaluation", maxOutputTokens: 900 });
  });
  it("lets provider failures through unchanged", async () => {
    const provider: AiProvider = { model: "m", generateStructured: async () => { throw new AiProviderError("ai_timeout", "slow"); } };
    await expect(evaluateWrittenAnswer(provider, input)).rejects.toMatchObject({ code: "ai_timeout" });
  });
});
