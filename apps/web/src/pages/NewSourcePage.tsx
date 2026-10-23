import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ErrorMessage } from "../components/feedback/Feedback";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Field, Select, TextArea, TextInput } from "../components/ui/Field";
import { ensureDeckByTitle } from "../features/decks/autoDeck";
import { planChunks } from "../features/decks/planChunks";
import { useAsync } from "../hooks/useAsync";
import type { GenerationStyle } from "@witlab/contracts";
import { api } from "../services/api";
import { messageOf } from "../services/apiClient";

const MAX_PDF_BYTES = 15 * 1024 * 1024;

export function NewSourcePage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<"text" | "pdf">("text");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedSource, setSavedSource] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const me = useAsync(() => api.me(), []);
  const aiReady = me.data?.aiUsage.configured ?? false;
  const [generate, setGenerate] = useState(true);
  const [deckTitle, setDeckTitle] = useState("");
  const [style, setStyle] = useState<GenerationStyle>("recall");
  const [count, setCount] = useState("10");
  const [skipReview, setSkipReview] = useState(false);
  const willGenerate = aiReady && generate;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    setSavedSource(null);
    let sourceId: string | null = null;
    try {
      let sourceTitle = title.trim();
      let warnings: unknown;
      let length = 0;
      let pdf = false;
      setProgress(kind === "pdf" ? "Reading the PDF…" : "Saving your source…");
      if (kind === "text") {
        const source = await api.createTextSource({ title, contentText: text });
        sourceId = source.id;
        sourceTitle = source.title;
        length = source.contentLength ?? text.length;
      } else {
        if (!file) throw new Error("Choose a PDF file first.");
        if (file.size > MAX_PDF_BYTES) throw new Error("That file is larger than 15 MB.");
        const result = await api.uploadPdf(file, title);
        sourceId = result.source.id;
        sourceTitle = result.source.title;
        length = result.source.contentLength ?? 0;
        pdf = true;
        warnings = result.warnings;
      }
      if (!willGenerate) {
        navigate(`/sources/${sourceId}`, { state: { warnings } });
        return;
      }
      setProgress("Writing cards from your source… this can take a little while.");
      // A deck is only created once cards exist, so a failed AI call leaves no empty deck behind.
      const pageLengths = pdf ? (await api.sourcePages(sourceId)).items.map((p) => p.charLength) : null;
      const scopes = planChunks(length, pageLengths);
      const perChunk = Math.max(1, Math.ceil(Number(count) / scopes.length));
      const made = { cards: [] as Awaited<ReturnType<typeof api.generateCards>>["cards"] };
      let lastError: unknown = null;
      for (const [i, scope] of scopes.entries()) {
        if (scopes.length > 1) setProgress(`Writing cards from your source… part ${i + 1} of ${scopes.length}.`);
        try {
          made.cards.push(...(await api.generateCards(sourceId, scope, perChunk, style)).cards);
        } catch (err) {
          lastError = err; // keep what the other parts produced
        }
      }
      if (made.cards.length === 0 && lastError) throw lastError;
      if (made.cards.length === 0) throw new Error("The AI did not find anything it could safely turn into cards. Try a longer or clearer source.");
      if (skipReview) {
        setProgress("Adding the cards to your deck…");
        const decks = (await api.listDecks()).items.map((d) => ({ id: d.id, title: d.title }));
        const deckId = await ensureDeckByTitle(deckTitle.trim() || sourceTitle, decks);
        await api.bulkReview("approve", made.cards.map((c) => c.id), deckId);
        navigate(`/decks/${deckId}`);
      } else {
        navigate(`/review?sourceId=${sourceId}`);
      }
    } catch (err) {
      setError(messageOf(err) + (sourceId ? " Your source was saved, so nothing is lost." : ""));
      if (sourceId) setSavedSource(sourceId);
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="stack">
      <h1>Make a deck</h1>
      <p className="wl-muted">Paste text or upload a PDF. WitLab can write the cards and put them in a deck for you.</p>
      <Card>
        <form className="stack" onSubmit={(e) => void submit(e)}>
          <div className="row">
            <label className="choice">
              <input type="radio" name="kind" checked={kind === "text"} onChange={() => setKind("text")} /> Paste text
            </label>
            <label className="choice">
              <input type="radio" name="kind" checked={kind === "pdf"} onChange={() => setKind("pdf")} /> Upload a PDF
            </label>
          </div>
          <TextInput
            label={kind === "pdf" ? "Title (optional, defaults to the file name)" : "Title"}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required={kind === "text"}
            maxLength={200}
          />
          {kind === "text" ? (
            <TextArea
              label="Text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              required
              maxLength={250000}
              hint="Lines starting with # become sections you can choose from."
            />
          ) : (
            <Field label="PDF file" hint="Up to 15 MB and 300 pages. It must contain selectable text: scanned pages are not read (no OCR yet).">
              {(id) => (
                <input id={id} type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              )}
            </Field>
          )}
          {aiReady ? (
            <fieldset className="stack-sm" style={{ border: "none", padding: 0, margin: 0 }}>
              <label className="choice">
                <input type="checkbox" checked={generate} onChange={(e) => setGenerate(e.target.checked)} /> Write cards from this source with AI
              </label>
              {generate && (
                <>
                  <TextInput label="Deck name (optional, defaults to the source title)" value={deckTitle} onChange={(e) => setDeckTitle(e.target.value)} maxLength={120} />
                  <div className="row">
                    <Select label="Kind of cards" value={style} onChange={(e) => setStyle(e.target.value as GenerationStyle)}>
                      <option value="recall">Recall: terms, facts, numbers, choices</option>
                      <option value="explain">Explain: in your own words</option>
                      <option value="connections">Connections: how ideas relate</option>
                      <option value="apply">Apply: use an idea in a scenario</option>
                    </Select>
                    <TextInput label="How many (up to)" type="number" min={1} max={12} value={count} onChange={(e) => setCount(e.target.value)} />
                  </div>
                  <label className="choice">
                    <input type="checkbox" checked={skipReview} onChange={(e) => setSkipReview(e.target.checked)} />
                    <span>
                      Skip review: add the cards straight to the deck
                      <span className="wl-hint"> Cards stay marked as AI-made. AI can get things wrong, so leaving this off lets you check each card against its quoted passage first (recommended).</span>
                    </span>
                  </label>
                </>
              )}
            </fieldset>
          ) : (
            <p className="wl-muted">AI is not set up on this server, so this only saves the source. You can still write cards by hand in the Library.</p>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
          {savedSource && <p><a href={`/sources/${savedSource}`}>Open the saved source</a></p>}
          {progress && <p role="status" className="wl-muted">{progress}</p>}
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? "Working…" : willGenerate ? (skipReview ? "Make my deck" : "Make cards to review") : "Add source"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
