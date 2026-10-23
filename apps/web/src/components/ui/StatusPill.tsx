import "./ui.css";

export function StatusPill({ tone, children }: { tone: "success" | "error" | "neutral"; children: string }) {
  return <span className={`wl-pill wl-pill--${tone}`}>{children}</span>;
}
