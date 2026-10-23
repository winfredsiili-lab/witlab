import type { Clarification, SessionDetail, SubmitResponseInput, SubmitResult } from "@witlab/contracts";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ErrorMessage, Loading } from "../components/feedback/Feedback";
import { Button } from "../components/ui/Button";
import { MODE_NAMES } from "../features/study/ModePicker";
import { FeedbackPanel } from "../features/study/Feedback";
import { SessionSummary } from "../features/study/SessionSummary";
import { StudyCard } from "../features/study/StudyCard";
import { useAsync } from "../hooks/useAsync";
import { api } from "../services/api";
import { messageOf } from "../services/apiClient";

export function StudyPage() {
  const { sessionId = "" } = useParams();
  const loaded = useAsync(() => api.getSession(sessionId), [sessionId]);
  const me = useAsync(() => api.me(), []);
  const [override, setOverride] = useState<SessionDetail | null>(null);
  const [feedback, setFeedback] = useState<{ submitted: SubmitResult; prompt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const session = override ?? loaded.data;

  if (loaded.loading && !session) return <Loading />;
  if (!session) return <ErrorMessage>{loaded.error ?? "Session not found."}</ErrorMessage>;

  async function submit(answer: Omit<SubmitResponseInput, "cardId">): Promise<Clarification | void> {
    const current = session!.current;
    if (!current) return;
    const submitted = await api.submitAnswer(session!.id, { ...answer, cardId: current.cardId });
    if ("needsClarification" in submitted) return submitted;
    setOverride(submitted.session);
    setFeedback({ submitted, prompt: current.prompt });
  }

  async function endEarly() {
    setError(null);
    try {
      setOverride(await api.endSession(session!.id));
      setFeedback(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h1>Study{session.deckTitle ? `: ${session.deckTitle}` : ": review"}</h1>
          <p className="wl-muted">{MODE_NAMES[session.mode] ?? session.mode} mode &middot; {session.progress.answered} of {session.progress.total} answered</p>
        </div>
        {session.status === "active" && (
          <Button variant="secondary" onClick={() => void endEarly()}>
            End session
          </Button>
        )}
      </div>

      {error && <ErrorMessage>{error}</ErrorMessage>}

      {session.mode === "hybrid" && session.phases && session.status === "active" && (
        <nav aria-label="Hybrid sequence" data-testid="hybrid-phases">
          <p className="wl-muted">
            Hybrid follows a fixed order: retrieve it, explain it, relate it, then use it. Phases with no cards are skipped.
          </p>
          <ol className="row" style={{ listStyle: "none", padding: 0, flexWrap: "wrap" }}>
            {session.phases.map((p) => {
              const active = session.current?.phase === p.mode;
              return (
                <li key={p.mode} aria-current={active ? "step" : undefined} style={{ fontWeight: active ? 700 : 400 }}>
                  {active ? "▶ " : p.answered === p.total ? "✓ " : ""}
                  {MODE_NAMES[p.mode]} ({p.answered}/{p.total})
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      {feedback ? (
        <FeedbackPanel
          prompt={feedback.prompt}
          submitted={feedback.submitted}
          hasNext={session.current !== null}
          onContinue={() => setFeedback(null)}
        />
      ) : session.current ? (
        <StudyCard
          askConfidence={me.data?.preferences.askConfidence ?? true}
          key={session.current.cardId}
          item={session.current}
          position={session.progress.answered + 1}
          total={session.progress.total}
          onSubmit={submit}
        />
      ) : (
        <SessionSummary session={session} />
      )}

      {!session.current && !feedback && session.status === "active" && (
        <p className="wl-muted">
          Nothing left to answer. <Link to="/">Go home</Link>
        </p>
      )}
    </div>
  );
}
