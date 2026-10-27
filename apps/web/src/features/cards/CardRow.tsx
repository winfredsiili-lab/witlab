import type { CardListItem } from "@witlab/contracts";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ErrorMessage } from "../../components/feedback/Feedback";
import { Button } from "../../components/ui/Button";
import { StatusPill } from "../../components/ui/StatusPill";
import { api } from "../../services/api";
import { CardEditor } from "./CardEditor";
import { messageOf } from "../../services/apiClient";

const TYPE_NAMES: Record<string, string> = {
  term_definition: "Term / definition",
  short_answer: "Short answer",
  multiple_choice: "Multiple choice",
  numeric: "Number",
  open_ended: "Written answer",
};
const MODE_NAMES: Record<string, string> = { explain: "Explain", connections: "Connections", apply: "Apply" };

interface CardRowProps {
  card: CardListItem;
  /** Decks the learner could add this card to (the ones it is not already in). */
  deckChoices: Array<{ id: string; title: string }>;
  onChanged: () => void;
  onDelete: () => void;
}

/** One card in the Library: readable in full (open it), and, once approved, addable to a deck so it can be studied. */
export function CardRow({ card, deckChoices, onChanged, onDelete }: CardRowProps) {
  const [deckId, setDeckId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const spec = card.answerSpec as { choices?: string[]; correctIndex?: number; acceptedAnswers?: string[]; value?: number; tolerance?: number } | null;
  const criteria = (card.rubric as { criteria?: string[] } | null)?.criteria ?? [];
  const studyable = card.status === "approved" && card.decks.length > 0;
  const options = deckChoices.filter((d) => !card.decks.some((x) => x.id === d.id));

  async function add() {
    if (!deckId) return;
    setBusy(true);
    setError(null);
    try {
      await api.addCardToDeck(deckId, card.id);
      setDeckId("");
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="list-item" data-testid="library-card" style={{ display: "block" }}>
      <details>
        <summary style={{ cursor: "pointer" }}>
          <span>{card.prompt}</span>{" "}
          <StatusPill tone={card.status === "approved" ? "success" : card.status === "rejected" ? "error" : "neutral"}>{card.status}</StatusPill>{" "}
          {card.status === "approved" && !studyable && <StatusPill tone="error">not in a deck: cannot be studied</StatusPill>}
        </summary>
        {editing ? (
          <div style={{ marginTop: "var(--space-2)" }}>
            <CardEditor
              card={card}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                onChanged();
              }}
            />
          </div>
        ) : (
        <div className="stack-sm" style={{ marginTop: "var(--space-2)" }}>
          <p className="wl-muted">
            {TYPE_NAMES[card.cardType]}
            {card.learningMode ? ` · ${MODE_NAMES[card.learningMode]} mode` : ""}
            {card.origin === "manual" ? " · made by you" : " · made by AI"}
          </p>
          <p>
            <strong>{card.cardType === "open_ended" ? "Model answer" : "Answer"}:</strong> {card.answer}
          </p>
          {spec?.choices && (
            <p className="wl-muted">Choices: {spec.choices.map((c, i) => (i === spec.correctIndex ? `✔ ${c}` : c)).join(" · ")}</p>
          )}
          {spec?.acceptedAnswers && spec.acceptedAnswers.length > 1 && <p className="wl-muted">Also accepted: {spec.acceptedAnswers.slice(1).join(" · ")}</p>}
          {spec?.value !== undefined && <p className="wl-muted">Accepts {spec.value} ± {spec.tolerance ?? 0}</p>}
          {criteria.length > 0 && <p className="wl-muted">Criteria: {criteria.join(" · ")}</p>}
          {card.explanation && <p><strong>Why:</strong> {card.explanation}</p>}
          {card.sourceRefs.map((r, i) => (
            <blockquote key={i} className="wl-muted" style={{ margin: 0 }}>
              “{r.excerpt}”
              <br />
              {r.sourceId ? <Link to={`/sources/${r.sourceId}`}>{r.sourceTitle}</Link> : r.sourceTitle}
              {r.pageStart ? `, page ${r.pageStart}` : ""}
            </blockquote>
          ))}
          <p className="wl-muted">
            In decks:{" "}
            {card.decks.length === 0
              ? "none"
              : card.decks.map((d, i) => (
                  <span key={d.id}>
                    {i > 0 ? ", " : ""}
                    <Link to={`/decks/${d.id}`}>{d.title}</Link>
                  </span>
                ))}
          </p>
          {card.status === "approved" && (
            <div className="row">
              {options.length > 0 ? (
                <>
                  <select aria-label={`Add to deck: ${card.prompt}`} value={deckId} onChange={(e) => setDeckId(e.target.value)}>
                    <option value="">Add to a deck…</option>
                    {options.map((d) => (
                      <option key={d.id} value={d.id}>{d.title}</option>
                    ))}
                  </select>
                  <Button variant="secondary" disabled={!deckId || busy} onClick={() => void add()}>Add</Button>
                </>
              ) : (
                deckChoices.length === 0 && <span className="wl-muted">Create a deck above to study this card.</span>
              )}
              <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="danger" onClick={onDelete}>Delete</Button>
            </div>
          )}
          {card.status !== "approved" && (
            <div className="row">
              {card.status === "draft" && <Link to="/review">Review this draft</Link>}
              <Button variant="danger" onClick={onDelete}>Delete</Button>
            </div>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
        </div>
        )}
      </details>
    </li>
  );
}
