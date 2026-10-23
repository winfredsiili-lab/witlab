import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { ErrorMessage, Loading } from "../../components/feedback/Feedback";
import { Button } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/Field";
import { api } from "../../services/api";
import { messageOf } from "../../services/apiClient";
import { useAuth } from "./AuthContext";
import "./auth.css";

/** Wraps the app: shows the sign-in page's redirect when nobody is signed in. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { state, retry } = useAuth();
  const location = useLocation();
  if (state.status === "loading") return <div className="wl-auth-wait"><Loading label="Loading WitLab…" /></div>;
  if (state.status === "unreachable") {
    return (
      <div className="wl-auth-page">
        <div className="wl-auth-card">
          <h1>Can't reach WitLab</h1>
          <ErrorMessage>{state.message}</ErrorMessage>
          <Button onClick={retry}>Try again</Button>
        </div>
      </div>
    );
  }
  if (state.status === "signed-out") return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function useDestination(): string {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  // Only ever return to a path inside this app.
  return from && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/login") && !from.startsWith("/register") ? from : "/";
}

export function LoginPage() {
  const { state, setUser } = useAuth();
  const navigate = useNavigate();
  const destination = useDestination();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === "signed-in") return <Navigate to={destination} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.login({ email, password });
      setUser(s.user);
      navigate(destination, { replace: true });
    } catch (err) {
      setError(messageOf(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wl-auth-page">
      <form className="wl-auth-card" onSubmit={(e) => void submit(e)}>
        <div className="wl-brand">WitLab</div>
        <h1>Sign in</h1>
        <TextInput label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextInput label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
        <p className="wl-muted">New here? <Link to="/register" state={{ from: destination }}>Create an account</Link></p>
      </form>
    </div>
  );
}

export function RegisterPage() {
  const { state, setUser } = useAuth();
  const navigate = useNavigate();
  const destination = useDestination();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === "signed-in") return <Navigate to={destination} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const s = await api.register({ email, password, ...(name.trim() ? { displayName: name.trim() } : {}) });
      setUser(s.user);
      navigate(destination, { replace: true });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wl-auth-page">
      <form className="wl-auth-card" onSubmit={(e) => void submit(e)}>
        <div className="wl-brand">WitLab</div>
        <h1>Create your account</h1>
        <TextInput label="Name (optional)" autoComplete="name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextInput
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="At least 10 characters. A few random words make a strong, memorable password."
        />
        <TextInput label="Repeat password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
        <p className="wl-muted">Already have an account? <Link to="/login" state={{ from: destination }}>Sign in</Link></p>
      </form>
    </div>
  );
}
