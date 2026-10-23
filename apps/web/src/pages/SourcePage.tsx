import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { GENERATION_MAX_SCOPE_CHARS, type Card as CardData, type GenerateCardsResponse, type GenerationScope, type GenerationStyle } from "@witlab/contracts";
import { EmptyState, ErrorMessage, Loading } from "../components/feedback/Feedback";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Select, TextInput } from "../components/ui/Field";
import { StatusPill } from "../components/ui/StatusPill";
import { useAsync } from "../hooks/useAsync";
import { api } from "../services/api";
import { messageOf } from "../services/apiClient";

type ScopeMode = "all" | "section" | "range";

function Draft({ card, onChanged }: { card: CardData; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = card.sourceRefs[0];

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await (action === "approve" ? api.approveCard(card.id) : api.rejectCard(card.id));
      onChanged();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <li className="list-item" data-testid="draft">
      <div className="stack-sm" style={{ flex: 1, minWidth: "16rem" }}>
        <strong>{card.prompt}</strong>
        <span>Answer: {card.answer}</span>
        {card.explanation && <span className="wl-muted">{card.explanation}</span>}
        {ref && (
          <blockquote className="wl-muted" style={{ margin: 0 }}>
            “{ref.excerpt}”{ref.pageStart ? ` (page ${ref.pageStart})` : ""}
          </blockquote>
        )}
        {error && <ErrorMessage>{error}</ErrorMessage>}
      </div>
      <span className="row">
        <Button disabled={busy} onClick={() => void decide("approve")}>Approve</Button>
        <Button variant="danger" disabled={busy} onClick={() => void decide("reject")}>Reject</Button>
      </span>
    </li>
  );
}

