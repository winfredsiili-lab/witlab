import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorMessage, Loading } from "../components/feedback/Feedback";
import { Card } from "../components/ui/Card";
import { Select } from "../components/ui/Field";
import { StateBar, StateTiles } from "../features/progress/StateSummary";
import "../features/progress/progress.css";
import { useAsync } from "../hooks/useAsync";
import { api } from "../services/api";

export function ProgressPage() {
  const [deckId, setDeckId] = useState("");
  const decks = useAsync(() => api.listDecks(), []);
  const progress = useAsync(() => api.progress(deckId || undefined), [deckId]);
  const p = progress.data;
  const e = p?.last30Days;
  const maxDay = Math.max(1, ...(p?.activity.map((d) => d.answered) ?? [1]));

  return (
    <div className="stack">
      <h1>Progress</h1>
      <p className="wl-muted">Everything here is counted from the answers you have given. Nothing is estimated.</p>

      <Select label="Show" value={deckId} onChange={(e2) => setDeckId(e2.target.value)}>
        <option value="">All decks</option>
        {decks.data?.items.map((d) => (
          <option key={d.id} value={d.id}>{d.title}</option>
        ))}
      </Select>

      {progress.loading && !p && <Loading />}
      {progress.error && <ErrorMessage>{progress.error}</ErrorMessage>}

      {p && p.totalCards === 0 && (
        <EmptyState title="No cards to show progress for">
          Progress covers approved cards that are in a deck. <Link to="/library">Open the Library</Link>
        </EmptyState>
      )}

      {p && p.totalCards > 0 && (
        <>
          <Card>
            <h2>Where your cards stand</h2>
            <p data-testid="progress-total">{p.totalCards} card{p.totalCards === 1 ? "" : "s"}, each in exactly one of these states.</p>
            <StateBar states={p.states} total={p.totalCards} />
            <StateTiles states={p.states} />
          </Card>

          <Card>
            <h2>Last 14 days</h2>
            {p.activity.every((d) => d.answered === 0) ? (
              <p className="wl-muted">No answers in the last 14 days.</p>
            ) : (
              <>
                <ul className="activity" aria-hidden="true">
                  {p.activity.map((d) => (
                    <li key={d.date} title={`${d.date}: ${d.answered} answered, ${d.correct} right`}>
                      <div className={`activity__bar${d.answered === 0 ? " activity__bar--none" : ""}`} style={{ height: `${(d.answered / maxDay) * 100}%` }} />
                    </li>
                  ))}
                </ul>
                <div className="activity__labels" aria-hidden="true">
                  <span>{p.activity[0]!.date}</span>
                  <span>{p.activity.at(-1)!.date}</span>
                </div>
                <details>
                  <summary>Show as a table</summary>
                  <div className="table-scroll">
                    <table>
                      <thead><tr><th>Date (UTC)</th><th>Answered</th><th>Right</th></tr></thead>
                      <tbody>
                        {p.activity.filter((d) => d.answered > 0).map((d) => (
                          <tr key={d.date}><td>{d.date}</td><td>{d.answered}</td><td>{d.correct}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </Card>

          <Card>
            <h2>Last 30 days: the evidence</h2>
            {e && e.answered === 0 ? (
              <p className="wl-muted">No answers yet, so there is no evidence to show.</p>
            ) : (
              e && (
                <div className="stack-sm" data-testid="evidence">
                  <p>
                    <strong>{e.answered}</strong> answer{e.answered === 1 ? "" : "s"} on <strong>{e.cardsPracticed}</strong> card{e.cardsPracticed === 1 ? "" : "s"}:{" "}
                    {e.correct} right, {e.partial} partly right, {e.incorrect} wrong.
                  </p>
                  <p className="wl-muted">
                    {e.selfAssessed} of these {e.selfAssessed === 1 ? "was" : "were"} graded by you (term/definition cards), {e.automatic} checked automatically, {e.aiEvaluated} judged by AI (written answers). Self-graded answers are weaker evidence, and AI judgements can be wrong.
                  </p>
                  {e.answered < 20 && <p className="wl-muted">That is a small sample. Treat it as a first look, not a measure of how well you know the material.</p>}
                </div>
              )
            )}
          </Card>

          {p.needsAttention.length > 0 && (
            <Card>
              <h2>Needs attention</h2>
              <p className="wl-muted">Cards whose latest answer was not fully right, most recent first.</p>
              <ul className="list">
                {p.needsAttention.map((n) => (
                  <li key={n.cardId} className="list-item">
                    <span>{n.prompt}</span>
                    <span className="wl-muted">
                      {n.lastVerdict === "partial" ? "partly right" : "wrong"}
                      {n.lapses > 0 ? ` · forgotten ${n.lapses} time${n.lapses === 1 ? "" : "s"}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {p.decks.length > 1 && (
            <Card>
              <h2>By deck</h2>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Deck</th><th>Cards</th><th>Not practised</th><th>Needs work</th><th>Learning</th><th>Holding up</th></tr></thead>
                  <tbody>
                    {p.decks.map((d) => (
                      <tr key={d.deckId}>
                        <td><Link to={`/decks/${d.deckId}`}>{d.title}</Link></td>
                        <td>{d.totalCards}</td><td>{d.states.never}</td><td>{d.states.struggling}</td><td>{d.states.learning}</td><td>{d.states.established}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <p className="wl-muted">
            Covers every approved card that is in a deck, including written-answer cards. Counts are of cards and answers; there is no overall score because one would not mean anything yet.
          </p>
        </>
      )}
    </div>
  );
}
