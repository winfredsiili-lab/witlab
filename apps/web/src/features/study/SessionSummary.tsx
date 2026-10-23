import type { SessionDetail } from "@witlab/contracts";
import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { ErrorMessage } from "../../components/feedback/Feedback";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/StatusPill";
import { api } from "../../services/api";
import { messageOf } from "../../services/apiClient";
import { verdictLabel, verdictTone } from "./Feedback";

export function SessionSummary({ session }: { session: SessionDetail }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { progress } = session;
  const unanswered = progress.total - progress.answered;

  async function again() {
    setError(null);
    try {
      const next = await api.startSession(session.deckId ?? undefined, session.mode);
      navigate(`/study/${next.id}`);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <Card>
      <h2>{session.status === "completed" ? "Session complete" : "Session ended"}</h2>
      <p data-testid="summary-counts">
        {progress.answered} of {progress.total} answered: {progress.correct} correct, {progress.partial} partly correct, {progress.incorrect}{" "}
        incorrect.
        {unanswered > 0 && ` ${unanswered} not answered.`}
      </p>
      {session.results.length > 0 && (
        <ul className="list">
          {session.results.map((r) => (
            <li key={r.cardId} className="list-item">
              <span>{r.prompt}</span>
              <StatusPill tone={verdictTone(r.verdict)}>{verdictLabel(r.verdict)}</StatusPill>
            </li>
          ))}
        </ul>
      )}
      <p className="wl-muted">Incorrect answers come back for review soon; correct ones return after longer gaps.</p>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="row">
        <Button onClick={() => void again()}>Study more</Button>
        {session.deckId ? <Link to={`/decks/${session.deckId}`}>Back to deck</Link> : <Link to="/">Home</Link>}
      </div>
    </Card>
  );
}
