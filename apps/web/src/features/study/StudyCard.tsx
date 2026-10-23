import type { Clarification, StudyItem, SubmitResponseInput } from "@witlab/contracts";
import { useState } from "react";
import { ErrorMessage } from "../../components/feedback/Feedback";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { TextArea, TextInput } from "../../components/ui/Field";
import { messageOf } from "../../services/apiClient";

type Answer = Omit<SubmitResponseInput, "cardId">;

interface StudyCardProps {
  item: StudyItem;
  position: number;
  total: number;
  /** Resolves with a clarification request when the AI could not judge the answer (nothing was recorded), otherwise nothing. */
  onSubmit: (answer: Answer) => Promise<Clarification | void>;
  /** The learner can turn the optional confidence rating off in Settings. */
  askConfidence?: boolean;
}

/**
 * One card being answered. The confidence rating is asked before any feedback is shown, and is only
 * recorded as evidence: it never decides whether the answer is correct.
 */
export function StudyCard({ item, position, total, onSubmit, askConfidence = true }: StudyCardProps) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);

  async function send(answer: Answer) {
    setBusy(true);
    setError(null);
    setClarification(null);
    try {
      const outcome = await onSubmit({ ...answer, ...(confidence !== null ? { confidence } : {}) });
      if (outcome && outcome.needsClarification) {
        // Nothing was recorded. Keep what the learner wrote so they can add to it.
        setClarification(outcome.feedback);
        setBusy(false);
      }
    } catch (err) {
      // The typed answer stays in the box so a retry does not lose it.
      setError(messageOf(err));
      setBusy(false);
    }
    // On success the parent replaces this card, so there is nothing to reset.
  }

  return (
    <Card aria-label={`Card ${position} of ${total}`}>
      <div className="row-between">
        <span className="wl-muted">
          Card {position} of {total}
        </span>
        <span className="wl-muted" title="Why this card is here">
          {item.reason}
        </span>
      </div>

      <p className="prompt" data-testid="prompt">
        {item.prompt}
      </p>

      {item.cardType === "multiple_choice" && item.choices && (
        <fieldset className="stack-sm" style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="wl-muted">Choose one answer</legend>
          {item.choices.map((choice, index) => (
            <label key={`${index}-${choice}`} className="choice">
              <input type="radio" name="choice" checked={selected === index} onChange={() => setSelected(index)} />
              <span>{choice}</span>
            </label>
          ))}
        </fieldset>
      )}

      {(item.cardType === "short_answer" || item.cardType === "numeric") && (
        <TextInput
          label={item.cardType === "numeric" ? "Your answer (a number)" : "Your answer"}
          inputMode={item.cardType === "numeric" ? "decimal" : "text"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
          autoComplete="off"
        />
      )}

      {item.evaluation === "ai" && (
        <TextArea
          label="Your answer"
          hint="Write it in your own words. An AI judges it against the source and the card's criteria."
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          maxLength={4000}
          disabled={busy}
          autoFocus
        />
      )}

      {item.evaluation === "self" && !revealed && (
        <TextArea label="Your answer (optional: it is just for you)" value={text} onChange={(e) => setText(e.target.value)} />
      )}

      {!revealed && askConfidence && (
        <fieldset className="row" style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="wl-muted">How confident are you? (optional)</legend>
          {[1, 2, 3, 4, 5].map((level) => (
            <label key={level} className="row" style={{ gap: "var(--space-1)" }}>
              <input type="radio" name="confidence" checked={confidence === level} onChange={() => setConfidence(level)} />
              {level}
            </label>
          ))}
          <span className="wl-hint">1 = guessing, 5 = certain</span>
        </fieldset>
      )}

      {item.evaluation === "self" && revealed && (
        <div className="stack-sm">
          <p className="wl-muted">Model answer</p>
          <p className="prompt" data-testid="model-answer">
            {item.revealAnswer}
          </p>
          <p className="wl-muted">How did you do?</p>
          <div className="row">
            <Button disabled={busy} onClick={() => void send({ answer: text, selfGrade: "correct" })}>
              I got it right
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void send({ answer: text, selfGrade: "partial" })}>
              Partly right
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void send({ answer: text, selfGrade: "incorrect" })}>
              I got it wrong
            </Button>
          </div>
        </div>
      )}

      {clarification && (
        <div role="status" className="stack-sm" data-testid="clarification">
          <p>
            <strong>The AI needs more to go on.</strong> Nothing was recorded.
          </p>
          <p style={{ whiteSpace: "pre-line" }}>{clarification}</p>
        </div>
      )}

      {error && <ErrorMessage>{error}</ErrorMessage>}

      {item.evaluation === "ai" && (
        <div className="row">
          <Button disabled={busy || text.trim() === ""} onClick={() => void send({ answer: text })}>
            {busy ? "Judging your answer…" : error ? "Try again" : "Submit for feedback"}
          </Button>
        </div>
      )}

      {item.evaluation === "self" && !revealed && (
        <div>
          <Button onClick={() => setRevealed(true)}>Show answer</Button>
        </div>
      )}

      {item.evaluation === "auto" && (
        <div className="row">
          <Button
            disabled={busy}
            onClick={() => void send(item.cardType === "multiple_choice" ? { selectedIndex: selected ?? undefined } : { answer: text })}
          >
            Check answer
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void send({})}
            title="Counts as incorrect and shows the answer, like any answer you could not recall"
          >
            I don&rsquo;t know
          </Button>
        </div>
      )}
    </Card>
  );
}
