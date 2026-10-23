import { describe, expect, it } from "vitest";
import { detectTextSections } from "./textSections.js";

describe("detectTextSections", () => {
  it("returns nothing for short text without headings", () => {
    expect(detectTextSections("Just a short note.\nSecond line.")).toEqual([]);
  });

  it("turns markdown headings into sections with nested ranges", () => {
    const text = "# One\nalpha\n## One.A\nbeta\n# Two\ngamma\n";
    const sections = detectTextSections(text);
    expect(sections.map((s) => [s.title, s.level])).toEqual([["One", 1], ["One.A", 2], ["Two", 1]]);
    expect(text.slice(sections[0]!.charStart, sections[0]!.charEnd)).toBe("# One\nalpha\n## One.A\nbeta\n");
    expect(text.slice(sections[1]!.charStart, sections[1]!.charEnd)).toBe("## One.A\nbeta\n");
    expect(text.slice(sections[2]!.charStart, sections[2]!.charEnd)).toBe("# Two\ngamma\n");
  });

  it("ignores # lines inside code fences and hashtags without a space", () => {
    const text = "```\n# not a heading\n```\n#hashtag\n# Real\nbody";
    expect(detectTextSections(text).map((s) => s.title)).toEqual(["Real"]);
  });

  it("handles Windows line endings", () => {
    const text = "# A\r\nbody\r\n# B\r\nmore";
    const sections = detectTextSections(text);
    expect(sections.map((s) => s.title)).toEqual(["A", "B"]);
    expect(text.slice(sections[1]!.charStart)).toBe("# B\r\nmore");
  });

  it("splits long text without headings into parts that cover it exactly once, preferring paragraph breaks", () => {
    const paragraph = "word ".repeat(40).trim() + ".";
    const text = Array.from({ length: 30 }, () => paragraph).join("\n\n");
    const sections = detectTextSections(text, 1000);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.kind === "auto_part")).toBe(true);
    expect(sections[0]!.title).toBe(`Part 1 of ${sections.length}`);
    let cursor = 0;
    for (const s of sections) {
      expect(s.charStart).toBe(cursor);
      expect(s.charEnd - s.charStart).toBeLessThanOrEqual(1000);
      cursor = s.charEnd;
    }
    expect(cursor).toBe(text.length);
    // every part except the last ends right after a paragraph break
    for (const s of sections.slice(0, -1)) expect(text.slice(s.charEnd - 2, s.charEnd)).toBe("\n\n");
  });

  it("hard-cuts text with no break characters at all", () => {
    const text = "x".repeat(2500);
    const sections = detectTextSections(text, 1000);
    expect(sections.map((s) => s.charEnd - s.charStart)).toEqual([1000, 1000, 500]);
  });
});
