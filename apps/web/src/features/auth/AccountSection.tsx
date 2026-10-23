import { useState, type FormEvent } from "react";
import { ErrorMessage } from "../../components/feedback/Feedback";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { TextInput } from "../../components/ui/Field";
import { api } from "../../services/api";
import { messageOf } from "../../services/apiClient";
import { useAuth } from "./AuthContext";

/** Password, sign-out and account deletion. Shown on the Settings page. */
export function AccountSection({ email }: { email: string }) {
  const { signOut, forget } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delPassword, setDelPassword] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const [otherError, setOtherError] = useState<string | null>(null);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwDone(false);
    if (next !== repeat) {
      setPwError("The two new passwords do not match.");
      return;
    }
    setPwBusy(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setPwDone(true);
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (err) {
      setPwError(messageOf(err));
    } finally {
      setPwBusy(false);
    }
  }

  async function logoutEverywhere() {
    setOtherError(null);
    try {
      await api.logoutEverywhere();
      forget();
    } catch (err) {
      setOtherError(messageOf(err));
    }
  }

  async function deleteAccount(e: FormEvent) {
    e.preventDefault();
    setDelBusy(true);
    setDelError(null);
    try {
      await api.deleteAccount(delPassword);
      forget();
    } catch (err) {
      setDelError(messageOf(err));
      setDelBusy(false);
    }
  }

  return (
    <>
      <Card>
        <h2>Sign-in</h2>
        <p>Signed in as <strong>{email}</strong>.</p>
        <div className="row">
          <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
          <Button variant="secondary" onClick={() => void logoutEverywhere()}>Sign out everywhere</Button>
        </div>
        {otherError && <ErrorMessage>{otherError}</ErrorMessage>}
      </Card>

      <Card>
        <form className="stack" onSubmit={(e) => void changePassword(e)} aria-label="Change password">
          <h2>Change password</h2>
          <TextInput label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          <TextInput label="New password" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} hint="At least 10 characters. Your other devices are signed out when you change it." />
          <TextInput label="Repeat new password" type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          {pwError && <ErrorMessage>{pwError}</ErrorMessage>}
          <div className="row">
            <Button type="submit" disabled={pwBusy}>Change password</Button>
            {pwDone && <span role="status">Password changed. Other devices were signed out.</span>}
          </div>
        </form>
      </Card>

      <Card>
        <h2>Delete account</h2>
        <p>This permanently deletes your account and everything in it: sources, cards, decks, study history and progress. It cannot be undone.</p>
        {!confirmDelete ? (
          <div><Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete my account…</Button></div>
        ) : (
          <form className="stack" onSubmit={(e) => void deleteAccount(e)} aria-label="Confirm account deletion">
            <TextInput label="Enter your password to confirm" type="password" autoComplete="current-password" required value={delPassword} onChange={(e) => setDelPassword(e.target.value)} />
            {delError && <ErrorMessage>{delError}</ErrorMessage>}
            <div className="row">
              <Button type="submit" variant="danger" disabled={delBusy}>Permanently delete everything</Button>
              <Button type="button" variant="secondary" onClick={() => { setConfirmDelete(false); setDelPassword(""); setDelError(null); }}>Cancel</Button>
            </div>
          </form>
        )}
      </Card>
    </>
  );
}
