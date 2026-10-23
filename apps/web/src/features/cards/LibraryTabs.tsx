import { NavLink } from "react-router-dom";
import { useAsync } from "../../hooks/useAsync";
import { api } from "../../services/api";

/** Cards & decks, cards waiting for review, and read-through: three views of the same library. */
export function LibraryTabs() {
  const drafts = useAsync(() => api.listDrafts(), []);
  const n = drafts.data?.total ?? 0;
  return (
    <nav aria-label="Library views" className="wl-tabs">
      <NavLink to="/library" end>Cards &amp; decks</NavLink>
      <NavLink to="/review">To review{n > 0 ? ` (${n})` : ""}</NavLink>
      <NavLink to="/browse">Read through</NavLink>
    </nav>
  );
}
