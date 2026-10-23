import type { SubmitResult, Verdict } from "@witlab/contracts";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/StatusPill";

const VERDICT_LABEL: Record<Verdict, string> = {
  correct: "Correct",
  partial: "Partly correct",
  incorrect: "Incorrect",
  ambiguous: "Needs clarification",
  not_evaluated: "Not evaluated",
};

export function verdictTone(verdict: Verdict): "success" | "error" | "neutral" {
  return verdict === "correct" ? "success" : verdict === "incorrect" ? "error" : "neutral";
}

export function verdictLabel(verdict: Verdict): string {
  return VERDICT_LABEL[verdict];
}

interface FeedbackPanelProps {
  prompt: string;
  submitted: SubmitResult;
  hasNext: boolean;
  onContinue: () => void;
}

/** Shown after every answer, before the learner can continue. */
export function FeedbackPanel({ prompt, submitted, hasNext, onContinue }: FeedbackPanelProps) {
  const { result, nextReview } = submitted;
  return (
    <Card aria-live="polite" aria-label="Answer feedback">
      <p className="wl-muted">{prompt}</p>
      <div className="row">
        <StatusPill tone={verdictTone(result.verdict)}>{verdictLabel(result.verdict)}</StatusPill>
        {result.evalMethod === "self_assessed" && <span className="wl-muted">graded by you</span>}
        {result.evalMethod === "ai" && <span className="wl-muted">judged by AI against the source and the card's criteria; it can be wrong</span>}
      </div>
      <p data-testid="feedback" style={{ whiteSpace: "pre-line" }}>{result.feedback}</p>
      {(result.verdict !== "correct" || result.evalMethod === "ai") && (
        <p>
          <strong>{result.evalMethod === "ai" ? "Model answer:" : "Correct answer:"}</strong> <span data-testid="correct-answer">{result.correctAnswer}</span>
        </p>
      )}
      {result.explanation && (
        <p>
          <strong>Why:</strong> {result.explanation}
        </p>
      )}
      <p className="wl-muted" data-testid="next-review">
        {nextReview.reason}
      </p>
      <div>
        <Button onClick={onContinue} autoFocus>
          {hasNext ? "Next card" : "See summary"}
        </Button>
      </div>
    </Card>
  );
}
