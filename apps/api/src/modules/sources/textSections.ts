import { GENERATION_MAX_SCOPE_CHARS } from "@witlab/contracts";

/**
 * Structure of pasted text. Nothing is guessed:
 *  - markdown headings (`# Title`) become sections;
 *  - otherwise, text longer than one generation can read is split into numbered parts at paragraph breaks
 *    so it can be studied piece by piece. Short text without headings has no sections (use "whole source").
 * Offsets are JavaScript string indexes into the stored text; `charEnd` is exclusive.
 */

export interface TextSection {
  kind: "heading" | "auto_part";
  title: string;
  level: number;
  charStart: number;
  charEnd: number;
}

const MAX_SECTIONS = 500;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

export function detectTextSections(text: string, maxPartChars = GENERATION_MAX_SCOPE_CHARS): TextSection[] {
  const headings = findHeadings(text);
  if (headings.length > 0) return headings;
  if (text.length <= maxPartChars) return [];
  return splitIntoParts(text, maxPartChars);
}

function findHeadings(text: string): TextSection[] {
  const found: { title: string; level: number; start: number }[] = [];
  let inFence = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (/^\s*(```|~~~)/.test(trimmed)) inFence = !inFence;
    else if (!inFence) {
      const m = HEADING.exec(trimmed);
      if (m && found.length < MAX_SECTIONS) {
        found.push({ title: m[2]!.trim().slice(0, 300), level: m[1]!.length, start: offset });
      }
    }
    offset += line.length + 1;
  }
  return found.map((h, i) => {
    const next = found.slice(i + 1).find((later) => later.level <= h.level);
    return {
      kind: "heading" as const,
      title: h.title,
      level: h.level,
      charStart: h.start,
      charEnd: Math.min(text.length, next ? next.start : text.length),
    };
  });
}

function splitIntoParts(text: string, maxChars: number): TextSection[] {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      end = bestBreak(text, start, end);
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges.map((r, i) => ({
    kind: "auto_part" as const,
    title: `Part ${i + 1} of ${ranges.length}`,
    level: 1,
    charStart: r.start,
    charEnd: r.end,
  }));
}

/** Prefer a paragraph break, then a line break, then a space, within the second half of the window. */
function bestBreak(text: string, start: number, hardEnd: number): number {
  const floor = start + Math.floor((hardEnd - start) / 2);
  for (const sep of ["\n\n", "\n", " "]) {
    const at = text.lastIndexOf(sep, hardEnd - sep.length);
    if (at >= floor) return at + sep.length;
  }
  return hardEnd;
}
