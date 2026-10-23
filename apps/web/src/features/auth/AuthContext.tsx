import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthUser } from "@witlab/contracts";
import { api } from "../../services/api";
import { ApiRequestError, UNAUTHORIZED_EVENT } from "../../services/apiClient";

type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: AuthUser }
  | { status: "unreachable"; message: string };

interface AuthApi {
  state: AuthState;
  setUser: (user: AuthUser) => void;
  signOut: () => Promise<void>;
  /** Forget the signed-in user without calling the server (after account deletion or log out everywhere). */
  forget: () => void;
  retry: () => void;
}

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    api
      .session()
      .then((s) => live && setState({ status: "signed-in", user: s.user }))
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof ApiRequestError && err.status === 401) setState({ status: "signed-out" });
        else setState({ status: "unreachable", message: err instanceof Error ? err.message : "Could not reach the server." });
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    const onUnauthorized = () => setState((s) => (s.status === "signed-in" ? { status: "signed-out" } : s));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const setUser = useCallback((user: AuthUser) => setState({ status: "signed-in", user }), []);
  const forget = useCallback(() => setState({ status: "signed-out" }), []);
  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Even if the request failed, the person asked to leave: show the sign-in page. The server session simply expires.
      setState({ status: "signed-out" });
    }
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo(() => ({ state, setUser, signOut, forget, retry }), [state, setUser, signOut, forget, retry]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
