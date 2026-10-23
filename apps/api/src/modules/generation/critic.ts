export const CRITIC_JSON_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          clarity: { type: "number" },
          groundedness: { type: "number" },
          nonTriviality: { type: "number" },
          dropReason: { type: ["string", "null"] },
        },
        required: ["index", "clarity", "groundedness", "nonTriviality", "dropReason"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
} as const;

export function buildCriticPrompt(cards: { prompt: string; answer: string }[], passages: string[]): { system: string; user: string } {
  const system = "Score each card 0-1 on standalone clarity, groundedness in source, non-triviality. Set dropReason if below 0.75 on any. Return only JSON.";
  const user = cards.map((c, i) => `Card ${i}:\nQ: ${c.prompt}\nA: ${c.answer}\nSource: ${passages[i] ?? ""}`).join("\n\n");
  return { system, user };
}
