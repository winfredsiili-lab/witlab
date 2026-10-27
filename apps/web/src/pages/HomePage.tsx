import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErrorMessage, Loading } from "../components/feedback/Feedback";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { StateBar } from "../features/progress/StateSummary";
import "../features/progress/progress.css";
import "./home.css";
import { useAsync } from "../hooks/useAsync";
import { api } from "../services/api";
import { messageOf } from "../services/apiClient";

function StartHere() {
  return (
    <Card className="home-start">
      <div className="home-card__kicker">First time here</div>
      <h2>Start here</h2>
      <ol className="steps">
        <li><strong><Link to="/sources/new">Make a deck</Link></strong>: paste text or upload a PDF with selectable text.</li>
        <li><strong>Make cards</strong>: pick the part to read and generate draft cards. They quote the passage they came from.</li>
        <li><strong><Link to="/review">Review the drafts</Link></strong>: edit, approve and put them in a deck. Nothing is studied until you approve it.</li>
        <li><strong>Study</strong> the deck, then come back when cards are due.</li>
      </ol>
      <p className="wl-muted">Prefer to write your own cards? Create a deck in the <Link to="/library">Library</Link> and add cards by hand.</p>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`home-stat home-stat--${tone}`}>
      <span className="home-stat__value">{value}</span>
      <span className="home-stat__label">{label}</span>
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const me = useAsync(() => api.me(), []);
  const sources = useAsync(() => api.listSources(), []);
  const decks = useAsync(() => api.listDecks(), []);
  const drafts = useAsync(() => api.listDrafts(), []);
  const overview = useAsync(() => api.overview(), []);
  const active = useAsync(() => api.activeSessions(), []);
  const progress = useAsync(() => api.progress(), []);
  const [error, setError] = useState<string | null>(null);

  const ready = [sources, decks, drafts, overview, active, progress].every((r) => !r.loading || r.data || r.error);
  const loadError = [sources, decks, drafts, overview, active, progress].find((r) => r.error)?.error;
  const isNew = (sources.data?.total ?? 0) === 0 && (decks.data?.total ?? 0) === 0;
  const due = overview.data?.dueCount ?? 0;
  const draftCount = drafts.data?.total ?? 0;
  const resume = active.data?.items[0];
  const name = me.data?.displayName;
  const deckCount = decks.data?.total ?? 0;
  const sourceCount = sources.data?.total ?? 0;

  async function startReview() {
    setError(null);
    try {
      navigate(`/study/${(await api.startSession()).id}`);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <div className="stack home">
      <section className="home-hero">
        <span className="home-eyebrow">WitLab · study dashboard</span>
        <h1 className="home-title">{name ? `Welcome back, ${name}` : "WitLab"}</h1>
        <p className="home-lede">
          Turn what you are learning into cards you can recall, and review them on a schedule.
        </p>
        <div className="home-actions">
          {!isNew && due > 0 && (
            <Button onClick={() => void startReview()}>Start review · {due}</Button>
          )}
          <Link className="wl-button wl-button--secondary" to="/sources/new">
            Make a deck
          </Link>
          {!isNew && draftCount > 0 && (
            <Link className="wl-button wl-button--secondary" to="/review">
              Review drafts · {draftCount}
            </Link>
          )}
          {!isNew && resume && (
            <Link className="wl-button wl-button--secondary" to={`/study/${resume.id}`}>
              Resume session
            </Link>
          )}
        </div>

        {!isNew && ready && (
          <div className="home-stats">
            <Stat label="Due now" value={due} tone="due" />
            <Stat label="Drafts" value={draftCount} tone="drafts" />
            <Stat label="Decks" value={deckCount} tone="decks" />
            <Stat label="Sources" value={sourceCount} tone="sources" />
          </div>
        )}
      </section>
      {!ready && <Loading />}
      {loadError && <ErrorMessage>{loadError}</ErrorMessage>}
      {error && <ErrorMessage>{error}</ErrorMessage>}

      {ready && isNew && <StartHere />}

      {ready && !isNew && (
        <div className="home-grid">
          {resume && (
            <Card data-testid="resume-card" className="home-card home-card--accent">
              <span className="home-card__kicker">Continue</span>
              <h2>Session in progress</h2>
              <p>
                You have a session in progress{resume.deckTitle ? ` in “${resume.deckTitle}”` : ""}: {" "}
                {resume.answered} of {resume.total} answered.
              </p>
              <div><Link to={`/study/${resume.id}`}>Resume session</Link></div>
            </Card>
          )}

          <Card className="home-card home-card--accent">
            <span className="home-card__kicker">Due for review</span>
            <div className="home-due-row">
              {due > 0 ? (
                <>
                  <span className="home-card__big" data-testid="due-count">{due}</span>
                  <span className="wl-muted">card{due === 1 ? "" : "s"} due</span>
                </>
              ) : (
                <span className="home-card__big">0</span>
              )}
            </div>
            {due > 0 ? (
              <>
                <p className="wl-muted">This starts a Recall review. To practise Explain, Connections or Apply, open a deck and choose the mode.</p>
                <div><Button onClick={() => void startReview()}>Start review</Button></div>
              </>
            ) : (
              <p className="wl-muted">
                Nothing is due right now.{" "}
                {overview.data?.nextDueAt ? `Your next review is ${new Date(overview.data.nextDueAt).toLocaleString()}.` : "Study a deck and the cards you practise will come back here when they are due."}
              </p>
            )}
          </Card>

          {draftCount > 0 && (
            <Card data-testid="drafts-card" className="home-card">
              <span className="home-card__kicker">Drafts</span>
              <h2>Waiting for review</h2>
              <p>{draftCount} generated card{draftCount === 1 ? "" : "s"} waiting for your review.</p>
              <Link to="/review">Review drafts</Link>
            </Card>
          )}

          <Card className="home-card">
            <span className="home-card__kicker">Decks</span>
            <h2>Your decks</h2>
            {(decks.data?.items.length ?? 0) === 0 ? (
              <p className="wl-muted">No decks yet. <Link to="/library">Create one</Link>{draftCount > 0 ? " or approve drafts into a new deck." : "."}</p>
            ) : (
              <>
                {decks.data!.items[0] && (
                  <div className="home-deck-spotlight">
                    <div className="stack-sm" style={{ flex: 1 }}>
                      <Link to={`/decks/${decks.data!.items[0].id}`} className="home-deck-spotlight__title">{decks.data!.items[0].title}</Link>
                      <span className="wl-muted">{decks.data!.items[0].cardCount} card{decks.data!.items[0].cardCount === 1 ? "" : "s"}</span>
                    </div>
                    <Link to={`/decks/${decks.data!.items[0].id}`}><Button variant="secondary">Study</Button></Link>
                  </div>
                )}
                <ul className="list">
                  {decks.data!.items.slice(1, 5).map((d) => (
                    <li key={d.id} className="list-item">
                      <Link to={`/decks/${d.id}`}>{d.title}</Link>
                      <span className="wl-muted">{d.cardCount} card{d.cardCount === 1 ? "" : "s"}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          {progress.data && progress.data.totalCards > 0 && (
            <Card className="home-card">
              <span className="home-card__kicker">Progress</span>
              <h2>Progress</h2>
              <StateBar states={progress.data.states} total={progress.data.totalCards} />
              <p className="wl-muted">
                {progress.data.states.established} holding up · {progress.data.states.learning} learning · {progress.data.states.struggling} need work · {progress.data.states.never} not practised.
              </p>
              <Link to="/progress">See the evidence</Link>
            </Card>
          )}

          <Card className="home-card">
            <span className="home-card__kicker">Sources</span>
            <h2>Sources</h2>
            <p className="wl-muted">{sources.data?.total ?? 0} source{(sources.data?.total ?? 0) === 1 ? "" : "s"}.</p>
            <Link to="/sources/new">Make a deck</Link>
          </Card>
        </div>
      )}
    </div>
  );
}
