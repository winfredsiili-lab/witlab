import type { AvailableStudyMode } from "@witlab/contracts";
import "../progress/progress.css";

/**
 * Study modes. A mode is the kind of learning activity; it is separate from a card's type and from the review schedule.
 * Recall works without AI. Explain, Connections and Apply study written-answer cards and need an AI key on the server,
 * so they are disabled (with the reason) when none is configured. Hybrid runs the four in a fixed, visible order and also needs AI.
 */
const MODES = [
  { id: "recall", name: "Recall", purpose: "Retrieve terms, definitions and facts from memory.", needsAi: false, planned: false },
  { id: "explain", name: "Explain", purpose: "Put an idea in your own words. AI gives feedback.", needsAi: true, planned: false },
  { id: "connections", name: "Connections", purpose: "Explain how concepts relate and differ. AI gives feedback.", needsAi: true, planned: false },
  { id: "apply", name: "Apply", purpose: "Use a concept in a scenario. AI gives feedback.", needsAi: true, planned: false },
  { id: "hybrid", name: "Hybrid", purpose: "A fixed sequence: recall first, then explain, connect, apply. AI gives feedback on the written parts.", needsAi: true, planned: false },
] as const;

export const MODE_NAMES: Record<string, string> = { recall: "Recall", explain: "Explain", connections: "Connections", apply: "Apply", hybrid: "Hybrid" };

interface ModePickerProps {
  value: AvailableStudyMode;
  onChange: (mode: AvailableStudyMode) => void;
  /** Whether the server can judge written answers. */
  aiConfigured: boolean;
}

export function ModePicker({ value, onChange, aiConfigured }: ModePickerProps) {
  return (
    <fieldset className="mode-picker">
      <legend>Study mode</legend>
      {MODES.map((m) => {
        const disabled = m.planned || (m.needsAi && !aiConfigured);
        return (
          <label key={m.id} className={`choice${disabled ? " mode-picker__off" : ""}`}>
            <input
              type="radio"
              name="study-mode"
              value={m.id}
              checked={m.id === value}
              disabled={disabled}
              onChange={() => !m.planned && onChange(m.id as AvailableStudyMode)}
            />
            <span>
              <strong>{m.name}</strong> <span className="wl-muted">{m.purpose}</span>
              {m.planned && <span className="wl-hint"> Not available yet.</span>}
              {!m.planned && m.needsAi && !aiConfigured && <span className="wl-hint"> Needs an AI key on the server, and none is configured.</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
