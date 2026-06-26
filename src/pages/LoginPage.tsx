import { LockKeyhole } from "lucide-react";
import { FormEvent, useState } from "react";

interface LoginPageProps {
  onLogin: (password: string) => Promise<void>;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onLogin(password);
      setPassword("");
    } catch {
      setError("Login failed. Check the password and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-icon">
          <LockKeyhole size={28} aria-hidden="true" />
        </div>
        <h1>Private Projects</h1>
        <input type="email" name="username" autoComplete="username" value="you@example.com" readOnly hidden />
        <label className="field-label full">
          <span>Password</span>
          <input name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </label>
        <button type="submit" className="primary-button" disabled={busy || !password}>
          {busy ? "Signing in" : "Sign in"}
        </button>
        {error ? <p className="inline-message error">{error}</p> : null}
      </form>
    </main>
  );
}
