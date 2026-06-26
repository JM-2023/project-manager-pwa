import { useEffect, useState } from "react";

interface LoginPageProps {
  onLogin: (password: string) => Promise<void>;
}

const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "delete"] as const;

export function LoginPage({ onLogin }: LoginPageProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (password.length !== 4) return;
    let cancelled = false;
    async function submit() {
      setBusy(true);
      setError(false);
      try {
        await onLogin(password);
        if (!cancelled) setPassword("");
      } catch {
        if (!cancelled) {
          setError(true);
          window.setTimeout(() => setPassword(""), 220);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void submit();
    return () => {
      cancelled = true;
    };
  }, [onLogin, password]);

  function press(value: (typeof digits)[number]) {
    if (busy) return;
    setError(false);
    if (value === "clear") {
      setPassword("");
      return;
    }
    if (value === "delete") {
      setPassword((current) => current.slice(0, -1));
      return;
    }
    setPassword((current) => (current.length < 4 ? `${current}${value}` : current));
  }

  return (
    <main className="login-screen" aria-label="Password keypad">
      <input type="email" name="username" autoComplete="username" value="owner@project-manager.local" readOnly hidden />
      <input type="password" name="password" value={password} readOnly autoComplete="current-password" hidden />
      <section className="pin-pad" aria-label="Enter password">
        <div className={`pin-dots${error ? " error" : ""}`} aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className={index < password.length ? "filled" : ""} />
          ))}
        </div>
        <div className="keypad">
          {digits.map((digit) => (
            <button key={digit} type="button" onClick={() => press(digit)} disabled={busy} aria-label={digit}>
              {digit === "delete" ? "Del" : digit === "clear" ? "C" : digit}
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
