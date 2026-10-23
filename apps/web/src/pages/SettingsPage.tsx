import { useEffect, useState, type FormEvent } from "react";
import { ErrorMessage, Loading } from "../components/feedback/Feedback";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { TextInput } from "../components/ui/Field";
import { StatusPill } from "../components/ui/StatusPill";
import { useAsync } from "../hooks/useAsync";
import { AccountSection } from "../features/auth/AccountSection";
import { api } from "../services/api";
import { messageOf } from "../services/apiClient";

function SystemStatus() {
  const health = useAsync(() => api.health(), []);
  return (
    <Card aria-live="polite">
      <div className="row-between">
        <h2>System status</h2>
        <Button variant="secondary" onClick={health.reload} disabled={health.loading}>Check again</Button>
      </div>
      {health.loading && <Loading label="Checking…" />}
      {health.error && <><StatusPill tone="error">API unreachable</StatusPill><p>{health.error}</p></>}
      {health.data && (
        <p>
          API <StatusPill tone="success">running</StatusPill>{" "}
          Database{" "}
          {health.data.database.status === "ok" ? (
            <StatusPill tone="success">{`connected (${health.data.database.latencyMs} ms)`}</StatusPill>
          ) : (
            <StatusPill tone="error">not connected</StatusPill>
          )}
        </p>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const me = useAsync(() => api.me(), []);
  const [name, setName] = useState("");
  const [size, setSize] = useState("20");
  const [confidence, setConfidence] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (me.data) {
      setName(me.data.displayName ?? "");
      setSize(String(me.data.preferences.sessionSize));
      setConfidence(me.data.preferences.askConfidence);
    }
  }, [me.data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateMe({ displayName: name.trim() === "" ? null : name.trim(), sessionSize: Number(size), askConfidence: confidence });
      setSaved(true);
      me.reload();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (me.loading && !me.data) return <Loading />;
  if (me.error) return <ErrorMessage>{me.error}</ErrorMessage>;
  const ai = me.data?.aiUsage;

  return (
    <div className="stack">
      <h1>Settings</h1>
      <form className="stack" onSubmit={(e) => void save(e)}>
        <Card>
          <h2>Account</h2>
          <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} hint="Shown on your home screen." />
        </Card>
        <Card>
          <h2>Studying</h2>
          <TextInput
            label="Cards per session"
            type="number"
            min={5}
            max={50}
            value={size}
            onChange={(e) => setSize(e.target.value)}
            hint="How many cards a session holds (5 to 50). Due cards come first, then new ones."
          />
          <label className="choice">
            <input type="checkbox" checked={confidence} onChange={(e) => setConfidence(e.target.checked)} />
            <span>
              Ask how confident I am before each answer
              <span className="wl-hint"> It is recorded as extra information. It never changes whether an answer counts as right, or when a card returns.</span>
            </span>
          </label>
        </Card>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <div className="row">
          <Button type="submit" disabled={busy}>Save settings</Button>
          {saved && <span role="status">Saved.</span>}
        </div>
      </form>

      {me.data && <AccountSection email={me.data.email} />}

      <Card>
        <h2>Your data</h2>
        <p>Download everything you have in WitLab (sources, cards, decks, study history) as one file. It never includes your password.</p>
        <div><a className="wl-button wl-button--secondary" href="/api/me/export" download>Download my data</a></div>
      </Card>

      <Card>
        <h2>AI features</h2>
        {ai?.configured ? (
          <>
            <p data-testid="ai-usage">{ai.usedToday} of {ai.dailyLimit} generations used in the last 24 hours.</p>
            <p data-testid="ai-eval-usage">{ai.evaluationsUsedToday} of {ai.evaluationDailyLimit} AI-judged written answers used in the last 24 hours (failed attempts count).</p>
          </>
        ) : (
          <p>Not set up on this server (no AI key). Card generation and the Explain, Connections and Apply study modes need it; Recall and everything else work. See the README for how to enable it.</p>
        )}
      </Card>
      <SystemStatus />
    </div>
  );
}
