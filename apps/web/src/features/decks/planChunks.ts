import type { GenerationScope } from "@witlab/contracts";
import { GENERATION_MAX_SCOPE_CHARS } from "@witlab/contracts";

const TARGET = GENERATION_MAX_SCOPE_CHARS - 1500; // headroom below the server limit
export const MAX_CHUNKS = 4;

/** Picks up to `max` items spread evenly across the list, so a long source is sampled from start to end. */
function spread<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.floor((i * items.length) / max)]!);
}

/** Splits a long source into scopes that each fit one generation request. `pageLengths` is for PDFs. */
export function planChunks(contentLength: number, pageLengths: number[] | null): GenerationScope[] {
  if (contentLength <= GENERATION_MAX_SCOPE_CHARS) return [{ type: "all" }];
  if (pageLengths) {
    const ranges: GenerationScope[] = [];
    let start = 0;
    let size = 0;
    pageLengths.forEach((len, i) => {
      if (len > TARGET) return; // a single oversized page cannot be read in one request; skip it
      if (size + len > TARGET && size > 0) {
        ranges.push({ type: "pages", pageStart: start + 1, pageEnd: i });
        size = 0;
      }
      if (size === 0) start = i;
      size += len;
      if (i === pageLengths.length - 1 && size > 0) ranges.push({ type: "pages", pageStart: start + 1, pageEnd: i + 1 });
    });
    return spread(ranges, MAX_CHUNKS);
  }
  const windows: GenerationScope[] = [];
  for (let s = 0; s < contentLength; s += TARGET) windows.push({ type: "chars", charStart: s, charEnd: Math.min(s + TARGET, contentLength) });
  return spread(windows, MAX_CHUNKS);
}
