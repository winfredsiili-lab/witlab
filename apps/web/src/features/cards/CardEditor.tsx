import type { Card, CardListItem } from "@witlab/contracts";
import { useState, type FormEvent } from "react";
import { ErrorMessage } from "../../components/feedback/Feedback";
import { Button } from "../../components/ui/Button";
import { Select, TextArea, TextInput } from "../../components/ui/Field";
import { api } from "../../services/api";
import { messageOf } from "../../services/apiClient";

type Editable = Pick<Card, "id" | "status" | "cardType" | "learningMode" | "prompt" | "answer" | "answerSpec" | "rubric" | "explanation">;
type WrittenMode = "explain" | "connections" | "apply";

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

interface Spec {
  choices?: string[];
  correctIndex?: number;
  acceptedAnswers?: string[];
  value?: number;
  tolerance?: number;
}

/**
 * Edits an existing card of ANY type. The card type is fixed (a different type is a different card); everything else can change.
 * Sends only what changed. The server re-checks the whole card, so an edit can never leave it invalid.
 */
export function CardEditor({ card, onSaved, onCancel }: { card: Editable | CardListItem; onSaved: (card: Card) => void | Promise<void>; onCancel: () => void }) {
  const spec = (card.answerSpec ?? {}) as Spec;
  const [prompt, setPrompt] = useState(card.prompt);
  const [answer, setAnswer] = useState(card.answer);
  const [explanation, setExplanation] = useState(card.explanation ?? "");
  // short answer: the stored list includes the main answer first; show only the extras
  const [accepted, setAccepted] = useState((spec.acceptedAnswers ?? []).filter((a) => a !== card.answer).join("\n"));
  const [choices, setChoices] = useState((spec.choices ?? []).join("\n"));
  const [correct, setCorrect] = useState(spec.correctIndex ?? 0);
  const [value, setValue] = useState(spec.value !== undefined ? String(spec.value) : "");
  const [tolerance, setTolerance] = useState(spec.tolerance !== undefined ? String(spec.tolerance) : "0");
  const [mode, setMode] = useState<WrittenMode>((card.learningMode as WrittenMode | null) ?? "explain");
  const [criteria, setCriteria] = useState(((card.rubric as { criteria?: string[] } | null)?.criteria ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choiceList = lines(choices);

  function buildPatch(): Record<string, unknown> | string {
    const patch: Record<string, unknown> = { prompt: prompt.trim(), explanation: explanation.trim() === "" ? null : explanation.trim() };
    switch (card.cardType) {
      case "term_definition":
        patch.answer = answer.trim();
        break;
      case "short_answer": {
        patch.answer = answer.trim();
        const extra = lines(accepted);
        patch.answerSpec = extra.length > 0 ? { acceptedAnswers: extra } : null;
        break;
      }
      case "multiple_choice": {
        if (choiceList.length < 2) return "Add at least two choices.";
        const safe = Math.min(correct, choiceList.length - 1);
        patch.answer = choiceList[safe];
        patch.answerSpec = { choices: choiceList, correctIndex: safe };
        break;
      }
      case "numeric": {
        if (value.trim() === "" || !Number.isFinite(Number(value)) || !Number.isFinite(Number(tolerance))) return "Enter the correct value and a tolerance as plain numbers.";
        patch.answer = value.trim();
        patch.answerSpec = { value: Number(value), tolerance: Number(tolerance) };
        break;
      }
      case "open_ended": {
        const list = lines(criteria);
        if (list.length === 0) return "Add at least one criterion: something a good answer must include.";
        patch.answer = answer.trim();
        patch.rubric = { criteria: list };
        patch.learningMode = mode;
        break;
      }
    }
    return patch;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const patch = buildPatch();
    if (typeof patch === "string") {
      setError(patch);
      return;
    }
    setBusy(true);
    try {
      const saved = await api.updateCard(card.id, patch);
      await onSaved(saved);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} aria-label="Edit card" data-testid="card-editor">
      {card.status === "approved" && (
        <p className="wl-notice">
          Changing the question, answer, choices or criteria makes a new version of this card. Your study history and its schedule are kept; earlier answers stay recorded against the earlier wording. An explanation-only change is not a new version.
        </p>
      )}
      <TextArea label="Question" value={prompt} onChange={(e) => setPrompt(e.target.value)} required maxLength={2000} rows={2} />

      {(card.cardType === "term_definition" || card.cardType === "open_ended") && (
        <TextArea label={card.cardType === "open_ended" ? "Model answer" : "Answer"} value={answer} onChange={(e) => setAnswer(e.target.value)} required maxLength={4000} rows={3} />
      )}

      {card.cardType === "open_ended" && (
        <>
          <Select label="Study mode" value={mode} onChange={(e) => setMode(e.target.value as WrittenMode)}>
            <option value="explain">Explain: put an idea in your own words</option>
            <option value="connections">Connections: how ideas relate or differ</option>
            <option value="apply">Apply: use an idea in a scenario</option>
          </Select>
          <TextArea label="Criteria" hint="One per line (1 to 10)." value={criteria} onChange={(e) => setCriteria(e.target.value)} required rows={4} />
        </>
      )}

      {card.cardType === "short_answer" && (
        <>
          <TextInput label="Correct answer" value={answer} onChange={(e) => setAnswer(e.target.value)} required maxLength={500} />
          <TextArea label="Other accepted answers (optional)" hint="One per line. Capitalisation and surrounding punctuation are ignored." value={accepted} onChange={(e) => setAccepted(e.target.value)} />
        </>
      )}

      {card.cardType === "multiple_choice" && (
        <>
          <TextArea label="Choices" hint="One per line, between 2 and 8." value={choices} onChange={(e) => setChoices(e.target.value)} required rows={5} />
          <Select label="Correct choice" value={Math.min(correct, Math.max(choiceList.length - 1, 0))} onChange={(e) => setCorrect(Number(e.target.value))} disabled={choiceList.length < 2}>
            {choiceList.map((c, i) => (
              <option key={`${i}-${c}`} value={i}>{c}</option>
            ))}
          </Select>
        </>
      )}

      {card.cardType === "numeric" && (
        <div className="row">
          <TextInput label="Correct value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} required />
          <TextInput label="Tolerance" hint="Answers within this distance count as correct." inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} required />
        </div>
      )}

      <TextArea label="Explanation (optional)" hint="Shown with the feedback after answering." value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={2} />

      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="row">
        <Button type="submit" disabled={busy || prompt.trim() === ""}>{busy ? "Saving…" : "Save changes"}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
