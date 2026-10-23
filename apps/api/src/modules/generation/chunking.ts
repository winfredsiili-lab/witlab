export const CHUNK_MAX_CHARS = 8_000;
export const SCOPE_MAX_CHARS = 40_000;

export function chunkText(text: string, maxChars = CHUNK_MAX_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length);
    if (end < text.length) {
      const window = text.slice(i, end);
      const lastBreak = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
      if (lastBreak > maxChars * 0.5) end = i + lastBreak + 1;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks.filter((c) => c.length > 0);
}
