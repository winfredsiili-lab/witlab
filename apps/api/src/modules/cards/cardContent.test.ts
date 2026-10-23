import { describe, expect, it } from "vitest";
import { createCardSchema, cardContentSchema, updateCardSchema } from "@witlab/contracts";

const base = { prompt: "Q?", answer: "A" };

function issuesFor(input: unknown): string[] {
  const result = createCardSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("card content rules by card type", () => {
  it("accepts a term_definition card without an answerSpec", () => {
    expect(createCardSchema.safeParse({ ...base, cardType: "term_definition" }).success).toBe(true);
  });

  it("rejects an answerSpec on term_definition and open_ended cards", () => {
    expect(issuesFor({ ...base, cardType: "term_definition", answerSpec: { x: 1 } })).toEqual([
      expect.stringContaining("answerSpec"),
    ]);
    expect(issuesFor({ ...base, cardType: "open_ended", answerSpec: { x: 1 } })).toHaveLength(1);
  });

  it("accepts and normalises a short_answer spec", () => {
    const parsed = createCardSchema.parse({
      ...base,
      cardType: "short_answer",
      answerSpec: { acceptedAnswers: ["  A  ", "alpha"] },
    });
    expect(parsed.answerSpec).toEqual({ acceptedAnswers: ["A", "alpha"] });
  });

  it("rejects unknown keys in a spec", () => {
    expect(issuesFor({ ...base, cardType: "short_answer", answerSpec: { acceptedAnswers: ["A"], hack: true } })).not.toEqual([]);
  });

  describe("multiple_choice", () => {
    const valid = {
      prompt: "Pick one",
      cardType: "multiple_choice",
      answer: "Beta",
      answerSpec: { choices: ["Alpha", "Beta", "Gamma"], correctIndex: 1 },
    };

    it("accepts a consistent card", () => {
      expect(createCardSchema.safeParse(valid).success).toBe(true);
    });

    it("requires an answerSpec", () => {
      expect(issuesFor({ ...valid, answerSpec: undefined })).toEqual([expect.stringContaining("answerSpec")]);
    });

    it("rejects a correctIndex outside the choices", () => {
      expect(issuesFor({ ...valid, answerSpec: { choices: ["Alpha", "Beta"], correctIndex: 5 } })).toEqual([
        expect.stringContaining("correctIndex"),
      ]);
    });

    it("rejects an answer that is not the correct choice", () => {
      expect(issuesFor({ ...valid, answer: "Gamma" })).toEqual([expect.stringContaining("answer")]);
    });

    it("rejects duplicate choices and too few choices", () => {
      expect(issuesFor({ ...valid, answer: "Alpha", answerSpec: { choices: ["Alpha", "alpha"], correctIndex: 0 } })).not.toEqual([]);
      expect(issuesFor({ ...valid, answerSpec: { choices: ["Beta"], correctIndex: 0 } })).not.toEqual([]);
    });
  });

  describe("numeric", () => {
    it("accepts value and tolerance", () => {
      expect(createCardSchema.safeParse({ ...base, cardType: "numeric", answer: "3.14", answerSpec: { value: 3.14, tolerance: 0.01 } }).success).toBe(true);
    });

    it("rejects a negative tolerance, a missing spec and non-numbers", () => {
      expect(issuesFor({ ...base, cardType: "numeric", answerSpec: { value: 1, tolerance: -1 } })).not.toEqual([]);
      expect(issuesFor({ ...base, cardType: "numeric" })).not.toEqual([]);
      expect(issuesFor({ ...base, cardType: "numeric", answerSpec: { value: "1", tolerance: 0 } })).not.toEqual([]);
    });
  });

  describe("rubric", () => {
    it("is accepted on open_ended cards", () => {
      expect(createCardSchema.safeParse({ ...base, cardType: "open_ended", rubric: { criteria: ["Mentions isolation"] } }).success).toBe(true);
    });

    it("is rejected on other card types and when empty", () => {
      expect(issuesFor({ ...base, cardType: "short_answer", rubric: { criteria: ["x"] } })).toEqual([expect.stringContaining("rubric")]);
      expect(issuesFor({ ...base, cardType: "open_ended", rubric: { criteria: [] } })).not.toEqual([]);
    });
  });

  it("rejects an unknown card type and blank text", () => {
    expect(issuesFor({ ...base, cardType: "essay" })).not.toEqual([]);
    expect(issuesFor({ prompt: "  ", answer: "A", cardType: "term_definition" })).not.toEqual([]);
  });

  it("cardContentSchema revalidates merged content after an edit", () => {
    const edited = cardContentSchema.safeParse({
      cardType: "multiple_choice",
      answer: "Delta",
      answerSpec: { choices: ["Alpha", "Beta"], correctIndex: 0 },
    });
    expect(edited.success).toBe(false);
  });
});

describe("updateCardSchema", () => {
  it("requires at least one field and rejects unknown fields", () => {
    expect(updateCardSchema.safeParse({}).success).toBe(false);
    expect(updateCardSchema.safeParse({ status: "approved" }).success).toBe(false);
    expect(updateCardSchema.safeParse({ cardType: "numeric" }).success).toBe(false);
    expect(updateCardSchema.safeParse({ prompt: "New?" }).success).toBe(true);
  });
});
