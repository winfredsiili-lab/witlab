import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Card as CardData } from "@witlab/contracts";
import { EmptyState, ErrorMessage, Loading } from "../components/feedback/Feedback";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Select } from "../components/ui/Field";
import { ensureDeckByTitle } from "../features/decks/autoDeck";
import { LibraryTabs } from "../features/cards/LibraryTabs";
import { CardEditor } from "../features/cards/CardEditor";
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

function DraftRow({ card, checked, onToggle, onSaved }: { card: CardData; checked: boolean; onToggle: () => void; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const ref = card.sourceRefs[0];
  const spec = card.answerSpec as { choices?: string[]; correctIndex?: number; value?: number; tolerance?: number } | null;

  return (
    <li className="list-item" data-testid="review-draft">
      <label className="row" style={{ flex: 1, minWidth: "16rem", alignItems: "flex-start" }}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Select: ${card.prompt}`} />
        <span className="stack-sm" style={{ flex: 1 }}>
          {editing ? null : <strong>{card.prompt}</strong>}
          {!editing && (
            <>
              <span>Answer: {card.answer}</span>
              {spec?.choices && (
                <span className="wl-muted">Choices: {spec.choices.map((c, i) => (i === spec.correctIndex ? `✔ ${c}` : c)).join(" · ")}</span>
              )}
              {spec?.value !== undefined && <span className="wl-muted">Accepts {spec.value} ± {spec.tolerance}</span>}
              {card.cardType === "open_ended" && (
                <span className="wl-muted">
                  Criteria: {((card.rubric as { criteria?: string[] } | null)?.criteria ?? []).join(" · ")}
                </span>
              )}
              {card.explanation && <span className="wl-muted">{card.explanation}</span>}
            </>
          )}
          <span className="wl-muted">
            {TYPE_NAMES[card.cardType]}{card.learningMode ? ` (${card.learningMode} mode)` : ""}
            {ref ? ` · from ${ref.sourceTitle}${ref.pageStart ? `, page ${ref.pageStart}` : ""}` : ""}
          </span>
          {ref && !editing && <blockquote className="wl-muted" style={{ margin: 0 }}>“{ref.excerpt}”</blockquote>}
        </span>
      </label>
      {editing && (
        <div style={{ flexBasis: "100%" }}>
          <CardEditor
            card={card}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onSaved();
            }}
          />
        </div>
      )}
      {!editing && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
    </li>
  );
}

export function ReviewPage() {
  const [params, setParams] = useSearchParams();
  const sourceId = params.get("sourceId") ?? "";
  const drafts = useAsync(() => api.listDrafts(sourceId || undefined), [sourceId]);
  const sources = useAsync(() => api.listSources(), []);
  const decks = useAsync(() => api.listDecks(), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deckId, setDeckId] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeNoDeck, setNoticeNoDeck] = useState(false);

  const items = drafts.data?.items ?? [];
  const chosen = items.filter((c) => selected.has(c.id)).map((c) => c.id);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run(action: "approve" | "reject") {
    if (action === "approve" && deckId === "" && !window.confirm("Approved cards that are not in a deck cannot be studied until you add them to one (from the Library). Approve anyway?")) return;
    setBusy(true);
    setNoticeNoDeck(false);
    setError(null);
    setNotice(null);
    try {
      if (action === "approve" && deckId === "auto") {
        // One deck per source, named after it (created if needed). Each group is approved all-or-nothing.
        const known = [...(decks.data?.items ?? [])];
        const groups = new Map<string, string[]>();
        for (const c of items.filter((x) => selected.has(x.id))) {
          const title = c.sourceRefs[0]?.sourceTitle ?? "My cards";
          groups.set(title, [...(groups.get(title) ?? []), c.id]);
        }
        const names: string[] = [];
        let count = 0;
        for (const [title, ids] of groups) {
          const id = await ensureDeckByTitle(title, known);
          const r = await api.bulkReview("approve", ids, id);
          count += r.cards.length;
          names.push(`“${known.find((d) => d.id === id)?.title ?? title}”`);
        }
        setNotice(`Approved ${count} card${count === 1 ? "" : "s"} and added to ${names.join(", ")}.`);
        decks.reload();
      } else {
        const result = await api.bulkReview(action, chosen, action === "approve" && deckId ? deckId : undefined);
        const deckTitle = decks.data?.items.find((d) => d.id === result.addedToDeckId)?.title;
        setNotice(
          action === "approve"
            ? `Approved ${result.cards.length} card${result.cards.length === 1 ? "" : "s"}${deckTitle ? ` and added to “${deckTitle}”` : ""}.`
            : `Rejected ${result.cards.length} card${result.cards.length === 1 ? "" : "s"}.`,
        );
        setNoticeNoDeck(action === "approve" && !result.addedToDeckId);
      }
      setSelected(new Set());
      drafts.reload();
    } catch (err) {
      setError(messageOf(err));
      drafts.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1>Review drafts</h1>
      <LibraryTabs />
      <p className="wl-muted">
        AI-generated cards wait here. Nothing is studied until you approve it. Check each card against the quoted passage.
      </p>

      <Card>
        <div className="row">
          <Select label="Show drafts from" value={sourceId} onChange={(e) => { setParams(e.target.value ? { sourceId: e.target.value } : {}); setSelected(new Set()); }}>
            <option value="">All sources</option>
            {sources.data?.items.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </Select>
          <Select label="Put approved cards in" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            <option value="auto">Automatic: a deck named after each source</option>
            {decks.data?.items.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
            <option value="">No deck (cannot be studied yet)</option>
          </Select>
        </div>
        <div className="row">
          <Button variant="secondary" disabled={items.length === 0} onClick={() => setSelected(new Set(chosen.length === items.length ? [] : items.map((c) => c.id)))}>
            {chosen.length === items.length && items.length > 0 ? "Clear selection" : "Select all"}
          </Button>
          <Button disabled={busy || chosen.length === 0} onClick={() => void run("approve")}>Approve selected ({chosen.length})</Button>
          <Button variant="danger" disabled={busy || chosen.length === 0} onClick={() => void run("reject")}>Reject selected ({chosen.length})</Button>
        </div>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {decks.data && decks.data.items.length === 0 && (
          <p className="wl-muted">You have no decks yet. <Link to="/library">Create a deck in the Library</Link> first, so approved cards can be studied.</p>
        )}
        {notice && (
          <p role="status">
            {notice}{" "}
            {deckId && !noticeNoDeck ? <Link to={`/decks/${deckId}`}>Open the deck</Link> : null}
            {noticeNoDeck ? <>They are not in a deck, so they cannot be studied yet. <Link to="/library">Add them to a deck in the Library</Link>.</> : null}
          </p>
        )}
      </Card>

      <Card>
        {drafts.loading && !drafts.data && <Loading />}
        {drafts.error && <ErrorMessage>{drafts.error}</ErrorMessage>}
        {drafts.data && items.length === 0 && (
          <EmptyState title="Nothing to review">Make cards from a source and they will appear here. <Link to="/sources/new">Make a deck</Link></EmptyState>
        )}
        {items.length > 0 && (
          <ul className="list">
            {items.map((c) => (
              <DraftRow key={c.id} card={c} checked={selected.has(c.id)} onToggle={() => toggle(c.id)} onSaved={() => drafts.reload()} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
