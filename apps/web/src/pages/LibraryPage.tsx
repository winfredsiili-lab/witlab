import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { EmptyState, ErrorMessage, Loading } from "../components/feedback/Feedback";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { TextArea, TextInput } from "../components/ui/Field";
import { StatusPill } from "../components/ui/StatusPill";
import { LibraryTabs } from "../features/cards/LibraryTabs";
import { CardForm } from "../features/cards/CardForm";
import { CardRow } from "../features/cards/CardRow";
import { useAsync } from "../hooks/useAsync";
import { api } from "../services/api";
import { messageOf } from "../services/apiClient";

const TYPE_NAMES: Record<string, string> = {
  term_definition: "Term / definition",
  short_answer: "Short answer",
  multiple_choice: "Multiple choice",
  numeric: "Number",
  open_ended: "Written answer",
};

function NewDeck() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const deck = await api.createDeck({ title, description: description.trim() || null });
      navigate(`/decks/${deck.id}`);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <TextInput label="Deck title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
      <TextArea label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div>
        <Button type="submit" disabled={busy}>
          Create deck
        </Button>
      </div>
    </form>
  );
}

export function LibraryPage() {
  const decks = useAsync(() => api.listDecks(), []);
  const cards = useAsync(() => api.listCards(), []);
  const sources = useAsync(() => api.listSources(), []);
  const [showDeckForm, setShowDeckForm] = useState(false);
  const [showCardForm, setShowCardForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "approved" | "draft" | "rejected">("all");
  const all = cards.data?.items ?? [];
  const shown = filter === "all" ? all : all.filter((c) => c.status === filter);
  const orphans = all.filter((c) => c.status === "approved" && c.decks.length === 0);

  async function removeCard(id: string, prompt: string) {
    if (!window.confirm(`Delete this card?\n\n${prompt}\n\nIts study history is deleted with it.`)) return;
    setError(null);
    try {
      await api.deleteCard(id);
      cards.reload();
      decks.reload();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <div className="stack">
      <h1>Library</h1>
      <LibraryTabs />

      <Card>
        <div className="row-between">
          <h2>Decks</h2>
          <Button variant="secondary" onClick={() => setShowDeckForm((v) => !v)}>
            {showDeckForm ? "Cancel" : "New deck"}
          </Button>
        </div>
        {showDeckForm && <NewDeck />}
        {decks.loading && <Loading />}
        {decks.error && <ErrorMessage>{decks.error}</ErrorMessage>}
        {decks.data &&
          (decks.data.items.length === 0 ? (
            <EmptyState title="No decks yet">Create a deck, then add cards to it and start studying.</EmptyState>
          ) : (
            <ul className="list">
              {decks.data.items.map((deck) => (
                <li key={deck.id} className="list-item">
                  <Link to={`/decks/${deck.id}`}>{deck.title}</Link>
                  <span className="wl-muted">
                    {deck.cardCount} card{deck.cardCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </Card>

      <Card>
        <div className="row-between">
          <h2>Sources</h2>
          <Link to="/sources/new">Make a deck from a source</Link>
        </div>
        {sources.loading && <Loading />}
        {sources.error && <ErrorMessage>{sources.error}</ErrorMessage>}
        {sources.data &&
          (sources.data.items.length === 0 ? (
            <EmptyState title="No sources yet">Paste text or upload a PDF to make cards from it.</EmptyState>
          ) : (
            <ul className="list">
              {sources.data.items.map((source) => (
                <li key={source.id} className="list-item">
                  <Link to={`/sources/${source.id}`}>{source.title}</Link>
                  <span className="row">
                    <StatusPill tone={source.status === "ready" ? "success" : source.status === "failed" ? "error" : "neutral"}>
                      {source.status}
                    </StatusPill>
                    <span className="wl-muted">
                      {source.sourceType === "pdf" ? `PDF${source.pageCount ? `, ${source.pageCount} pages` : ""}` : "Text"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </Card>

      <Card>
        <div className="row-between">
          <h2>Cards</h2>
          {(cards.data?.items.filter((c) => c.status === "draft").length ?? 0) > 0 && (
            <Link to="/review">Review {cards.data!.items.filter((c) => c.status === "draft").length} draft(s)</Link>
          )}
          <Button variant="secondary" onClick={() => setShowCardForm((v) => !v)}>
            {showCardForm ? "Cancel" : "New card"}
          </Button>
        </div>
        {showCardForm && (
          <CardForm
            onCreated={() => {
              cards.reload();
              setShowCardForm(false);
            }}
          />
        )}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {cards.loading && <Loading />}
        {cards.error && <ErrorMessage>{cards.error}</ErrorMessage>}
        {cards.data && (
          <>
            <div className="row" role="group" aria-label="Filter cards">
              {([["all", "All"], ["approved", "Approved"], ["draft", "Drafts"], ["rejected", "Rejected"]] as const).map(([key, label]) => (
                <Button key={key} variant={filter === key ? "primary" : "secondary"} onClick={() => setFilter(key)}>
                  {label} ({key === "all" ? cards.data!.items.length : cards.data!.items.filter((c) => c.status === key).length})
                </Button>
              ))}
            </div>
            {orphans.length > 0 && (
              <p role="status" data-testid="orphan-notice">
                <strong>{orphans.length} approved card{orphans.length === 1 ? " is" : "s are"} not in any deck, so {orphans.length === 1 ? "it" : "they"} cannot be studied.</strong>{" "}
                Open a card below and use “Add to a deck”.
              </p>
            )}
            {shown.length === 0 ? (
              <EmptyState title="No cards here">{cards.data.items.length === 0 ? "Create a card, or make some from a source." : "No cards match this filter."}</EmptyState>
            ) : (
              <ul className="list">
                {shown.map((card) => (
                  <CardRow
                    key={card.id}
                    card={card}
                    deckChoices={decks.data?.items.map((d) => ({ id: d.id, title: d.title })) ?? []}
                    onChanged={() => {
                      cards.reload();
                      decks.reload();
                    }}
                    onDelete={() => void removeCard(card.id, card.prompt)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
