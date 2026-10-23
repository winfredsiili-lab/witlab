import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { CardListItem } from "@witlab/contracts";
import { EmptyState, ErrorMessage, Loading } from "../components/feedback/Feedback";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Select, TextInput } from "../components/ui/Field";
import { LibraryTabs } from "../features/cards/LibraryTabs";
import { useAsync } from "../hooks/useAsync";
import { api } from "../services/api";

function AnswerBlock({ card }: { card: CardListItem }) {
  const spec = card.answerSpec as { choices?: string[]; correctIndex?: number } | null;
  return (
    <div className="stack-sm">
      <p><strong>{card.cardType === "open_ended" ? "Model answer" : "Answer"}:</strong> {card.answer}</p>
      {spec?.choices && <p className="wl-muted">Choices: {spec.choices.map((c, i) => (i === spec.correctIndex ? `✔ ${c}` : c)).join(" · ")}</p>}
      {card.explanation && <p className="wl-muted">{card.explanation}</p>}
      {card.sourceRefs[0] && (
        <blockquote className="wl-muted" style={{ margin: 0 }}>
          “{card.sourceRefs[0].excerpt}” — {card.sourceRefs[0].sourceTitle}
        </blockquote>
      )}
    </div>
  );
}

/**
 * Read your approved cards without being tested. Nothing here is recorded: it does not change schedules, progress or history.
 */
export function BrowsePage() {
  const cards = useAsync(() => api.listCards("approved"), []);
  const [query, setQuery] = useState("");
  const [deckId, setDeckId] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [index, setIndex] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);

  const all = cards.data?.items ?? [];
  const decks = useMemo(() => {
    const m = new Map<string, string>();
    all.forEach((c) => c.decks.forEach((d) => m.set(d.id, d.title)));
    return [...m.entries()];
  }, [all]);
  const q = query.trim().toLowerCase();
  const shown = all.filter(
    (c) => (!deckId || c.decks.some((d) => d.id === deckId)) && (!q || `${c.prompt} ${c.answer} ${c.explanation ?? ""}`.toLowerCase().includes(q)),
  );
  const current = index !== null ? shown[index] : undefined;

  return (
    <div className="stack">
      <h1>Library</h1>
      <LibraryTabs />
      <p className="wl-muted">Read your approved cards without being tested. Nothing here is recorded: it does not affect your schedule or progress.</p>
      {cards.loading && <Loading />}
      {cards.error && <ErrorMessage>{cards.error}</ErrorMessage>}
      {cards.data && all.length === 0 && (
        <EmptyState title="No approved cards yet">
          <Link to="/sources/new">Make a deck</Link> or approve cards under “To review”.
        </EmptyState>
      )}
      {all.length > 0 && (
        <Card>
          <div className="row">
            <TextInput label="Search" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(null); }} />
            <Select label="Deck" value={deckId} onChange={(e) => { setDeckId(e.target.value); setIndex(null); }}>
              <option value="">All cards</option>
              {decks.map(([id, title]) => (
                <option key={id} value={id}>{title}</option>
              ))}
            </Select>
          </div>
          <div className="row">
            <Button disabled={shown.length === 0} onClick={() => { setIndex(0); setRevealed(false); }}>Read through {shown.length} card{shown.length === 1 ? "" : "s"}</Button>
            <Button variant="secondary" onClick={() => { setShowAll((v) => !v); setOpen(new Set()); }}>{showAll ? "Hide all answers" : "Show all answers"}</Button>
          </div>
        </Card>
      )}

      {current && (
        <Card data-testid="read-card">
          <p className="wl-muted">Card {index! + 1} of {shown.length}</p>
          <h2>{current.prompt}</h2>
          {revealed ? <AnswerBlock card={current} /> : <div><Button variant="secondary" onClick={() => setRevealed(true)}>Show answer</Button></div>}
          <div className="row">
            <Button variant="secondary" disabled={index === 0} onClick={() => { setIndex(index! - 1); setRevealed(false); }}>Previous</Button>
            <Button variant="secondary" disabled={index! >= shown.length - 1} onClick={() => { setIndex(index! + 1); setRevealed(false); }}>Next</Button>
            <Button variant="secondary" onClick={() => setIndex(null)}>Close</Button>
          </div>
        </Card>
      )}

      {all.length > 0 && shown.length === 0 && <EmptyState title="No cards match">Try a different search or deck.</EmptyState>}
      <ul className="list">
        {shown.map((c) => (
          <li key={c.id} className="list-item" data-testid="browse-card" style={{ display: "block" }}>
            <strong>{c.prompt}</strong>
            {(showAll || open.has(c.id)) ? (
              <AnswerBlock card={c} />
            ) : (
              <div><Button variant="secondary" onClick={() => setOpen(new Set(open).add(c.id))}>Show answer</Button></div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