export function SourcePage() {
  const { sourceId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const warnings = (location.state as { warnings?: string[] } | null)?.warnings ?? [];

  const source = useAsync(() => api.getSource(sourceId), [sourceId]);
  const sections = useAsync(() => api.sourceSections(sourceId), [sourceId]);
  const drafts = useAsync(() => api.listCards("draft"), [sourceId]);
  const jobs = useAsync(() => api.generations(sourceId), [sourceId]);

  const [mode, setMode] = useState<ScopeMode>("all");
  const [sectionId, setSectionId] = useState("");
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("1");
  const [maxCards, setMaxCards] = useState("6");
  const [style, setStyle] = useState<GenerationStyle>("recall");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<GenerateCardsResponse | null>(null);

  if (source.loading && !source.data) return <Loading />;
  if (source.error) return <ErrorMessage>{source.error}</ErrorMessage>;
  const s = source.data;
  if (!s) return null;

  const isPdf = s.sourceType === "pdf";
  const sectionItems = sections.data?.items ?? [];
  const myDrafts = (drafts.data?.items ?? []).filter((c) => c.sourceRefs.some((r) => r.sourceId === sourceId));

  function buildScope(): GenerationScope {
    if (mode === "section") return { type: "section", sectionId };
    if (mode === "range") {
      return isPdf
        ? { type: "pages", pageStart: Number(from), pageEnd: Number(to) }
        : { type: "chars", charStart: Number(from), charEnd: Number(to) };
    }
    return { type: "all" };
  }

  async function generate() {
    setError(null);
    setBusy(true);
    try {
      const result = await api.generateCards(sourceId, buildScope(), Number(maxCards), style);
      setLast(result);
      drafts.reload();
      jobs.reload();
    } catch (err) {
      setError(messageOf(err));
      jobs.reload();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${s!.title}"? Cards made from it are kept, with their quoted passages.`)) return;
    try {
      await api.deleteSource(sourceId);
      navigate("/library");
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <div className="stack">
      <p><Link to="/library">← Library</Link></p>
      <div className="row-between">
        <h1>{s.title}</h1>
        <Button variant="danger" onClick={() => void remove()}>Delete source</Button>
      </div>

      <Card>
        <div className="row">
          <StatusPill tone={s.status === "ready" ? "success" : s.status === "failed" ? "error" : "neutral"}>{s.status}</StatusPill>
          <span className="wl-muted">
            {isPdf ? `PDF${s.pageCount ? `, ${s.pageCount} pages` : ""}${s.originalFilename ? `, ${s.originalFilename}` : ""}` : "Pasted text"}
            {s.contentLength !== null ? `, ${s.contentLength.toLocaleString("en-US")} characters` : ""}
          </span>
        </div>
        {s.status === "failed" && <ErrorMessage>{s.errorMessage ?? "This source could not be imported."}</ErrorMessage>}
        {warnings.map((w) => (
          <p key={w} className="wl-muted" role="status">Note: {w}</p>
        ))}
      </Card>

      {s.status === "ready" && (
        <Card>
          <h2>Make cards from this source</h2>
          <div className="stack">
            <Select label="What to read" value={mode} onChange={(e) => setMode(e.target.value as ScopeMode)}>
              <option value="all">The whole source</option>
              {sectionItems.length > 0 && <option value="section">One section</option>}
              <option value="range">{isPdf ? "A page range" : "A character range"}</option>
            </Select>

            {mode === "section" && (
              <Select label="Section" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                <option value="">Choose a section…</option>
                {sectionItems.map((sec) => (
                  <option key={sec.id} value={sec.id}>
                    {"— ".repeat(sec.level - 1)}{sec.title}
                    {sec.pageStart ? ` (p. ${sec.pageStart}${sec.pageEnd !== sec.pageStart ? `–${sec.pageEnd}` : ""})` : ""} · {sec.textLength.toLocaleString("en-US")} chars
                    {sec.textLength > GENERATION_MAX_SCOPE_CHARS ? " · too long" : ""}
                  </option>
                ))}
              </Select>
            )}
            {mode === "range" && (
              <div className="row">
                <TextInput label={isPdf ? "From page" : "From character"} type="number" min={isPdf ? 1 : 0} value={from} onChange={(e) => setFrom(e.target.value)} />
                <TextInput label={isPdf ? "To page" : "To character (exclusive)"} type="number" min={1} value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            )}
            <Select label="Kind of cards" value={style} onChange={(e) => setStyle(e.target.value as GenerationStyle)}>
              <option value="recall">Recall: flashcards, multiple choice, short and numeric answers</option>
              <option value="explain">Explain: written answers in your own words (AI-judged)</option>
              <option value="connections">Connections: written answers about how ideas relate (AI-judged)</option>
              <option value="apply">Apply: written scenario questions (AI-judged)</option>
            </Select>
            <TextInput label="Most cards to make" type="number" min={1} max={12} value={maxCards} onChange={(e) => setMaxCards(e.target.value)} />
            <p className="wl-muted">
              One request reads up to {GENERATION_MAX_SCOPE_CHARS.toLocaleString("en-US")} characters. Generated cards are drafts: nothing is studied until you approve it.
            </p>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <div>
              <Button disabled={busy || (mode === "section" && !sectionId)} onClick={() => void generate()}>
                {busy ? "Generating…" : "Generate cards"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {last && (
        <Card>
          <h2>Last generation</h2>
          <p role="status">
            {last.job.draftsCreated} draft{last.job.draftsCreated === 1 ? "" : "s"} created from {last.job.candidatesReturned} suggestion
            {last.job.candidatesReturned === 1 ? "" : "s"}.
          </p>
          {last.job.discarded.length > 0 && (
            <details>
              <summary>{last.job.discarded.length} suggestion{last.job.discarded.length === 1 ? "" : "s"} dropped</summary>
              <ul>
                {last.job.discarded.map((d, i) => (
                  <li key={i}>{d.prompt ? `“${d.prompt}” — ` : ""}{d.reason}</li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      )}

      <Card>
        <h2>Drafts waiting for review</h2>
        {drafts.loading && !drafts.data && <Loading />}
        {myDrafts.length === 0 ? (
          <EmptyState title="No drafts">Generate cards above, then approve the ones you want.</EmptyState>
        ) : (
          <ul className="list">
            {myDrafts.map((c) => (
              <Draft key={c.id} card={c} onChanged={() => drafts.reload()} />
            ))}
          </ul>
        )}
        <p className="wl-muted">
          Approve one at a time here, or use the <Link to={`/review?sourceId=${sourceId}`}>review screen</Link> to edit, approve many at once and add them to a deck.
        </p>
      </Card>

      {jobs.data && jobs.data.items.length > 0 && (
        <Card>
          <h2>Generation history</h2>
          <ul className="list">
            {jobs.data.items.map((j) => (
              <li key={j.id} className="list-item">
                <span>{new Date(j.createdAt).toLocaleString()}</span>
                <span className="row">
                  <StatusPill tone={j.status === "succeeded" ? "success" : j.status === "failed" ? "error" : "neutral"}>{j.status}</StatusPill>
                  <span className="wl-muted">{j.status === "failed" ? j.errorMessage : `${j.draftsCreated} drafts`}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
