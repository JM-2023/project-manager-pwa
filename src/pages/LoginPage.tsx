import { Delete, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";

interface LoginPageProps {
  onLogin: (password: string) => Promise<void>;
}

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "delete"] as const;
const PIN_LENGTH = 4;

export function LoginPage({ onLogin }: LoginPageProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (password.length !== PIN_LENGTH) return;
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
          window.setTimeout(() => setPassword(""), 420);
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

  function press(value: (typeof keys)[number]) {
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
    setPassword((current) => (current.length < PIN_LENGTH ? `${current}${value}` : current));
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key >= "0" && event.key <= "9") {
        press(event.key as (typeof keys)[number]);
      } else if (event.key === "Backspace") {
        press("delete");
      } else if (event.key === "Escape") {
        press("clear");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  return (
    <main className="login-screen" aria-label="Password keypad">
      <input type="email" name="username" autoComplete="username" value="owner@project-manager.local" readOnly hidden />
      <input type="password" name="password" value={password} readOnly autoComplete="current-password" hidden />
      <section className={`pin-pad${error ? " shake" : ""}`} aria-label="Enter passcode">
        <div className="pin-brand">
          <div className="pin-logo">
            <LockKeyhole size={26} aria-hidden="true" />
          </div>
          <h1>Welcome back</h1>
          <p>{error ? "Wrong passcode — try again" : "Enter your 4-digit passcode"}</p>
        </div>

        <div className={`pin-dots${error ? " error" : ""}`} aria-hidden="true">
          {Array.from({ length: PIN_LENGTH }).map((_, index) => (
            <span key={index} className={index < password.length ? "filled" : ""} />
          ))}
        </div>

        <div className="keypad">
          {keys.map((key) => {
            if (key === "clear") {
              return (
                <button key={key} type="button" className="keypad-action" onClick={() => press(key)} disabled={busy || !password} aria-label="Clear">
                  C
                </button>
              );
            }
            if (key === "delete") {
              return (
                <button key={key} type="button" className="keypad-action" onClick={() => press(key)} disabled={busy || !password} aria-label="Delete">
                  <Delete size={22} aria-hidden="true" />
                </button>
              );
            }
            return (
              <button key={key} type="button" onClick={() => press(key)} disabled={busy} aria-label={key}>
                {key}
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
