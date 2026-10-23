import { describe, expect, it } from "vitest";
import { buildCandidate, dropDuplicates, locateQuote, type ScopeSegment } from "./candidates.js";

const SRC = "11111111-1111-4111-8111-111111111111";
const text = "Intro line.\nAn availability zone is an isolated\nlocation within a region. Zones have independent power.";
const textSeg: ScopeSegment[] = [{ page: null, text, offset: 100 }];
const pdfSegs: ScopeSegment[] = [
  { page: 3, text: "Nothing useful here at all.", offset: 0 },
  { page: 4, text: "A load balancer distributes traffic across healthy instances.", offset: 0 },
];

const raw = (over: Record<string, unknown> = {}) => ({
  card_type: "term_definition", prompt: "What is an availability zone?",
  answer: "An isolated location within a region.", explanation: "Stated in the passage.",
  choices: [], correct_choice_index: -1, accepted_answers: [], numeric_answer: "", numeric_tolerance: "",
  quote: "An availability zone is an isolated location within a region.", ...over,
});

describe("locateQuote", () => {
  it("matches across different whitespace and returns the original range", () => {
    const hit = locateQuote(text, "An availability zone is an isolated location within a region.")!;
    expect(text.slice(hit.start, hit.end)).toBe("An availability zone is an isolated\nlocation within a region.");
  });
  it("does not match paraphrases, different case, or empty quotes", () => {
    expect(locateQuote(text, "An availability zone is an isolated place within a region.")).toBeNull();
    expect(locateQuote(text, "an availability zone is an isolated location")).toBeNull();
    expect(locateQuote(text, "   ")).toBeNull();
  });
});

describe("buildCandidate", () => {
  it("builds a text-source card whose excerpt and offsets come from the source, not the model", () => {
    const out = buildCandidate(raw(), SRC, textSeg);
    if (!("card" in out)) throw new Error(JSON.stringify(out));
    const ref = out.card.sourceRefs![0]!;
    expect(ref.excerpt).toBe("An availability zone is an isolated\nlocation within a region.");
    expect(ref.charStart).toBe(100 + text.indexOf("An availability"));
    expect(ref.charEnd).toBe(ref.charStart! + ref.excerpt.length);
    expect(ref.pageStart).toBeUndefined();
  });

  it("records the page the quote was found on for a PDF", () => {
    const out = buildCandidate(raw({ prompt: "What does a load balancer do?", answer: "Distributes traffic.", quote: "A load balancer distributes traffic across healthy instances." }), SRC, pdfSegs);
    if (!("card" in out)) throw new Error(JSON.stringify(out));
    expect(out.card.sourceRefs![0]).toMatchObject({ pageStart: 4, pageEnd: 4 });
    expect(out.card.sourceRefs![0]!.charStart).toBeUndefined();
  });

  it("DISCARDS a card whose quote is not in the selected text (hallucinated grounding)", () => {
    const out = buildCandidate(raw({ quote: "Availability zones are connected by magic fibre." }), SRC, textSeg);
    expect("discard" in out && out.discard.reason).toMatch(/does not appear/);
  });

  it("does not accept a quote that exists only outside the selected scope", () => {
    const out = buildCandidate(raw({ quote: "A load balancer distributes traffic across healthy instances." }), SRC, textSeg);
    expect("discard" in out).toBe(true);
  });

  it("discards missing, too-short and malformed fields", () => {
    expect("discard" in buildCandidate(raw({ quote: "short" }), SRC, textSeg)).toBe(true);
    expect("discard" in buildCandidate(raw({ prompt: "Why?" }), SRC, textSeg)).toBe(true);
    expect("discard" in buildCandidate(raw({ answer: "  " }), SRC, textSeg)).toBe(true);
    expect("discard" in buildCandidate({ prompt: "No other fields at all" }, SRC, textSeg)).toBe(true);
    expect("discard" in buildCandidate(raw({ card_type: "essay" }), SRC, textSeg)).toBe(true);
    expect("discard" in buildCandidate("nonsense", SRC, textSeg)).toBe(true);
  });

  it("builds multiple choice with the answer taken from the chosen index, and rejects a bad index or duplicate choices", () => {
    const good = buildCandidate(raw({ card_type: "multiple_choice", choices: ["A region", "An isolated location within a region", "A cable"], correct_choice_index: 1 }), SRC, textSeg);
    if (!("card" in good)) throw new Error(JSON.stringify(good));
    expect(good.card.answer).toBe("An isolated location within a region");
    expect(good.card.answerSpec).toEqual({ choices: ["A region", "An isolated location within a region", "A cable"], correctIndex: 1 });
    expect("discard" in buildCandidate(raw({ card_type: "multiple_choice", choices: ["x1", "y2"], correct_choice_index: 5 }), SRC, textSeg)).toBe(true);
    expect("discard" in buildCandidate(raw({ card_type: "multiple_choice", choices: ["Same", "same"], correct_choice_index: 0 }), SRC, textSeg)).toBe(true);
  });

  it("builds numeric and rejects non-numeric answers", () => {
    const num = buildCandidate(raw({ card_type: "numeric", prompt: "How many zones are there?", answer: "3", numeric_answer: "3", numeric_tolerance: "" }), SRC, textSeg);
    if (!("card" in num)) throw new Error(JSON.stringify(num));
    expect(num.card.answerSpec).toEqual({ value: 3, tolerance: 0 });
    expect("discard" in buildCandidate(raw({ card_type: "numeric", numeric_answer: "three" }), SRC, textSeg)).toBe(true);
    expect("discard" in buildCandidate(raw({ card_type: "numeric", numeric_answer: "" }), SRC, textSeg)).toBe(true);
  });

  it("builds short_answer with the answer first and de-duplicated alternatives", () => {
    const out = buildCandidate(raw({ card_type: "short_answer", answer: "Isolated location", accepted_answers: ["isolated location", "A separate location"] }), SRC, textSeg);
    if (!("card" in out)) throw new Error(JSON.stringify(out));
    expect(out.card.answerSpec).toEqual({ acceptedAnswers: ["Isolated location", "A separate location"] });
  });
});

describe("dropDuplicates", () => {
  it("drops repeats within the batch and against existing prompts, ignoring case and spacing", () => {
    const mk = (prompt: string) => {
      const out = buildCandidate(raw({ prompt }), SRC, textSeg);
      if (!("card" in out)) throw new Error("setup");
      return out;
    };
    const { kept, discards } = dropDuplicates(
      [mk("What is an availability zone?"), mk("what is  an AVAILABILITY zone?"), mk("What do zones have?"), mk("Already have this one?")],
      new Set(["already have this one?"]),
    );
    expect(kept.map((k) => k.card.prompt)).toEqual(["What is an availability zone?", "What do zones have?"]);
    expect(discards).toHaveLength(2);
  });
});
