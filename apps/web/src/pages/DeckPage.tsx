import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { EmptyState, ErrorMessage, Loading } from "../components/feedback/Feedback";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Select } from "../components/ui/Field";
import { StatusPill } from "../components/ui/StatusPill";
import { CardForm } from "../features/cards/CardForm";
import type { AvailableStudyMode } from "@witlab/contracts";
import { ModePicker, MODE_NAMES } from "../features/study/ModePicker";
import { useAsync } from "../hooks/useAsync";
import { api } from "../services/api";
import { messageOf } from "../services/apiClient";

export function DeckPage() {
  const { deckId = "" } = useParams();
  const navigate = useNavigate();
  const deck = useAsync(() => api.getDeck(deckId), [deckId]);
  const [studyMode, setStudyMode] = useState<AvailableStudyMode>("recall");
  const overview = useAsync(() => api.overview(deckId, studyMode), [deckId, studyMode]);
  const me = useAsync(() => api.me(), []);
  const active = useAsync(() => api.activeSessions(deckId), [deckId]);
  const approved = useAsync(() => api.listCards("approved"), [deckId]);
  const [pick, setPick] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    deck.reload();
    overview.reload();
    approved.reload();
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      refresh();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function start() {
    setError(null);
    try {
      navigate(`/study/${(await api.startSession(deckId, studyMode)).id}`);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function removeDeck() {
    if (!window.confirm("Delete this deck? Its cards are kept in your Library.")) return;
    setError(null);
    try {
      await api.deleteDeck(deckId);
      navigate("/library");
    } catch (err) {
      setError(messageOf(err));
    }
  }

  if (deck.loading && !deck.data) return <Loading />;
  if (!deck.data) return <ErrorMessage>{deck.error ?? "Deck not found."}</ErrorMessage>;

  const inDeck = new Set(deck.data.cards.map((c) => c.id));
  const addable = approved.data?.items.filter((c) => !inDeck.has(c.id)) ?? [];
  const resumable = active.data?.items[0];

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <p>
            <Link to="/library">&larr; Library</Link>
          </p>
          <h1>{deck.data.title}</h1>
          {deck.data.description && <p className="wl-muted">{deck.data.description}</p>}
        </div>
        <Button variant="danger" onClick={() => void removeDeck()}>
          Delete deck
        </Button>
      </div>

      {error && <ErrorMessage>{error}</ErrorMessage>}

      <Card>
        <h2>Study</h2>
        {overview.data && (
          <p data-testid="deck-overview">
            {overview.data.dueCount} due &middot; {overview.data.newCount} new &middot; {overview.data.eligibleCount} studyable in {MODE_NAMES[studyMode]}
            {overview.data.nextDueAt && overview.data.dueCount === 0 && overview.data.newCount === 0
              ? ` · next review ${new Date(overview.data.nextDueAt).toLocaleString()}`
              : ""}
          </p>
        )}
        <details>
          <summary style={{ cursor: "pointer" }}>Study mode: <strong>{MODE_NAMES[studyMode]}</strong> (change)</summary>
          <ModePicker value={studyMode} onChange={setStudyMode} aiConfigured={me.data?.aiUsage.configured ?? false} />
        </details>
        <div className="row">
          <Button onClick={() => void start()} disabled={!overview.data || overview.data.dueCount + overview.data.newCount === 0}>
            Start studying
          </Button>
          {resumable && (
            <Link to={`/study/${resumable.id}`}>
              Resume session ({resumable.answered} of {resumable.total} answered)
            </Link>
          )}
        </div>
        <p className="wl-muted">{MODE_NAMES[studyMode]} mode: new cards and cards that are due. Recall studies every card type except written-answer cards; each written-answer card belongs to one of Explain, Connections or Apply.</p>
      </Card>

      <Card>
        <h2>Cards in this deck</h2>
        {deck.data.cards.length === 0 ? (
          <EmptyState title="This deck is empty">Add an existing card below, or create a new one.</EmptyState>
        ) : (
          <ul className="list">
            {deck.data.cards.map((card) => (
              <li key={card.id} className="list-item">
                <details>
                  <summary style={{ cursor: "pointer" }}>{card.prompt}</summary>
                  <p><strong>{card.cardType === "open_ended" ? "Model answer" : "Answer"}:</strong> {card.answer}</p>
                  {card.explanation && <p className="wl-muted">{card.explanation}</p>}
                  {card.sourceRefs[0] && <blockquote className="wl-muted" style={{ margin: 0 }}>“{card.sourceRefs[0].excerpt}”</blockquote>}
                </details>
                <span className="row">
                  {card.cardType === "open_ended" && <StatusPill tone="neutral">{`${MODE_NAMES[card.learningMode ?? "explain"]} (written)`}</StatusPill>}
                  <Button variant="secondary" onClick={() => void run(() => api.removeCardFromDeck(deckId, card.id))}>
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {addable.length > 0 && (
          <div className="row" style={{ alignItems: "end" }}>
            <Select label="Add an existing card" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a card&hellip;</option>
              {addable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.prompt.length > 70 ? `${c.prompt.slice(0, 70)}…` : c.prompt}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              disabled={!pick}
              onClick={() => {
                const id = pick;
                setPick("");
                void run(() => api.addCardToDeck(deckId, id));
              }}
            >
              Add to deck
            </Button>
          </div>
        )}

        <div>
          <Button variant="secondary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "Create a new card for this deck"}
          </Button>
        </div>
        {showForm && (
          <CardForm
            submitLabel="Create and add to deck"
            onCreated={async (card) => {
              await api.addCardToDeck(deckId, card.id);
              setShowForm(false);
              refresh();
            }}
          />
        )}
      </Card>
    </div>
  );
}
