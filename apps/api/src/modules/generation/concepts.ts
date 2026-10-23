import type { ScopeSegment } from "./candidates.js";

export const CONCEPTS_JSON_SCHEMA = {
  type: "object",
  properties: {
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          concept: { type: "string" },
          passage: { type: "string" },
        },
        required: ["concept", "passage"],
        additionalProperties: false,
      },
    },
  },
  required: ["concepts"],
  additionalProperties: false,
} as const;

export function buildConceptsPrompt(segments: ScopeSegment[]): { system: string; user: string } {
  const system = "Extract the key concepts from the passage. For each concept, return the concept name and the exact supporting passage (a verbatim quote from the text). Return only JSON.";
  const user = segments.map((s) => s.text).join("\n\n---\n\n");
  return { system, user };
}
