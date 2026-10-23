import type { StateCounts } from "@witlab/contracts";
import "./progress.css";

export const STATE_INFO: { key: keyof StateCounts; name: string; definition: string }[] = [
  { key: "never", name: "Not practised", definition: "In a deck, but you have not answered it yet." },
  { key: "struggling", name: "Needs work", definition: "Your latest answer was partly right or wrong." },
  { key: "learning", name: "Learning", definition: "Your latest answer was right, but not yet 3 right reviews in a row with a gap of 14+ days." },
  { key: "established", name: "Holding up", definition: "Right on 3+ reviews in a row, and the next review is 14+ days away. Consistent so far, not proof you will remember it long-term." },
];

export function StateBar({ states, total }: { states: StateCounts; total: number }) {
  if (total === 0) return null;
  const label = STATE_INFO.map((s) => `${states[s.key]} ${s.name.toLowerCase()}`).join(", ");
  return (
    <div className="state-bar" role="img" aria-label={label}>
      {STATE_INFO.map((s) => (
        <span key={s.key} className={s.key} style={{ width: `${(states[s.key] / total) * 100}%` }} />
      ))}
    </div>
  );
}

export function StateTiles({ states }: { states: StateCounts }) {
  return (
    <ul className="state-grid">
      {STATE_INFO.map((s) => (
        <li key={s.key} className="state-tile" data-testid={`state-${s.key}`}>
          <div className="state-tile__n">{states[s.key]}</div>
          <div className="state-tile__name">{s.name}</div>
          <p className="state-tile__def">{s.definition}</p>
        </li>
      ))}
    </ul>
  );
}
