import type { ReactNode } from "react";
import "../ui/ui.css";

export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p className="wl-error" role="alert">
      {children}
    </p>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="wl-muted" role="status">
      {label}
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="wl-empty">
      <strong>{title}</strong>
      {children && <p className="wl-muted">{children}</p>}
    </div>
  );
}
