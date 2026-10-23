import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../features/auth/AuthContext";
import "./layout.css";

/** Application shell: primary navigation and the page outlet. More destinations arrive with their batches. */
export function AppLayout() {
  const { state, signOut } = useAuth();
  const { pathname } = useLocation();
  useEffect(() => {
    const names: Record<string, string> = { "/": "Home", "/library": "Library", "/review": "To review", "/browse": "Read through", "/progress": "Progress", "/settings": "Settings", "/sources/new": "Make a deck" };
    const section = names[pathname] ?? (pathname.startsWith("/study") ? "Studying" : pathname.startsWith("/decks") ? "Deck" : pathname.startsWith("/sources") ? "Source" : "WitLab");
    document.title = section === "WitLab" ? "WitLab" : `${section} · WitLab`;
  }, [pathname]);
  const user = state.status === "signed-in" ? state.user : null;
  return (
    <div className="wl-shell">
      <aside className="wl-sidebar">
        <div className="wl-brand">WitLab</div>
        <nav aria-label="Primary" className="wl-nav">
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/library">Library</NavLink>
          <NavLink to="/progress">Progress</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        {user && (
          <div className="wl-user">
            <span className="wl-muted" title={user.email}>{user.displayName ?? user.email}</span>
            <button type="button" className="wl-linkbutton" onClick={() => void signOut()}>Sign out</button>
          </div>
        )}
      </aside>
      <main className="wl-main">
        <div className="wl-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
