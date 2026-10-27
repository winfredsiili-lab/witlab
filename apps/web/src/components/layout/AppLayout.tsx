import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../features/auth/AuthContext";
import "./layout.css";

/** Application shell: primary navigation and the page outlet. */
export function AppLayout() {
  const { state, signOut } = useAuth();
  const { pathname } = useLocation();
  useEffect(() => {
    const names: Record<string, string> = { "/": "Home", "/library": "Library", "/review": "To review", "/browse": "Read through", "/progress": "Progress", "/settings": "Settings", "/sources/new": "Make a deck" };
    const section = names[pathname] ?? (pathname.startsWith("/study") ? "Studying" : pathname.startsWith("/decks") ? "Deck" : pathname.startsWith("/sources") ? "Source" : "WitLab");
    document.title = section === "WitLab" ? "WitLab" : `${section} · WitLab`;
  }, [pathname]);
  const user = state.status === "signed-in" ? state.user : null;
  const initial = (user?.displayName ?? user?.email ?? "?").charAt(0).toUpperCase();
  return (
    <div className="wl-shell">
      <aside className="wl-sidebar">
        <div className="wl-brand">
          <span className="wl-brand__tile" aria-hidden="true">W</span>
          <span>WitLab</span>
        </div>
        <nav aria-label="Primary" className="wl-nav">
          <NavLink to="/" end>
            <IconHome /> Home
          </NavLink>
          <NavLink to="/library">
            <IconLibrary /> Library
          </NavLink>
          <NavLink to="/progress">
            <IconProgress /> Progress
          </NavLink>
          <NavLink to="/settings">
            <IconSettings /> Settings
          </NavLink>
        </nav>
        {user && (
          <div className="wl-user">
            <span className="wl-user__avatar" aria-hidden="true">{initial}</span>
            <div>
              <span className="wl-muted" title={user.email}>{user.displayName ?? user.email}</span>
              <br />
              <button type="button" className="wl-linkbutton" onClick={() => void signOut()}>Sign out</button>
            </div>
          </div>
        )}
      </aside>
      <main className="wl-main">
        <div className="wl-content">
          <Outlet />
        </div>
      </main>
      <nav aria-label="Primary" className="wl-bottomnav">
        <NavLink to="/" end>
          <IconHome /><span className="wl-sr">Home</span>
        </NavLink>
        <NavLink to="/library">
          <IconLibrary /><span className="wl-sr">Library</span>
        </NavLink>
        <NavLink to="/progress">
          <IconProgress /><span className="wl-sr">Progress</span>
        </NavLink>
        <NavLink to="/settings">
          <IconSettings /><span className="wl-sr">Settings</span>
        </NavLink>
      </nav>
    </div>
  );
}

function IconHome() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}
function IconLibrary() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 4v16" />
    </svg>
  );
}
function IconProgress() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20V10M10 20V4M16 20v-6M22 20V8" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
