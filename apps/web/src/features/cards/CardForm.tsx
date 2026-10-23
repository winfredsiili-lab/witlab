import type { Card } from "@witlab/contracts";
import { useState, type FormEvent } from "react";
import { ErrorMessage } from "../../components/feedback/Feedback";
import { Button } from "../../components/ui/Button";
import { Select, TextArea, TextInput } from "../../components/ui/Field";
import { api } from "../../services/api";
import { messageOf } from "../../services/apiClient";

type FormType = "term_definition" | "short_answer" | "multiple_choice" | "numeric" | "open_ended";
type WrittenMode = "explain" | "connections" | "apply";

const TYPE_LABELS: Record<FormType, string> = {
  term_definition: "Term / definition (you grade yourself)",
  short_answer: "Short answer (checked automatically)",
  multiple_choice: "Multiple choice",
  numeric: "Number (checked with a tolerance)",
  open_ended: "Written answer (judged by AI in Explain, Connections or Apply)",
};

interface CardFormProps {
  onCreated: (card: Card) => void | Promise<void>;
  submitLabel?: string;
}

/** Creates a manual card. Manual cards are approved immediately, so they can be added to decks and studied. */
export function CardForm({ onCreated, submitLabel = "Create card" }: CardFormProps) {
  const [cardType, setCardType] = useState<FormType>("term_definition");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [accepted, setAccepted] = useState("");
  const [choices, setChoices] = useState("");
  const [correct, setCorrect] = useState(0);
  const [value, setValue] = useState("");
  const [tolerance, setTolerance] = useState("0");
  const [explanation, setExplanation] = useState("");
  const [writtenMode, setWrittenMode] = useState<WrittenMode>("explain");
  const [criteria, setCriteria] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choiceList = choices
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);

  const criteriaList = criteria
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);

  function buildPayload(): Record<string, unknown> {
    const base: Record<string, unknown> = { cardType, prompt, explanation: explanation.trim() || null };
    switch (cardType) {
      case "term_definition":
        return { ...base, answer };
      case "short_answer": {
        const extra = accepted
          .split("\n")
          .map((a) => a.trim())
          .filter(Boolean);
        return { ...base, answer, ...(extra.length > 0 ? { answerSpec: { acceptedAnswers: extra } } : {}) };
      }
      case "multiple_choice":
        return {
          ...base,
          answer: choiceList[correct] ?? "",
          answerSpec: { choices: choiceList, correctIndex: correct },
        };
      case "numeric":
        return { ...base, answer: value.trim(), answerSpec: { value: Number(value), tolerance: Number(tolerance) } };
      case "open_ended":
        return { ...base, answer, learningMode: writtenMode, rubric: { criteria: criteriaList } };
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (cardType === "numeric" && (value.trim() === "" || !Number.isFinite(Number(value)) || !Number.isFinite(Number(tolerance)))) {
      setError("Enter the correct value and a tolerance as plain numbers.");
      return;
    }
    if (cardType === "open_ended" && criteriaList.length === 0) {
      setError("Add at least one criterion: something a good answer must include.");
      return;
    }
    setBusy(true);
    try {
      const card = await api.createCard(buildPayload());
      setPrompt("");
      setAnswer("");
      setAccepted("");
      setChoices("");
      setCorrect(0);
      setValue("");
      setTolerance("0");
      setExplanation("");
      setCriteria("");
      await onCreated(card);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <Select label="Card type" value={cardType} onChange={(e) => setCardType(e.target.value as FormType)}>
        {(Object.keys(TYPE_LABELS) as FormType[]).map((t) => (
          <option key={t} value={t}>
            {TYPE_LABELS[t]}
          </option>
        ))}
      </Select>

      <TextArea label="Question" value={prompt} onChange={(e) => setPrompt(e.target.value)} required maxLength={2000} />

      {cardType === "term_definition" && (
        <TextArea label="Answer" value={answer} onChange={(e) => setAnswer(e.target.value)} required maxLength={4000} />
      )}

      {cardType === "open_ended" && (
        <>
          <Select label="Study mode" value={writtenMode} onChange={(e) => setWrittenMode(e.target.value as WrittenMode)}>
            <option value="explain">Explain: put an idea in your own words</option>
            <option value="connections">Connections: how ideas relate or differ</option>
            <option value="apply">Apply: use an idea in a scenario</option>
          </Select>
          <TextArea label="Model answer" hint="What a good answer says. The AI compares answers with this and the criteria." value={answer} onChange={(e) => setAnswer(e.target.value)} required maxLength={4000} />
          <TextArea label="Criteria" hint="One per line: things a good answer must include or avoid (1 to 10)." value={criteria} onChange={(e) => setCriteria(e.target.value)} required />
        </>
      )}

      {cardType === "short_answer" && (
        <>
          <TextInput label="Correct answer" value={answer} onChange={(e) => setAnswer(e.target.value)} required maxLength={500} />
          <TextArea
            label="Other accepted answers (optional)"
            hint="One per line. Capitalisation and surrounding punctuation are ignored."
            value={accepted}
            onChange={(e) => setAccepted(e.target.value)}
          />
        </>
      )}

      {cardType === "multiple_choice" && (
        <>
          <TextArea
            label="Choices"
            hint="One per line, between 2 and 8."
            value={choices}
            onChange={(e) => {
              setChoices(e.target.value);
              setCorrect(0);
            }}
            required
          />
          <Select label="Correct choice" value={correct} onChange={(e) => setCorrect(Number(e.target.value))} disabled={choiceList.length < 2}>
            {choiceList.map((c, i) => (
              <option key={`${i}-${c}`} value={i}>
                {c}
              </option>
            ))}
          </Select>
        </>
      )}

      {cardType === "numeric" && (
        <div className="row">
          <TextInput label="Correct value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} required />
          <TextInput
            label="Tolerance"
            hint="Answers within this distance count as correct."
            inputMode="decimal"
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
            required
          />
        </div>
      )}

      <TextArea label="Explanation (optional)" hint="Shown with the feedback after answering." value={explanation} onChange={(e) => setExplanation(e.target.value)} />

      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
