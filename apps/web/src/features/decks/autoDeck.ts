import { api } from "../../services/api";

/** Finds a deck with this exact title (case-insensitive) or creates it. Cards therefore never end up in no deck by accident. */
export async function ensureDeckByTitle(title: string, existing: Array<{ id: string; title: string }>): Promise<string> {
  const clean = title.trim().slice(0, 120) || "My cards";
  const found = existing.find((d) => d.title.trim().toLowerCase() === clean.toLowerCase());
  if (found) return found.id;
  const created = await api.createDeck({ title: clean });
  existing.push({ id: created.id, title: created.title });
  return created.id;
}
